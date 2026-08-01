/**
 * RouteGuard freight escrow ABI (human-readable form).
 *
 * Hand-maintained so `src/` never depends on build artifacts, and asserted
 * against the compiled contract ABI by the offline contract tests — a Solidity
 * signature change that is not mirrored here fails the suite.
 */

export const ROUTEGUARD_FREIGHT_ESCROW_ABI = [
  // Views
  "function escrowToken() view returns (address)",
  "function owner() view returns (address)",
  "function totalEscrowedAmount() view returns (uint256)",
  "function authorizationHashUsed(bytes32) view returns (bool)",
  "function computeTenderKey(bytes32 tenderIdHash, uint32 tenderVersion) pure returns (bytes32)",
  "function getTender(bytes32 tenderKey) view returns (tuple(uint8 state,uint32 tenderVersion,address shipper,address winner,uint64 maxBudget,uint64 fundedAmount,uint64 lockedAmount,uint64 excessRefunded,bytes32 tenderIdHash,bytes32 manifestHash,bytes32 creationAuthHash,bytes32 decisionManifestHash,bytes32 disputeAuthHash,bytes32 settlementAuthHash))",
  "function getState(bytes32 tenderKey) view returns (uint8)",
  "function tenderBalance(bytes32 tenderKey) view returns (uint64)",

  // Lifecycle operations
  "function registerTender(bytes32 tenderKey, bytes32 tenderIdHash, uint32 tenderVersion, address shipper, uint256 maxBudget, address token, bytes32 creationAuthHash, bytes32 manifestHash)",
  "function fundTender(bytes32 tenderKey, uint256 amount)",
  "function allocateWinner(bytes32 tenderKey, address winner, uint256 winningAmount, bytes32 decisionManifestHash, bytes32 allocationAuthHash)",
  "function refundNoQualifiedBid(bytes32 tenderKey, bytes32 authorizationHash)",
  "function releaseFull(bytes32 tenderKey, bytes32 authorizationHash)",
  "function openDispute(bytes32 tenderKey, bytes32 disputeAuthHash)",
  "function resolveDisputeRelease(bytes32 tenderKey, bytes32 refereeAuthHash)",
  "function refundFull(bytes32 tenderKey, bytes32 refereeAuthHash)",
  "function partialRelease(bytes32 tenderKey, uint256 winnerAmount, uint256 shipperAmount, bytes32 refereeAuthHash)",
  "function associateEscrowToken() returns (int64)",

  // Public-safe events
  "event TenderEscrowRegistered(bytes32 indexed tenderKey, bytes32 indexed tenderIdHash, uint32 tenderVersion, address indexed shipper, uint64 maxBudget, address token, bytes32 creationAuthHash, bytes32 manifestHash)",
  "event TenderEscrowFunded(bytes32 indexed tenderKey, address indexed shipper, uint64 fundedAmount)",
  "event WinnerAllocated(bytes32 indexed tenderKey, address indexed winner, uint64 winningAmount, uint64 excessAmount, bytes32 decisionManifestHash, bytes32 allocationAuthHash)",
  "event ExcessRefunded(bytes32 indexed tenderKey, address indexed shipper, uint64 excessAmount)",
  "event NoWinnerRefunded(bytes32 indexed tenderKey, address indexed shipper, uint64 amount, bytes32 authorizationHash)",
  "event DisputeOpened(bytes32 indexed tenderKey, bytes32 disputeAuthHash)",
  "event FreightReleased(bytes32 indexed tenderKey, address indexed winner, uint64 amount, bytes32 authorizationHash, bool fromDispute)",
  "event FreightRefunded(bytes32 indexed tenderKey, address indexed shipper, uint64 amount, bytes32 authorizationHash, bool fromDispute)",
  "event FreightPartiallyReleased(bytes32 indexed tenderKey, address indexed winner, address indexed shipper, uint64 winnerAmount, uint64 shipperAmount, bytes32 authorizationHash)",
] as const;

/** Contract source of truth for deployment in Phase C2. */
export const ROUTEGUARD_FREIGHT_ESCROW_CONTRACT =
  "contracts/RouteGuardFreightEscrow.sol:RouteGuardFreightEscrow" as const;

export const ESCROW_PUBLIC_EVENT_NAMES = [
  "TenderEscrowRegistered",
  "TenderEscrowFunded",
  "WinnerAllocated",
  "ExcessRefunded",
  "NoWinnerRefunded",
  "DisputeOpened",
  "FreightReleased",
  "FreightRefunded",
  "FreightPartiallyReleased",
] as const;

export type EscrowEventName = (typeof ESCROW_PUBLIC_EVENT_NAMES)[number];
