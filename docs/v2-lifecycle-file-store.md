# RouteGuard v2 — lifecycle file store (Phase A3b)

Operator and implementer reference for `src/v2/store/*`. Covers the persisted
format, the lock ownership model, the stale-lock policy, atomic replacement,
corruption behaviour, and the limits of local-file persistence.

> **Deployment scope.** The local file store is appropriate for the guarded
> testnet/demo deployment. A production multi-instance deployment should use a
> transactional database or an equivalent strongly consistent store. No database
> is introduced in this phase.

---

## 1. Storage schema

| Item | Value |
|---|---|
| Storage schema identifier | `routeguard-v2-lifecycle-store-1.0` |
| Storage schema version | `1` |
| Record schema identifier | `routeguard-lifecycle-1.0` |
| Integrity algorithm | `sha256` (canonical JSON) |
| Authoritative file | `<baseDir>/lifecycle-<tenderId>.json` |
| Lock file | `<baseDir>/lifecycle-<tenderId>.lock` |
| Temp file | `<baseDir>/.lifecycle-<tenderId>.<pid>.<lockToken>.<uuid>.tmp` |

The authoritative file holds one envelope:

```jsonc
{
  "storageSchema": "routeguard-v2-lifecycle-store-1.0",
  "storageSchemaVersion": 1,
  "tenderId": "...",
  "tenderVersion": 1,
  "recordVersion": 3,          // monotonic; mirrors record.recordVersion
  "createdAt": "...Z",
  "updatedAt": "...Z",
  "record": { /* full LifecycleRecord incl. trust snapshot + processedActions */ },
  "trustPolicy": { /* trust snapshot, must equal record.trust */ },
  "actions": [ /* processed-action index, tender-bound */ ],
  "integrity": {
    "algorithm": "sha256",
    "recordHash": "sha256:…",  // canonical hash of `record`
    "actionsHash": "sha256:…"  // canonical hash of the action index
  }
}
```

An unknown `storageSchema` or `storageSchemaVersion` is **never** accepted:
loading fails with `UNSUPPORTED_STORAGE_VERSION`. There is no forward-compatible
passthrough — unknown persisted fields are rejected.

`integrity` is tamper-**evidence** for accidental corruption and hand edits. It
is not a security signature; it carries no secret and does not authenticate a
writer.

## 2. Validation on load

`parsePersistedLifecycleEnvelope` performs, in order:

1. read bytes;
2. strict UTF-8 decode;
3. `JSON.parse` inside controlled error handling;
4. storage-schema gate;
5. complete envelope validation (strict key sets, every nested object);
6. complete lifecycle-record validation, including the trust snapshot,
   access receipt, settlement fields, history, and processed actions;
7. cross-field invariants;
8. integrity recomputation.

Any failure raises a typed error. Nothing is partially recovered, no field is
defaulted, and a corrupt record is never reset to `DRAFT`.

Cross-field invariants enforced on load include:

- envelope `tenderId` / `tenderVersion` / `recordVersion` / timestamps equal the
  record's;
- envelope trust snapshot equals `record.trust`, and the shipper key
  fingerprint recomputes from the shipper public key;
- every processed action belongs to the same tender and tender version, has no
  duplicate `actionId`, and matches its record entry exactly;
- `history.length === processedActions size` and
  `recordVersion === history.length + 1` (a transition can never exist without
  its action record, or vice versa);
- `createdAt <= updatedAt`; the last history entry matches the persisted state,
  timestamp, and `lastActionId`;
- state-specific metadata must exist (funding, activation receipt, closure
  proof, winner, lock, POD, review window, dispute, referee decision) and
  state-incompatible settlement metadata must be absent;
- `fundedAmountAtomic >= maximumFreightBudgetAtomic`;
- `winningAmountAtomic <= maximumFreightBudgetAtomic`;
- `lockedAmountAtomic === winningAmountAtomic` and
  `lockedAmountAtomic + excessRefundAtomic === maximumFreightBudgetAtomic`;
- a recorded referee resolution conserves the locked amount, matches its
  resolution kind, and names a referee in the persisted trusted registry;
- the recorded access receipt pins token `0.0.429274`, amount `1000` atomic,
  the configured treasury (`record.trust.accessTreasuryAccountId`), and the
  canonical tender-versioned resource
  `/api/v2/tenders/<tenderId>/v/<tenderVersion>/activate`.

Amounts are non-negative integer strings only (no signs, floats, or exponents);
timestamps are UTC ISO-8601; hashes are `sha256:<64 lowercase hex>`; account ids
are validated Hedera entity ids.

## 3. Lock ownership model

- One lock file **per tender**. There is no global lock, so unrelated tenders
  never block each other.
- Acquisition is an atomic exclusive create (`open(..., "wx")`). The winner
  writes metadata `{ v, pid, host, token, tenderId, acquiredAt }` and fsyncs it.
- The ownership `token` is a per-acquisition UUID. **Release verifies the token
  before unlinking**, so a process can never release another owner's lock.
- An in-process `KeyedMutex` also serializes overlapping async work per tender,
  but it is only an optimization — the file lock is the cross-process guarantee.

Defaults (`DEFAULT_FILE_LOCK_CONFIG`, overridable per store):

| Setting | Default |
|---|---|
| `acquireTimeoutMs` | `5000` (0 → single attempt, fail closed immediately) |
| `retryIntervalMs` | `20` |
| `staleAfterMs` | `60000` |

Waiting is always bounded: acquisition either succeeds, or fails with
`LOCK_BUSY` (no wait budget), `LOCK_TIMEOUT` (budget exhausted), or
`LOCK_CORRUPT`.

## 4. Stale-lock policy

A lock may be reclaimed **only** when all of the following hold:

1. its metadata parses and is complete;
2. its age exceeds `staleAfterMs`;
3. the contender atomically renames the lock aside to
   `<lock>.stale.<contenderToken>` — only one contender can win that rename;
4. re-reading the moved file confirms the **same ownership token** that was
   inspected. If a different lock was moved, the lock was replaced mid-flight
   and the operation fails closed with `LOCK_CORRUPT`, leaving the moved file
   for inspection.

Malformed, empty, or unreadable lock files are **never** deleted automatically.
They surface `LOCK_CORRUPT` and require operator recovery: confirm no writer is
alive, inspect the file, then remove it manually.

## 5. Atomic replacement

The whole compare-and-set sequence runs while the lock is held:

1. acquire lock → 2. read authoritative file → 3. validate fully →
4. compare expected `recordVersion` → 5. check action-id state →
6. validate the next record → 7. write a unique temp file with exclusive create
→ 8. fsync the temp file → 9. atomic rename over the authoritative path →
10. best-effort parent-directory fsync → 11. read back and re-validate →
12. release the lock.

Temp names include the process id, the lock ownership token, and a UUID, and are
created with `wx`, so no operation can overwrite another's temp file. Only the
temp file owned by the current operation is ever removed.

If the temp write or the replacement fails, the previous authoritative file is
untouched, the owned temp file is cleaned up, the lock is released, and the call
fails with `ATOMIC_WRITE_FAILED`.

## 6. Crash recovery

- `.tmp` files are never authoritative and are never promoted.
- Recovery never selects "the newest file by timestamp" — the authoritative path
  is the sole source of truth.
- `cleanupAbandonedLifecycleTempFiles(baseDir, { minimumAgeMs })` deterministically
  removes only files matching the temp-file convention that are older than
  `minimumAgeMs` (default 60s), and returns `{ removed, retained }`. It never
  touches `.json` records or `.lock` files.

## 7. Error categories

| Code | Meaning |
|---|---|
| `RECORD_NOT_FOUND` | No authoritative record for the tender |
| `VERSION_CONFLICT` | Expected `recordVersion` did not match |
| `LOCK_BUSY` | Live lock held by another writer, no wait budget |
| `LOCK_TIMEOUT` | Bounded acquisition window elapsed |
| `LOCK_CORRUPT` | Ambiguous/malformed lock — operator recovery required |
| `RECORD_CORRUPT` | Persisted state failed validation — operator recovery required |
| `UNSUPPORTED_STORAGE_VERSION` | Unknown storage/record schema |
| `ATOMIC_WRITE_FAILED` | Temp write or replacement failed; previous state preserved |
| `ACTION_ID_CONFLICT` | Action id reused with a different payload, or a committed action dropped |

Public messages carry the tender id and the failure reason only — never
filesystem paths, POD content, signatures, or key material. Safe diagnostics may
be attached as `internalDetail` / `cause`.

## 8. Operator recovery

`RECORD_CORRUPT`, `UNSUPPORTED_STORAGE_VERSION`, and `LOCK_CORRUPT` are
deliberately unrecoverable in-process:

1. take the affected tender out of service;
2. preserve the file (do **not** delete it — it is the only evidence);
3. reconstruct state from HCS evidence and the action index;
4. restore a validated record, or archive the tender for manual settlement.

Automatic deletion, silent repair, and reset-to-`DRAFT` are prohibited.

## 9. Windows compatibility assumptions

- `fs.renameSync` replaces an existing destination on Windows and POSIX alike;
  the temp file and the target always live in the same directory.
- Directory fsync is unsupported on Windows and is treated as best effort; file
  fsync failures are likewise non-fatal (the atomic rename remains the ordering
  guarantee).
- Rename can fail transiently on Windows when a file is open elsewhere (AV,
  indexer). That surfaces as `ATOMIC_WRITE_FAILED` with the previous record
  intact, and the caller may retry.
- Tender ids are restricted to `[a-zA-Z0-9._-]` (≤128 chars), which is safe for
  Windows path composition and blocks traversal.

## 10. Limitations of local-file persistence

- Correct only for writers sharing one filesystem with working `wx` create and
  rename semantics; it is **not** safe over NFS/SMB without additional
  guarantees.
- No cross-tender transactions and no global ordering.
- A hard crash between rename and directory flush can, on some filesystems,
  expose the prior record after reboot; the CAS version keeps this safe (a stale
  read fails the next write) but does not make the commit durable.
- Reads are lock-free and therefore see the last committed record; long-running
  read-modify-write callers must still supply the expected version.
- Throughput is bounded by per-tender lock serialization.
