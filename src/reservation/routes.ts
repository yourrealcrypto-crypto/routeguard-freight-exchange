/**
 * Testable Hono reservation routes with dependency injection.
 * Strict request schemas and sanitized responses (Phase 6A.2C).
 */

import { Hono } from "hono";
import { ZodError } from "zod";

import {
  paymentEconomicsForSelection,
  publicPaymentRailsFromOffer,
  publicReservationView,
  type ReservationService,
} from "./reservation-service";
import {
  CorruptReservationRecordError,
  PayReservationBodySchema,
  SelectReservationBodySchema,
} from "./record-schema";
import {
  ReservationError,
  ReservationVersionConflictError,
  type ReservationOptionId,
} from "./types";

export type ReservationRouteDeps = {
  service: ReservationService;
  /**
   * Optional injected logger for sanitized internal errors (tests may hook).
   * Never log raw payloads containing secrets.
   */
  onInternalError?: (info: { code: string; message: string }) => void;
};

function errorStatus(code: string): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "SELECTION_LOCKED":
    case "WRONG_ASSET_ROUTE":
    case "SETTLE_ONCE":
    case "TERMINAL_FAILURE":
    case "VERSION_CONFLICT":
      return 409;
    case "OFFER_EXPIRED":
    case "STALE_OFFER":
    case "UNKNOWN_OPTION":
    case "NO_SELECTION":
    case "NO_CHALLENGE":
    case "FORGED_PROOF":
    case "WRONG_WINNER":
    case "INVALID_BODY":
    case "CHALLENGE_MISMATCH":
      return 400;
    case "CORRUPT_RESERVATION_RECORD":
    case "INVALID_PERSISTED_RECORD":
    case "STORE_CORRUPT":
      return 500;
    default:
      return 400;
  }
}

export function createReservationApp(deps: ReservationRouteDeps): Hono {
  const app = new Hono();
  registerReservationRoutes(app, deps);
  return app;
}

export function registerReservationRoutes(
  app: Hono,
  deps: ReservationRouteDeps,
): void {
  const { service } = deps;

  app.get("/api/reservations/:reservationId", async (c) => {
    try {
      const id = c.req.param("reservationId");
      const record = await service.getReservation(id);
      if (!record) {
        return c.json({ error: "NOT_FOUND" }, 404);
      }
      return c.json(publicReservationView(record) as Record<string, unknown>);
    } catch (e) {
      return handleError(c, e, deps);
    }
  });

  app.get("/api/reservations/:reservationId/options", async (c) => {
    try {
      const id = c.req.param("reservationId");
      const record = await service.getReservation(id);
      if (!record) {
        return c.json({ error: "NOT_FOUND" }, 404);
      }
      return c.json({
        reservationId: record.reservationId,
        offer: record.offer,
        // Application-level rail presentation (not x402 protocol fields).
        paymentRails: publicPaymentRailsFromOffer(record.offer),
        // immutable public offer only — no private bid data
      });
    } catch (e) {
      return handleError(c, e, deps);
    }
  });

  app.post("/api/reservations/:reservationId/select", async (c) => {
    try {
      const id = c.req.param("reservationId");
      const raw = await parseJsonBody(c);
      const body = SelectReservationBodySchema.parse(raw);
      const record = await service.selectOption({
        reservationId: id,
        optionId: body.optionId,
        offerHash: body.offerHash,
        offerVersion: body.offerVersion,
        payerAccount: body.payerAccount,
      });
      return c.json({
        reservationId: record.reservationId,
        state: record.state,
        selected: record.selected
          ? {
              optionId: record.selected.optionId,
              asset: record.selected.asset,
              amountAtomic: record.selected.amountAtomic,
              payTo: record.selected.payTo,
              network: record.selected.network,
              payerAccount: record.selected.payerAccount,
              resourcePath: record.selected.resourcePath,
            }
          : null,
        paymentEconomics: record.selected
          ? paymentEconomicsForSelection(record.selected)
          : null,
      });
    } catch (e) {
      return handleError(c, e, deps);
    }
  });

  app.get("/api/reservations/:reservationId/pay/usdc", async (c) => {
    return payChallenge(c, service, "USDC", deps);
  });

  app.post("/api/reservations/:reservationId/pay/usdc", async (c) => {
    return paySubmit(c, service, "USDC", deps);
  });

  app.get("/api/reservations/:reservationId/pay/hbar", async (c) => {
    return payChallenge(c, service, "HBAR", deps);
  });

  app.post("/api/reservations/:reservationId/pay/hbar", async (c) => {
    return paySubmit(c, service, "HBAR", deps);
  });

  app.get("/api/reservations/:reservationId/status", async (c) => {
    try {
      const id = c.req.param("reservationId");
      const record = await service.getReservation(id);
      if (!record) {
        return c.json({ error: "NOT_FOUND" }, 404);
      }
      return c.json({
        reservationId: record.reservationId,
        state: record.state,
        selectedOptionId: record.selected?.optionId ?? null,
        transactionId: record.transactionId,
        routeReserved: record.routeReserved !== null,
        failureCode: record.failureCode,
      });
    } catch (e) {
      return handleError(c, e, deps);
    }
  });
}

async function parseJsonBody(c: {
  req: { json(): Promise<unknown> };
}): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ReservationError("INVALID_BODY", "Malformed JSON body");
  }
}

async function payChallenge(
  c: {
    req: { param(name: string): string };
    json: (body: unknown, status?: number) => Response;
  },
  service: ReservationService,
  optionId: ReservationOptionId,
  deps: ReservationRouteDeps,
): Promise<Response> {
  try {
    const id = c.req.param("reservationId");
    const { challenge, record } = await service.issueChallenge(id, optionId);
    // Safe public challenge fields only (no private material).
    return c.json({
      reservationId: record.reservationId,
      state: record.state,
      optionId,
      challenge: {
        x402Version: challenge.x402Version,
        scheme: challenge.scheme,
        network: challenge.network,
        asset: challenge.asset,
        amount: challenge.amount,
        payTo: challenge.payTo,
        resource: challenge.resource,
        maxTimeoutSeconds: challenge.maxTimeoutSeconds,
        description: challenge.description,
        challengeHash: challenge.challengeHash,
        issuedAt: challenge.issuedAt,
      },
      // Economics are application metadata beside the protocol challenge.
      paymentEconomics: record.selected
        ? paymentEconomicsForSelection(record.selected)
        : null,
      note: "Demo reservation fee challenge — not freight price",
    });
  } catch (e) {
    return handleError(c, e, deps);
  }
}

async function paySubmit(
  c: {
    req: {
      param(name: string): string;
      json(): Promise<unknown>;
    };
    json: (body: unknown, status?: number) => Response;
  },
  service: ReservationService,
  optionId: ReservationOptionId,
  deps: ReservationRouteDeps,
): Promise<Response> {
  try {
    const id = c.req.param("reservationId");
    const raw = await parseJsonBody(c);
    const body = PayReservationBodySchema.parse(raw);
    const record = await service.submitPayment({
      reservationId: id,
      optionId,
      paymentPayloadHash: body.paymentPayloadHash,
      // v1.5 §22.4 — mandatory client-frozen transaction identity.
      clientTransaction: body.clientTransaction,
      ...(body.httpStatus !== undefined
        ? { httpStatus: body.httpStatus }
        : {}),
    });
    return c.json({
      reservationId: record.reservationId,
      state: record.state,
      transactionId: record.transactionId,
      paymentEconomics: record.selected
        ? paymentEconomicsForSelection(record.selected)
        : null,
      routeReserved: record.routeReserved
        ? {
            reservationId: record.routeReserved.reservationId,
            selectedOptionId: record.routeReserved.selectedOptionId,
            paymentAsset: record.routeReserved.paymentAsset,
            paymentAmountAtomic: record.routeReserved.paymentAmountAtomic,
            carrierReceivedAmountAtomic:
              record.routeReserved.paymentAmountAtomic,
            transactionId: record.routeReserved.transactionId,
            consensusTimestamp: record.routeReserved.consensusTimestamp,
            reservedAt: record.routeReserved.reservedAt,
            reservationRecordHash: record.routeReserved.reservationRecordHash,
          }
        : null,
      failureCode: record.failureCode,
    });
  } catch (e) {
    return handleError(c, e, deps);
  }
}

function handleError(
  c: { json: (body: unknown, status?: number) => Response },
  e: unknown,
  deps?: ReservationRouteDeps,
): Response {
  if (e instanceof ZodError) {
    return c.json(
      {
        error: "INVALID_BODY",
        message: "Request body failed validation",
      },
      400,
    );
  }
  if (e instanceof CorruptReservationRecordError) {
    deps?.onInternalError?.({
      code: e.code,
      message: "corrupt reservation record",
    });
    return c.json({ error: "INTERNAL_ERROR" }, 500);
  }
  if (e instanceof ReservationVersionConflictError) {
    return c.json(
      { error: "VERSION_CONFLICT", message: "Reservation version conflict" },
      409,
    );
  }
  if (e instanceof ReservationError) {
    return c.json(
      { error: e.code, message: e.message },
      errorStatus(e.code) as 400,
    );
  }
  deps?.onInternalError?.({
    code: "INTERNAL_ERROR",
    message: e instanceof Error ? e.name : "unknown",
  });
  // Never return stack traces or implementation detail.
  return c.json({ error: "INTERNAL_ERROR" }, 500);
}
