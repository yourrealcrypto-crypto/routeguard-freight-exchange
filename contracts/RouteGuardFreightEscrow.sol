// SPDX-License-Identifier: ISC
pragma solidity 0.8.28;

import {RouteGuardFreightEscrowBase} from "./RouteGuardFreightEscrowBase.sol";
import {
    HederaResponseCodes,
    IHederaTokenService
} from "./interfaces/IHederaTokenService.sol";

/**
 * Deployable RouteGuard freight escrow for Hedera.
 *
 * Token movement goes through the HTS system contract at `0x167` with the
 * immutable escrow token bound at construction. There is no arbitrary external
 * call target: the only callee is the HTS precompile, and every response code
 * is checked — a non-`SUCCESS` code reverts the whole transaction, so state can
 * never diverge from token balances.
 */
contract RouteGuardFreightEscrow is RouteGuardFreightEscrowBase {
    /// Hedera Token Service system contract.
    IHederaTokenService internal constant HTS =
        IHederaTokenService(address(0x167));

    event EscrowTokenAssociated(address indexed token, int64 responseCode);

    constructor(address token, address operator)
        RouteGuardFreightEscrowBase(token, operator)
    {}

    /**
     * Associate this contract with the escrow token so it can hold a balance.
     * Idempotent: an already-associated token is not an error.
     */
    function associateEscrowToken() external onlyOwner returns (int64) {
        int64 responseCode = HTS.associateToken(address(this), escrowToken);
        if (
            responseCode != HederaResponseCodes.SUCCESS &&
            responseCode !=
            HederaResponseCodes.TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT
        ) {
            revert TokenTransferFailed(responseCode);
        }
        emit EscrowTokenAssociated(escrowToken, responseCode);
        return responseCode;
    }

    function _transferIn(address from, uint64 amount) internal override {
        _htsTransfer(from, address(this), amount);
    }

    function _transferOut(address to, uint64 amount) internal override {
        _htsTransfer(address(this), to, amount);
    }

    function _htsTransfer(address from, address to, uint64 amount) private {
        // `amount` is already bounded to int64.max by the base contract, so the
        // narrowing below cannot wrap into a negative transfer.
        int64 htsAmount = int64(amount);
        int64 responseCode = HTS.transferToken(escrowToken, from, to, htsAmount);
        if (responseCode != HederaResponseCodes.SUCCESS) {
            revert TokenTransferFailed(responseCode);
        }
    }
}
