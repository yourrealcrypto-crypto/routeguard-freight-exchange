# RouteGuard Operations Demo backend

## Safety and mode contract

The backend exposes one public workflow through three deliberately distinct modes:

1. **REPLAY** reads and validates the immutable completed v2 proof under
   `evidence/v2/`. It exposes the two x402 transactions, escrow registration / exact
   allowance / funding / allocation, HCS sequence 1–5, freight release, final
   `RELEASED` state, and zero locked balance. It never writes evidence or calls a
   network.
2. **SIMULATION** uses the same Operations Demo state machine, persistence,
   idempotency, expiry, API and SSE contract. It performs no SDK or HTTP egress and
   labels every transaction reference `sim:`. Canonical hashing and deterministic
   local evidence remain real; business data is synthetic.
3. **LIVE** is a server-signed Hedera testnet boundary. It is disabled by default and
   remains `DISABLED_DEMO_INFRASTRUCTURE_PENDING` until a dedicated reusable demo
   contract and one reusable run-separated HCS topic are deployed and configured.

The immutable proof contract `0.0.9861047`
(`0x00000000000000000000000000000000009677b7`) and proof topic `0.0.9862010`
are rejected by live-demo configuration and remain replay-only.

## API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/operations-demo/capabilities` | Deep public-safe readiness; may query Mirror only when LIVE is configured |
| `GET` | `/api/operations-demo/replay` | Validated immutable completed-proof replay |
| `POST` | `/api/operations-demo/sessions` | Create `REPLAY`, `SIMULATION`, or authorized `LIVE` session |
| `GET` | `/api/operations-demo/sessions/:sessionId` | Poll a public-safe session snapshot |
| `POST` | `/api/operations-demo/sessions/:sessionId/actions` | Apply one allow-listed, idempotent action |
| `GET` | `/api/operations-demo/sessions/:sessionId/events` | SSE progress stream with `Last-Event-ID` resume and heartbeat |

Session creation accepts only `mode` and optional logical `role`. LIVE additionally
requires the server-configured admin token as `Authorization: Bearer ...` (the
`x-routeguard-demo-admin` header exists for controlled non-browser tooling). The
token is hashed before comparison and is never returned or logged.

Actions use:

```json
{
  "action": "OPEN_TENDER",
  "actionId": "stable-client-action-id",
  "idempotencyKey": "stable-client-idempotency-key",
  "payload": {}
}
```

The request recursively rejects amount, token, payee, recipient, account, address,
contract, topic, network, allowance, settlement and signing-key overrides. Those
facts are server configuration, never browser input.

## Workflow and recovery

The successful transition chain is:

`CREATED → ACCESS_ACTIVATED → OFFER_ACCEPTED → ESCROW_FUNDED → WINNER_ALLOCATED → POD_SUBMITTED → ADVISORY_ANCHORED → POD_ACCEPTED → COMPLETED`.

Transitions are forward-only and `COMPLETED`, `EXPIRED`, and `ABORTED` are terminal.
Each session derives a unique tender id, tender key, POD id, shipper action id, and
session-scoped creation / allocation / release authorization hashes. An identical
action identity returns the original response; a changed payload under the same
identity fails. Exactly one action may be in flight for a session.

Every live sub-step uses the durable receipt journal:

1. persist the intended sub-step and binding hashes;
2. submit once;
3. after a `SUCCESS` receipt, immediately persist transaction id, receipt state,
   HCS sequence (when applicable), and write-budget increment;
4. verify through Mirror in a separate resumable commit;
5. on Mirror delay/failure, return `RECOVERABLE` and re-verify the persisted
   transaction after restart—never resubmit it.

Registration, allowance, funding, allocation, HCS messages and `releaseFull` use the
same rule. The extracted SDK services require a receipt-journal callback, ensuring
the receipt is durable before a caller may start Mirror verification.

Sessions idle-expire after 15 minutes and absolutely expire after 30 minutes.
Expiry releases the global live-session record and never initiates a refund. An
expired session at or beyond `ESCROW_FUNDED` is retained with
`DEMO_OPERATOR_RECOVERY_REQUIRED`; financial state is not deleted or abandoned.

## Fixed economics and writes

The public commercial quote (`1,850 USDC`) is illustrative off-chain synthetic
logistics data. It is never a transfer amount and is displayed separately from:

- maximum HTS USDC budget: **20,000 atomic / 0.020000 USDC**;
- winning freight amount: **15,000 atomic / 0.015000 USDC**;
- automatic excess refund: **5,000 atomic / 0.005000 USDC**;
- tender access fee: **1,000 atomic / 0.001000 USDC**;
- carrier-offer access fee: **1,000 atomic / 0.001000 USDC**;
- Hedera network and facilitator fees.

The minimal successful LIVE flow projects exactly 12 application writes: two x402
settlements; register, exact allowance and fund; allocate/refund excess; three POD
HCS anchors; `releaseFull`; and two completion HCS anchors. Optional
`TENDER_OPENED` / `BID_COMMITMENT` HCS messages cannot enter this path. The session
ceiling is 12 and the UTC daily ceiling is 50. The next submission is refused before
either ceiling is crossed. Child `CRYPTOTRANSFER` records, free Mirror HTTP reads,
and disclosed query-payment records are tracked separately and never inflate the
application-write count.

The logical operator/shipper/x402 payer is `0.0.9197513`. The logical winning
carrier and access treasury share controlled account `0.0.9215954`; public responses
must not imply all logical roles are separate accounts.

## Mirror, HCS and POD boundaries

The reusable Mirror reader aggregates a parent contract call and all child records
before reconciling HTS legs. This is required because HTS precompile transfers may
exist only on a child `CRYPTOTRANSFER`. Contract state uses the free Mirror
`POST /api/v1/contracts/call` endpoint, not paid `ContractCallQuery`.

The v2 HCS submitter accepts only validated `routeguard-hcs-2.0` canonical envelopes,
enforces UTF-8 size strictly below 1,024 bytes, pins the configured demo topic, and
journals receipt/sequence before separate Mirror verification. Multiple runs share
one later-created demo topic and remain separated by session/run id, tender identity,
tender hash and payload hash. No topic-per-session path exists.

The orchestrator owns the POD workflow directly rather than HTTP route-hopping.
Encrypted POD storage belongs on `/data/v2-pods`; plaintext, wrapped keys, master
keys, raw signatures and ciphertext bodies are excluded from public session data.
The adviser remains deterministic and explicitly `NON_BINDING_ADVISORY`.

## Railway and persistence

The supported production topology is exactly one Railway service, one replica, one
process and one persistent volume mounted at `/data`. Horizontal scaling or a second
process sharing the file/CAS directories is unsupported; introduce a transactional
database before multi-instance operation.

Required LIVE directories are:

```text
/data/v2/lifecycle
/data/v2/tenders
/data/v2/bids
/data/v2/payment-claims
/data/v2-pods
/data/demo-sessions
```

Set `ROUTEGUARD_V2_DATA_DIR=/data/v2` and
`ROUTEGUARD_DEMO_DATA_DIR=/data/demo-sessions`. Session and daily-write records use
exclusive filesystem locks, integrity hashes, write/fsync/rename commits, strict
validation on read, and corruption fail-closed behavior. LIVE fails closed when
persistence, lock acquisition, configuration, keys, balances, the daily budget, or
dedicated infrastructure is invalid.

`/health` is fast and makes zero Mirror calls. It validates immutable replay,
configuration coherence, and—only when LIVE is enabled—volume round trip plus local
key material. Deep network/balance/contract/topic readiness belongs to capabilities;
when LIVE infrastructure is absent, replay and simulation stay healthy.

Rate limits assume this documented single-replica topology: public reads 60/min/IP,
session creation 1/min/IP, LIVE creation 10/hour globally, and actions 20/min/IP.

## Deployment state

This phase performs no deployment and no external state change. The dedicated demo
contract is not deployed, the reusable demo topic is not created, LIVE remains
disabled, and validation performs `NETWORK_WRITES=0`.
