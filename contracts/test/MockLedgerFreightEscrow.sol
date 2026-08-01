// SPDX-License-Identifier: ISC
pragma solidity 0.8.28;

import {RouteGuardFreightEscrowBase} from "../RouteGuardFreightEscrowBase.sol";

/**
 * Offline test harness for the RouteGuard freight escrow.
 *
 * Replaces only the HTS token boundary with an in-contract ledger so the
 * identical state machine, accounting, and authorization rules can be exercised
 * in a plain EVM. Production deployment uses `RouteGuardFreightEscrow`, which
 * moves real HTS USDC; this contract is never deployed to a network.
 *
 * The mock reproduces the two behaviors that matter for safety tests:
 *   - a transfer can fail (mirroring a non-SUCCESS HTS response code), and
 *   - an outbound transfer can call back into the escrow (reentrancy).
 */
contract MockLedgerFreightEscrow is RouteGuardFreightEscrowBase {
    mapping(address => uint256) public balanceOf;

    /// When set, any transfer touching this account fails.
    address public failingAccount;
    /// When set, an outbound transfer to this account re-enters the escrow.
    address public reentrantAccount;
    bytes public reentrantCalldata;

    constructor(address token, address operator)
        RouteGuardFreightEscrowBase(token, operator)
    {}

    /// Test-only funding of a participant's mock balance.
    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function setFailingAccount(address account) external {
        failingAccount = account;
    }

    function setReentrantAccount(address account, bytes calldata data) external {
        reentrantAccount = account;
        reentrantCalldata = data;
    }

    function _transferIn(address from, uint64 amount) internal override {
        if (from == failingAccount) {
            revert TokenTransferFailed(int64(-1));
        }
        if (balanceOf[from] < amount) {
            revert TokenTransferFailed(int64(-2));
        }
        balanceOf[from] -= amount;
        balanceOf[address(this)] += amount;
    }

    function _transferOut(address to, uint64 amount) internal override {
        if (to == failingAccount) {
            revert TokenTransferFailed(int64(-1));
        }
        if (balanceOf[address(this)] < amount) {
            revert TokenTransferFailed(int64(-2));
        }
        balanceOf[address(this)] -= amount;
        balanceOf[to] += amount;

        // Simulate a callback-capable recipient: a receiver contract is invoked
        // mid-transfer and may attempt to re-enter the escrow. The recipient
        // decides how to handle its own failure, exactly as on a live network.
        if (to == reentrantAccount && reentrantCalldata.length > 0) {
            (bool ok, ) = to.call(reentrantCalldata);
            ok; // the recipient owns this outcome; the escrow does not depend on it
        }
    }
}
