// SPDX-License-Identifier: ISC
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * RouteGuard v2 freight-principal escrow — state machine and accounting.
 *
 * This contract custodies the **freight principal** in HTS USDC. It is
 * economically separate from the RouteGuard x402 access fee (0.001 USDC to the
 * access treasury), which never passes through this contract.
 *
 * Money model:
 *   - the shipper funds exactly `maxBudget` (Phase A locks exact funding:
 *     underfunding and overfunding are both rejected);
 *   - allocation locks the winning amount and immediately returns the exact
 *     excess to the shipper, so `winningAmount + excessRefunded == fundedAmount`;
 *   - settlement moves only the locked amount, and always in full.
 *
 * Authorization model (demo): RouteGuard verifies shipper and referee
 * signatures **off-chain** and submits the resulting canonical authorization
 * hash. The contract records that hash, enforces single use, and never
 * evaluates POD documents. AI output has no operator or signing authority.
 * On-chain signature verification / multisig is a documented production
 * hardening option, not part of this phase.
 *
 * Token movement is abstract here so the identical state machine can be
 * exercised offline against a mock ledger and on Hedera against the HTS system
 * contract. Deployment always uses the HTS implementation.
 */
abstract contract RouteGuardFreightEscrowBase is Ownable2Step, ReentrancyGuard {
    /// Largest amount that can be narrowed to the HTS `int64` transfer type.
    uint256 internal constant MAX_HTS_AMOUNT = uint256(uint64(type(int64).max));

    /// Domain separator for the canonical tender key.
    bytes32 public constant TENDER_KEY_DOMAIN =
        keccak256("ROUTEGUARD_V2_FREIGHT_ESCROW_TENDER_KEY_V1");

    enum EscrowState {
        UNREGISTERED,
        REGISTERED,
        FUNDED,
        ALLOCATED,
        DISPUTED,
        RELEASED,
        REFUNDED,
        PARTIALLY_RELEASED
    }

    struct TenderEscrow {
        EscrowState state;
        uint32 tenderVersion;
        address shipper;
        address winner;
        uint64 maxBudget;
        uint64 fundedAmount;
        uint64 lockedAmount;
        uint64 excessRefunded;
        bytes32 tenderIdHash;
        bytes32 manifestHash;
        bytes32 creationAuthHash;
        bytes32 decisionManifestHash;
        bytes32 disputeAuthHash;
        bytes32 settlementAuthHash;
    }

    /// Immutable HTS USDC token this escrow is bound to. One token, all tenders.
    address public immutable escrowToken;

    mapping(bytes32 => TenderEscrow) private _tenders;

    /// Every authorization hash may be consumed at most once, across all tenders.
    mapping(bytes32 => bool) public authorizationHashUsed;

    /// Sum of all unsettled tender balances held by this contract.
    uint256 public totalEscrowedAmount;

    event TenderEscrowRegistered(
        bytes32 indexed tenderKey,
        bytes32 indexed tenderIdHash,
        uint32 tenderVersion,
        address indexed shipper,
        uint64 maxBudget,
        address token,
        bytes32 creationAuthHash,
        bytes32 manifestHash
    );
    event TenderEscrowFunded(
        bytes32 indexed tenderKey,
        address indexed shipper,
        uint64 fundedAmount
    );
    event WinnerAllocated(
        bytes32 indexed tenderKey,
        address indexed winner,
        uint64 winningAmount,
        uint64 excessAmount,
        bytes32 decisionManifestHash,
        bytes32 allocationAuthHash
    );
    event ExcessRefunded(
        bytes32 indexed tenderKey,
        address indexed shipper,
        uint64 excessAmount
    );
    event NoWinnerRefunded(
        bytes32 indexed tenderKey,
        address indexed shipper,
        uint64 amount,
        bytes32 authorizationHash
    );
    event DisputeOpened(bytes32 indexed tenderKey, bytes32 disputeAuthHash);
    event FreightReleased(
        bytes32 indexed tenderKey,
        address indexed winner,
        uint64 amount,
        bytes32 authorizationHash,
        bool fromDispute
    );
    event FreightRefunded(
        bytes32 indexed tenderKey,
        address indexed shipper,
        uint64 amount,
        bytes32 authorizationHash,
        bool fromDispute
    );
    event FreightPartiallyReleased(
        bytes32 indexed tenderKey,
        address indexed winner,
        address indexed shipper,
        uint64 winnerAmount,
        uint64 shipperAmount,
        bytes32 authorizationHash
    );

    error InvalidState(bytes32 tenderKey, EscrowState expected, EscrowState actual);
    error TenderAlreadyRegistered(bytes32 tenderKey);
    error TenderNotRegistered(bytes32 tenderKey);
    error ZeroAddressNotAllowed();
    error ZeroAmountNotAllowed();
    error ZeroHashNotAllowed();
    error AmountExceedsHtsRange(uint256 amount);
    error UnsupportedToken(address token);
    error NotAuthorizedShipper(address caller);
    error FundingAmountMismatch(uint64 required, uint256 supplied);
    error WinningAmountExceedsBudget(uint64 budget, uint256 winningAmount);
    error AuthorizationHashAlreadyUsed(bytes32 authorizationHash);
    error PartialAmountsDoNotConserve(uint64 locked, uint256 supplied);
    error TokenTransferFailed(int64 responseCode);

    constructor(address token, address operator) Ownable(operator) {
        if (token == address(0) || operator == address(0)) {
            revert ZeroAddressNotAllowed();
        }
        escrowToken = token;
    }

    // -----------------------------------------------------------------------
    // Token boundary (implemented by the HTS or the offline-test subclass)
    // -----------------------------------------------------------------------

    /// Move `amount` of the escrow token from `from` into this contract.
    function _transferIn(address from, uint64 amount) internal virtual;

    /// Move `amount` of the escrow token from this contract to `to`.
    function _transferOut(address to, uint64 amount) internal virtual;

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /**
     * Canonical tender key. Binds the tender identity hash, the tender version,
     * and an explicit RouteGuard domain separator, so a hash from another
     * context can never be replayed as a tender key.
     */
    function computeTenderKey(bytes32 tenderIdHash, uint32 tenderVersion)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(TENDER_KEY_DOMAIN, tenderIdHash, tenderVersion));
    }

    function getTender(bytes32 tenderKey)
        external
        view
        returns (TenderEscrow memory)
    {
        return _tenders[tenderKey];
    }

    function getState(bytes32 tenderKey) external view returns (EscrowState) {
        return _tenders[tenderKey].state;
    }

    /// Amount this contract still holds for one tender.
    function tenderBalance(bytes32 tenderKey) public view returns (uint64) {
        TenderEscrow storage t = _tenders[tenderKey];
        if (t.state == EscrowState.FUNDED) {
            return t.fundedAmount;
        }
        if (t.state == EscrowState.ALLOCATED || t.state == EscrowState.DISPUTED) {
            return t.lockedAmount;
        }
        return 0;
    }

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    function registerTender(
        bytes32 tenderKey,
        bytes32 tenderIdHash,
        uint32 tenderVersion,
        address shipper,
        uint256 maxBudget,
        address token,
        bytes32 creationAuthHash,
        bytes32 manifestHash
    ) external onlyOwner nonReentrant {
        if (_tenders[tenderKey].state != EscrowState.UNREGISTERED) {
            revert TenderAlreadyRegistered(tenderKey);
        }
        if (shipper == address(0)) revert ZeroAddressNotAllowed();
        if (token != escrowToken) revert UnsupportedToken(token);
        if (tenderIdHash == bytes32(0) || creationAuthHash == bytes32(0)) {
            revert ZeroHashNotAllowed();
        }
        if (tenderVersion == 0) revert ZeroAmountNotAllowed();
        if (maxBudget == 0) revert ZeroAmountNotAllowed();
        if (maxBudget > MAX_HTS_AMOUNT) revert AmountExceedsHtsRange(maxBudget);
        if (tenderKey != computeTenderKey(tenderIdHash, tenderVersion)) {
            revert TenderNotRegistered(tenderKey);
        }
        _consumeAuthorizationHash(creationAuthHash);

        TenderEscrow storage t = _tenders[tenderKey];
        t.state = EscrowState.REGISTERED;
        t.tenderVersion = tenderVersion;
        t.shipper = shipper;
        t.maxBudget = uint64(maxBudget);
        t.tenderIdHash = tenderIdHash;
        t.manifestHash = manifestHash;
        t.creationAuthHash = creationAuthHash;

        emit TenderEscrowRegistered(
            tenderKey,
            tenderIdHash,
            tenderVersion,
            shipper,
            uint64(maxBudget),
            token,
            creationAuthHash,
            manifestHash
        );
    }

    // -----------------------------------------------------------------------
    // Funding — exact budget only (Phase A policy)
    // -----------------------------------------------------------------------

    function fundTender(bytes32 tenderKey, uint256 amount) external nonReentrant {
        TenderEscrow storage t = _tenders[tenderKey];
        _requireState(tenderKey, t, EscrowState.REGISTERED);
        if (msg.sender != t.shipper) revert NotAuthorizedShipper(msg.sender);
        // Exact funding: underfunding and overfunding are both rejected, so no
        // unmodeled residual can ever enter the escrow.
        if (amount != uint256(t.maxBudget)) {
            revert FundingAmountMismatch(t.maxBudget, amount);
        }

        uint64 funded = uint64(amount);
        t.state = EscrowState.FUNDED;
        t.fundedAmount = funded;
        totalEscrowedAmount += funded;

        _transferIn(msg.sender, funded);

        emit TenderEscrowFunded(tenderKey, msg.sender, funded);
    }

    // -----------------------------------------------------------------------
    // Allocation
    // -----------------------------------------------------------------------

    function allocateWinner(
        bytes32 tenderKey,
        address winner,
        uint256 winningAmount,
        bytes32 decisionManifestHash,
        bytes32 allocationAuthHash
    ) external onlyOwner nonReentrant {
        TenderEscrow storage t = _tenders[tenderKey];
        _requireState(tenderKey, t, EscrowState.FUNDED);
        if (winner == address(0)) revert ZeroAddressNotAllowed();
        if (winningAmount == 0) revert ZeroAmountNotAllowed();
        if (winningAmount > MAX_HTS_AMOUNT) {
            revert AmountExceedsHtsRange(winningAmount);
        }
        if (winningAmount > uint256(t.fundedAmount)) {
            revert WinningAmountExceedsBudget(t.fundedAmount, winningAmount);
        }
        if (decisionManifestHash == bytes32(0) || allocationAuthHash == bytes32(0)) {
            revert ZeroHashNotAllowed();
        }
        _consumeAuthorizationHash(allocationAuthHash);

        uint64 locked = uint64(winningAmount);
        uint64 excess = t.fundedAmount - locked; // conservation by construction

        // Effects before interactions.
        t.state = EscrowState.ALLOCATED;
        t.winner = winner;
        t.lockedAmount = locked;
        t.excessRefunded = excess;
        t.decisionManifestHash = decisionManifestHash;
        totalEscrowedAmount -= excess;

        emit WinnerAllocated(
            tenderKey,
            winner,
            locked,
            excess,
            decisionManifestHash,
            allocationAuthHash
        );

        // The winner receives nothing here: only the shipper's excess moves.
        if (excess > 0) {
            _transferOut(t.shipper, excess);
            emit ExcessRefunded(tenderKey, t.shipper, excess);
        }
    }

    // -----------------------------------------------------------------------
    // No qualified bid — full refund
    // -----------------------------------------------------------------------

    function refundNoQualifiedBid(bytes32 tenderKey, bytes32 authorizationHash)
        external
        onlyOwner
        nonReentrant
    {
        TenderEscrow storage t = _tenders[tenderKey];
        _requireState(tenderKey, t, EscrowState.FUNDED);
        if (authorizationHash == bytes32(0)) revert ZeroHashNotAllowed();
        _consumeAuthorizationHash(authorizationHash);

        uint64 amount = t.fundedAmount;
        address shipper = t.shipper;

        t.state = EscrowState.REFUNDED;
        t.settlementAuthHash = authorizationHash;
        totalEscrowedAmount -= amount;

        emit NoWinnerRefunded(tenderKey, shipper, amount, authorizationHash);

        _transferOut(shipper, amount);
    }

    // -----------------------------------------------------------------------
    // Ordinary settlement (POD accepted or deemed accepted)
    // -----------------------------------------------------------------------

    function releaseFull(bytes32 tenderKey, bytes32 authorizationHash)
        external
        onlyOwner
        nonReentrant
    {
        TenderEscrow storage t = _tenders[tenderKey];
        // ALLOCATED only: once a dispute is open the ordinary path is closed.
        _requireState(tenderKey, t, EscrowState.ALLOCATED);
        if (authorizationHash == bytes32(0)) revert ZeroHashNotAllowed();
        _consumeAuthorizationHash(authorizationHash);

        uint64 amount = t.lockedAmount;
        address winner = t.winner;

        t.state = EscrowState.RELEASED;
        t.settlementAuthHash = authorizationHash;
        totalEscrowedAmount -= amount;

        emit FreightReleased(tenderKey, winner, amount, authorizationHash, false);

        _transferOut(winner, amount);
    }

    // -----------------------------------------------------------------------
    // Dispute path
    // -----------------------------------------------------------------------

    function openDispute(bytes32 tenderKey, bytes32 disputeAuthHash)
        external
        onlyOwner
        nonReentrant
    {
        TenderEscrow storage t = _tenders[tenderKey];
        _requireState(tenderKey, t, EscrowState.ALLOCATED);
        if (disputeAuthHash == bytes32(0)) revert ZeroHashNotAllowed();
        _consumeAuthorizationHash(disputeAuthHash);

        t.state = EscrowState.DISPUTED;
        t.disputeAuthHash = disputeAuthHash;

        emit DisputeOpened(tenderKey, disputeAuthHash);
    }

    /// Referee resolution: RELEASE_FULL.
    function resolveDisputeRelease(bytes32 tenderKey, bytes32 refereeAuthHash)
        external
        onlyOwner
        nonReentrant
    {
        TenderEscrow storage t = _tenders[tenderKey];
        _requireState(tenderKey, t, EscrowState.DISPUTED);
        if (refereeAuthHash == bytes32(0)) revert ZeroHashNotAllowed();
        _consumeAuthorizationHash(refereeAuthHash);

        uint64 amount = t.lockedAmount;
        address winner = t.winner;

        t.state = EscrowState.RELEASED;
        t.settlementAuthHash = refereeAuthHash;
        totalEscrowedAmount -= amount;

        emit FreightReleased(tenderKey, winner, amount, refereeAuthHash, true);

        _transferOut(winner, amount);
    }

    /// Referee resolution: REFUND_FULL.
    function refundFull(bytes32 tenderKey, bytes32 refereeAuthHash)
        external
        onlyOwner
        nonReentrant
    {
        TenderEscrow storage t = _tenders[tenderKey];
        _requireState(tenderKey, t, EscrowState.DISPUTED);
        if (refereeAuthHash == bytes32(0)) revert ZeroHashNotAllowed();
        _consumeAuthorizationHash(refereeAuthHash);

        uint64 amount = t.lockedAmount;
        address shipper = t.shipper;

        t.state = EscrowState.REFUNDED;
        t.settlementAuthHash = refereeAuthHash;
        totalEscrowedAmount -= amount;

        emit FreightRefunded(tenderKey, shipper, amount, refereeAuthHash, true);

        _transferOut(shipper, amount);
    }

    /// Referee resolution: PARTIAL. Amounts must conserve the locked amount.
    function partialRelease(
        bytes32 tenderKey,
        uint256 winnerAmount,
        uint256 shipperAmount,
        bytes32 refereeAuthHash
    ) external onlyOwner nonReentrant {
        TenderEscrow storage t = _tenders[tenderKey];
        _requireState(tenderKey, t, EscrowState.DISPUTED);
        if (refereeAuthHash == bytes32(0)) revert ZeroHashNotAllowed();
        if (winnerAmount > MAX_HTS_AMOUNT) revert AmountExceedsHtsRange(winnerAmount);
        if (shipperAmount > MAX_HTS_AMOUNT) revert AmountExceedsHtsRange(shipperAmount);
        if (winnerAmount == 0 && shipperAmount == 0) revert ZeroAmountNotAllowed();
        if (winnerAmount + shipperAmount != uint256(t.lockedAmount)) {
            revert PartialAmountsDoNotConserve(
                t.lockedAmount,
                winnerAmount + shipperAmount
            );
        }
        _consumeAuthorizationHash(refereeAuthHash);

        uint64 toWinner = uint64(winnerAmount);
        uint64 toShipper = uint64(shipperAmount);
        address winner = t.winner;
        address shipper = t.shipper;

        t.state = EscrowState.PARTIALLY_RELEASED;
        t.settlementAuthHash = refereeAuthHash;
        totalEscrowedAmount -= t.lockedAmount;

        emit FreightPartiallyReleased(
            tenderKey,
            winner,
            shipper,
            toWinner,
            toShipper,
            refereeAuthHash
        );

        if (toWinner > 0) _transferOut(winner, toWinner);
        if (toShipper > 0) _transferOut(shipper, toShipper);
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    function _requireState(
        bytes32 tenderKey,
        TenderEscrow storage t,
        EscrowState expected
    ) private view {
        if (t.state != expected) {
            revert InvalidState(tenderKey, expected, t.state);
        }
    }

    function _consumeAuthorizationHash(bytes32 authorizationHash) private {
        if (authorizationHashUsed[authorizationHash]) {
            revert AuthorizationHashAlreadyUsed(authorizationHash);
        }
        authorizationHashUsed[authorizationHash] = true;
    }
}
