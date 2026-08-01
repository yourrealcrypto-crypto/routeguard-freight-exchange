/**
 * RouteGuard v2 freight-principal escrow boundary.
 *
 * Freight principal is HTS USDC custodied by `RouteGuardFreightEscrow`. It is
 * never an x402 access payment: the 0.001 USDC access fee goes to the access
 * treasury and never touches this contract.
 *
 * Phase C1 is offline — builders produce transaction plans only. Nothing here
 * signs, submits, or confirms a transaction.
 */

export * from "./abi";
export * from "./amounts";
export * from "./events";
export * from "./lifecycle-map";
export * from "./requests";
export * from "./states";
export * from "./tender-key";
