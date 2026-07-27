# Final evidence-based demo script (under five minutes)

**Recording rule:** Use completed live evidence only. Do **not** run
`demo:final-auction` live, do **not** create a topic, do **not** submit HCS,
and do **not** construct or settle another payment on camera.

**Primary screen:** `evidence/final-demo-report.html` at **1920×1080**, 100% zoom.

**Browser tabs (prepare before record):**

1. `evidence/final-demo-report.html` (primary narration track)
2. HashScan payment: https://hashscan.io/testnet/transaction/0.0.7162784@1785173890.867086556
3. HashScan topic: https://hashscan.io/testnet/topic/0.0.9794225
4. Optional: USDC HTTP 402 smoke HashScan: https://hashscan.io/testnet/transaction/0.0.7162784@1784141033.517654222

**Terminology:** private, **commitment-based** auction — not “sealed auction.”

Hedera makes machine-scale payment viable because the challenge specifies a
fixed $0.0001 cost for an HBAR transfer and $0.001 for a stablecoin transfer.
The carrier reservation payment is a separate economic amount.

---

## Run-of-show (target ~4:45, hard cap 5:00)

| Clock | Beat | On screen | Narration |
| --- | --- | --- | --- |
| 0:00–0:20 | Hook | LIVE banner + hero | Carrier software offers freight capacity. Shipper software accepts the winning offer by paying an x402 reservation fee on Hedera. Confirmed settlement — not a promise — creates the route reservation. |
| 0:20–0:50 | Actors | Actor strip | Synthetic demo shipper and carriers. Winner is carrier-alpha (`0.0.9215954`). This is a private, commitment-based auction: full bids stay off-chain; salted commitments and the close barrier are on HCS. |
| 0:50–1:30 | Auction window | Timeline steps 1–4 | Topic `0.0.9794225`. Sequences 1–4: open, alpha commitment, beta commitment, close barrier. Consensus timestamps are the authoritative clock. |
| 1:30–2:00 | Winner | Step 5 + Decision Manifest | Barrier consensus ≥ auction deadline. Deterministic evaluation selects alpha. Same inputs ⇒ same winner; decisionManifestHash is in the evidence. |
| 2:00–2:40 | Two payment surfaces | Payment panel + HTTP 402 section | **A.** Canonical protocol HTTP 402 handshake (official `@x402/hono`): 402 → signed retry → 200; smoke tx `0.0.7162784@1784141033.517654222`, Mirror SUCCESS, exactly one settlement. **B.** Freight reservation reuses x402 v2 exact objects and facilitator verify/settle, then publishes ROUTE_RESERVED only after Mirror-confirmed settlement — do not claim the reservation endpoint itself returned HTTP 402. |
| 2:40–3:15 | Live settlement | HashScan payment tab | Live reservation payment `0.0.7162784@1785173890.867086556`: Mirror SUCCESS; 10000 atomic USDC payer → carrier; challenge-stated network cost $0.001 is separate and not deducted (HBAR rail: $0.0001). |
| 3:15–3:50 | Reservation proof | Step 7 + HashScan topic | Settlement precedes reservation. Sequence 5 `ROUTE_RESERVED` embeds the payment transaction ID and payment consensus timestamp, so settlement-before-reservation is verifiable from topic `0.0.9794225` alone. |
| 3:50–4:20 | Fail-closed | Fail-closed guarantees (collapsed) | Wrong recipient and duplicate settle are blocked by automated tests. This live execution recorded exactly one facilitator settle call — not a live wrong-recipient experiment. |
| 4:20–4:45 | Close | Hero + HashScan links | HCS sets the bid window. One confirmed x402 USDC settlement reserves capacity. All of it is publicly verifiable on testnet. |
| 4:45–5:00 | Buffer | — | Safety margin; do not fill with a second live payment. |

---

## Evidence anchors (do not improvise)

| Fact | Value |
| --- | --- |
| Mode | `LIVE_FINAL_DEMO` |
| Topic | `0.0.9794225` |
| HCS sequences | 1–5 complete |
| Live payment | `0.0.7162784@1785173890.867086556` |
| Amount | 10000 atomic USDC (0.01) · token `0.0.429274` |
| Payment consensus | `2026-07-27T17:38:16.977444275Z` |
| ROUTE_RESERVED consensus | `2026-07-27T17:38:23.453477104Z` |
| Canonical HTTP 402 smoke payment | `0.0.7162784@1784141033.517654222` |
| Tracked reservation record | `evidence/final-demo-live-reservation-record.json` |

## Cut if over time

1. Terminal dry-run tail
2. Compress actors into the hook
3. Leave fail-closed accordions closed (one sentence only)

## Explicit non-goals for video

- No second live payment
- No HBAR live settlement walkthrough (chip only)
- No recovery stack trace or deep crash-resume narrative (one restrained README sentence is enough)
- No dry-run report while narrating live proof
