# RouteGuard v2 — encrypted POD and shipper review (Phase D1)

Offline-complete proof-of-delivery workflow: signed carrier package, AES-256-GCM
storage, deterministic non-binding advisory, signed shipper review, and
escrow release/dispute **transaction plans** (not submitted).

> **Phase D1 status: offline only.** **NETWORK_WRITES=0.** No HCS submit, no
> Mirror, no live AI provider, no freight release, no contract dispute call, no
> x402 payment, no live Phase D evidence. Phase B access and Phase C2 escrow
> live evidence are immutable and unchanged.

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

## 10. Phase D2 (prepared, not executed)

Guarded live plan (future):

1. Synthetic POD upload  
2. Real HCS `POD_SUBMITTED`  
3. Real HCS `POD_ADVISORY_ANCHORED`  
4. Signed shipper acceptance  
5. Real HCS `POD_REVIEW_ACTION`  
6. **No freight release until Phase E**

Do not create live Phase D evidence in D1.
