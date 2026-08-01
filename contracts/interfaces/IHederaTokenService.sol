// SPDX-License-Identifier: ISC
pragma solidity 0.8.28;

/**
 * Minimal Hedera Token Service (HTS) system-contract surface used by RouteGuard.
 *
 * Only the calls the freight escrow actually needs are declared. HTS amounts are
 * signed 64-bit integers, which is why every RouteGuard amount is bounded to
 * `int64.max` before it is narrowed.
 */
interface IHederaTokenService {
    /**
     * Transfer `amount` of `token` from `sender` to `receiver`.
     * The escrow contract must either own the tokens or hold an allowance.
     *
     * @return responseCode HTS response code; 22 (`SUCCESS`) is the only
     *         acceptable value.
     */
    function transferToken(
        address token,
        address sender,
        address receiver,
        int64 amount
    ) external returns (int64 responseCode);

    /**
     * Associate `account` with `token`. Required before an account may hold an
     * HTS token balance.
     */
    function associateToken(address account, address token)
        external
        returns (int64 responseCode);
}

/** HTS response codes used by RouteGuard. */
library HederaResponseCodes {
    int64 internal constant SUCCESS = 22;
    int64 internal constant TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;
}
