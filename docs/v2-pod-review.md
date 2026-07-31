# RouteGuard v2 — encrypted POD and shipper review (Phase D1 / D2)

Proof-of-delivery workflow: signed carrier package, AES-256-GCM storage,
deterministic non-binding advisory, signed shipper review, and escrow
release/dispute **transaction plans** (never submitted).

> **Phase D1 (implementation) is offline.** **NETWORK_WRITES=0** for the D1
> checkpoint itself: no HCS submit, no Mirror, no live AI provider, no freight
> release, no contract dispute call, no x402 payment.
>
> **Phase D2 (§10) executed this workflow live on Hedera testnet** with
> **NETWORK_WRITES=4** — one dedicated HCS topic plus three anchored messages.
> No freight principal moved. Phase B access and Phase C2 escrow live evidence
> are immutable and unchanged.

## 1. Package structure

A POD package binds:

| Field | Role |
|---|---|
| `podId` / `podVersion` | Identity (resubmit increments version by exactly 1) |
| `tenderId` / `tenderVersion` | Lifecycle binding |
| `winningBidId` | Must match the locked winner |
| `escrowTenderKey` | Canonical bytes32 tender key |
| `carrierId` / `carrierAccountId` | Winning carrier only |
| `deliveryTimestamp` | Delivery event time |
| `recipientConfirmationPresent` | Structured flag (no real PII required) |
| `cargoConditionCode` / `exceptionCodes` | Structured codes only |
| `files[]` | Strict MIME/size policy |
| `carrierSignature` | Domain-separated ECDSA over canonical hashes |
| `submittedAt` / `actionId` | Idempotency |

Demo documents may include electronic delivery receipts, eCMR/ePOD PDFs,
recipient confirmation JSON, delivery images, cargo-condition evidence, and
exception documents — **synthetic business data only**.

## 2. Canonical hashing

- Per-file SHA-256 of plaintext bytes.
- Manifest entries sorted by `fileId` (never multipart/filesystem order).
- `manifestHash` = canonical hash of the sorted manifest.
- `packageContentHash` binds package fields + manifest hash + file digests.
- Carrier signs purpose `ROUTEGUARD_V2_POD_SUBMISSION` over those hashes and
  identity fields via existing Hiero ECDSA primitives.

## 3. Encryption and key protection

| Layer | Algorithm |
|---|---|
| Content | AES-256-GCM, unique 256-bit DEK + 12-byte IV per POD version |
| AAD | tenderId, tenderVersion, podId, podVersion, manifestHash |
| Key wrap | AES-256-GCM wrap under application master key (`PodKeyProtector`) |

Master key: `ROUTEGUARD_POD_MASTER_KEY_BASE64` (exactly 32 decoded bytes),
validated at the outer boundary only. Pure encrypt/wrap functions never read
the environment. Keys are never logged or committed.

Production should replace the demo protector with KMS/HSM wrapping and move
ciphertext to object storage; the `PodEncryptedStore` / `PodKeyProtector`
interfaces are the migration boundary.

## 4. Local encrypted demo storage

- Schema: `routeguard-v2-pod-store-1.0`
- Runtime path: `data/v2-pods/` (gitignored via `data/`)
- Exclusive create, atomic metadata writes, integrity hash on load
- Overwrite rejected; each POD version is immutable
- Corrupt envelope fails closed

## 5. Routes

| Method | Path | Role |
|---|---|---|
| POST | `/api/v2/tenders/:id/v/:ver/pods/:podId` | Carrier submit |
| POST | `.../pods/:podId/resubmit` | Versioned correction resubmit |
| POST | `.../pods/:podId/review/start` | Start review + advisory |
| GET | `.../pods/:podId/review` | **Shipper-privileged** decrypt view |
| POST | `.../pods/:podId/review` | ACCEPT / REQUEST_CORRECTION / REJECT_DISPUTE |

Public / Judge Mode routes must never call decrypt. Phase D1 demo composition
injects shipper authorization at the route boundary.

## 6. Advisory (non-binding)

`PodAssuranceAdviser` interface + **deterministic rules-based stub**
(`routeguard-deterministic-pod-assurance-v1`). Compatible with a future
model-backed implementation. It is **not** a live AI model in Phase D1.

- Binding is always `NON_BINDING_ADVISORY`.
- Recommendations: `ACCEPT` | `REQUEST_CORRECTION` | `MANUAL_REVIEW`.
- Cannot accept/reject POD, open disputes, sign referee decisions, or move funds.

## 7. Shipper review windows

| Window | Duration |
|---|---|
| Initial review | **48 hours** from review start |
| Correction | **24 hours** from REQUEST_CORRECTION |
| Post-resubmit review | **24 hours** from review restart |

Shipper signs purpose `ROUTEGUARD_V2_SHIPPER_POD_REVIEW` (Phase A crypto).

| Action | Effect |
|---|---|
| ACCEPT | → `POD_ACCEPTED`; builds `releaseFull` plan only |
| REQUEST_CORRECTION | → `POD_CORRECTION_REQUESTED`; 24h correction deadline |
| REJECT_DISPUTE | → `POD_DISPUTED`; builds `openDispute` plan only |

## 8. Escrow plan binding

Plans target the Phase C TypeScript builders and, for the live demo tender, may
bind:

- Contract `0.0.9861047`
- EVM `0x00000000000000000000000000000000009677b7`
- Locked amount `750000` atomic USDC

**Plans are never submitted in Phase D1.** `networkWrite` on the plan object is
a type marker; the service always returns `networkWrite: false` for execution.

## 9. HCS outbox (offline)

Built, validated, size-checked (`< 1024` UTF-8), **not submitted**:

- `POD_SUBMITTED`
- `POD_ADVISORY_ANCHORED`
- `POD_REVIEW_ACTION`
- `DISPUTE_OPENED`

No POD plaintext, PII, signatures, wrapped keys, IVs/tags, or free-text
narratives.

**HCS proves hashes and ordering, not physical delivery.** The shipper remains
the binding POD decision-maker unless a dispute goes to a human referee. AI has
no legal or financial authority. Production deployment requires legal review of
acceptance, deemed acceptance, dispute, and electronic-signature terms.

## 10. Phase D2 — executed live on Hedera testnet

Run ID `v2pod-20260731-4b203b9c`, runner `scripts/run-v2-pod-live.ts`
(`npm run demo:v2-pod-live`), evidence in `evidence/v2/pod/`.

Guards required before any write:

```
ROUTEGUARD_LIVE_V2_POD_CONFIRM=I_UNDERSTAND_TESTNET_HCS_WRITES
ROUTEGUARD_LIVE_V2_POD_MAX_WRITES=4
ENABLE_LIVE_HEDERA=true
```

The runner refuses on a wrong branch, a dirty tree, a wrong network, missing or
inconsistent Phase C2 escrow evidence, an escrow that is not `0.0.9861047` /
`ALLOCATED` / 750,000 locked, a missing or non-32-byte POD master key, missing
carrier or shipper signing configuration, an existing successful D2 run, use of
the immutable v1 topic `0.0.9794225`, or a projected write count above four.
`ROUTEGUARD_LIVE_V2_POD_DRY_PREFLIGHT=true` runs every guard, read-only query,
and local crypto/signature step and stops before the first write.

### Dedicated topic

| Field | Value |
|---|---|
| Topic ID | `0.0.9862010` |
| Memo | `RouteGuard v2 POD evidence` |
| Create tx | `0.0.9197513@1785534392.284127053` |
| v1 topic `0.0.9794225` | **not used** |

### Anchored messages (consensus order)

| Seq | Type | Transaction ID | Consensus |
|---|---|---|---|
| 1 | `POD_SUBMITTED` | `0.0.9197513@1785534396.504175067` | `1785534402.627198807` |
| 2 | `POD_ADVISORY_ANCHORED` | `0.0.9197513@1785534400.313437789` | `1785534407.116885660` |
| 3 | `POD_REVIEW_ACTION` (ACCEPT) | `0.0.9197513@1785534407.535669507` | `1785534411.170948313` |

Each message body is the canonical JSON of its envelope; Mirror Node bytes were
compared by SHA-256 and matched. Payload shapes are the **unchanged closed
Phase A schemas** — extra public-safe detail (manifest hash, engine id, finding
codes, review-action / authorization / release-plan hashes) is bound by the
anchored hashes and kept in evidence rather than widening an accepted schema.

### Proof and boundary

| Claim | Value |
|---|---|
| POD documents | 3 synthetic (ePOD PDF, recipient confirmation PDF, delivery metadata JSON) |
| Manifest hash | `sha256:169bf54cb487a7ae7248d5f726885e363aacfd29e9a6f140cadd6074102ef582` |
| Package content hash | `sha256:696f18c52dfd6ee78c966474b8b6bb6cf96016fd620c22517aa727cb66231697` |
| Ciphertext hash | `sha256:8cf571af5e3475f9e3672d552ddd6b9976a51b532df0b6678b5a43614eda7f68` |
| Carrier signature | real ECDSA secp256k1, verified before storage |
| Encryption | AES-256-GCM, unique DEK + IV, wrapped data key; plaintext removed |
| Adviser | `routeguard-deterministic-pod-assurance-v1`, `NON_BINDING_ADVISORY`, `ACCEPT` |
| Shipper acceptance | real signature, verified, `POD_UNDER_REVIEW → POD_ACCEPTED` |
| Review deadline | `2026-08-02T21:46:35.884Z` |
| Release plan hash | `sha256:0a722dd3043830e0d5a7beaef668699abe1c1e431e351d86e4df94d844dacf95` |
| `releaseFull` submitted | **No** — plan only |
| Escrow after run | `ALLOCATED`, **750,000 atomic USDC still locked** |

**The deterministic adviser is not a live AI model**, and nothing here proves a
physical delivery, a human recipient signature, or a freight payment.

Read-only escrow verification uses the free Mirror Node `contracts/call`
endpoint; the SDK `ContractCallQuery` path used during this run additionally
billed 7 Hedera query-payment `CRYPTOTRANSFER`s (HBAR node fees that move no
USDC and change no RouteGuard state) — recorded in
`evidence/v2/pod/contract-state-after.json`.

**Phase E1** is responsible for the real freight release and the
`ESCROW_RELEASED` / `TENDER_COMPLETED` anchors.
