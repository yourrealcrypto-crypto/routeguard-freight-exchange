// SPDX-License-Identifier: ISC
pragma solidity 0.8.28;

/**
 * Offline reentrancy probe.
 *
 * Records the outcome of a re-entrant call made while the escrow is mid-transfer.
 * Never deployed to a network.
 */
contract ReentrantSettlementAttacker {
    address public escrow;
    bytes public payload;
    bool public reentered;
    bool public reentrySucceeded;

    function arm(address escrow_, bytes calldata payload_) external {
        escrow = escrow_;
        payload = payload_;
        reentered = false;
        reentrySucceeded = false;
    }

    /// Invoked by the mock ledger while an outbound transfer is in flight.
    function attack() external {
        reentered = true;
        (bool ok, ) = escrow.call(payload);
        reentrySucceeded = ok;
    }
}
