# Recovered Operations Demo attempt

This directory documents a **failed supervised session and its separate manual
recovery**. It is not a successful 12-write Operations Demo proof.

The session completed four application writes: tender registration, exact
allowance, escrow funding, and tender x402 access. Its self-generated auction
deadline then expired. The production carrier-offer route rejected the late
offer before charging it, so no carrier-offer payment, winner allocation, POD,
HCS message, or freight release occurred.

A separately authorized `refundNoQualifiedBid` transaction returned the full
20,000 atomic USDC escrow balance to original shipper `0.0.9197513`. The tender
is now `REFUNDED`, its balance is zero, and the dedicated demo topic remained at
sequence zero. The partial run used four writes; recovery used one; total writes
associated with the failed attempt are five.

The registered tender manifest was not changed. The failed session must never
be resumed or presented as completed. Any future controlled run requires fresh
session, tender, action, and authorization identifiers plus the persisted
minimum 30-minute auction window.

All files are public-safe. They contain no keys, signatures, POD contents,
ciphertext, administrator credentials, or private filesystem paths.
