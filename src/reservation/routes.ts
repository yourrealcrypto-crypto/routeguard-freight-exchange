/**
 * Testable Hono reservation routes with dependency injection.
 */

import { Hono } from "hono";

import {
  publicReservationView,
  type ReservationService,
} from "./reservation-service";
import { ReservationError, type ReservationOptionId } from "./types";

export type ReservationRouteDeps = {
  service: ReservationService;
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
      return 409;
    case "OFFER_EXPIRED":
    case "STALE_OFFER":
    case "UNKNOWN_OPTION":
    case "NO_SELECTION":
    case "NO_CHALLENGE":
    case "FORGED_PROOF":
    case "WRONG_WINNER":
      return 400;
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
      return handleError(c, e);
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
        // immutable offer only — no private bid data
      });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.post("/api/reservations/:reservationId/select", async (c) => {
    try {
      const id = c.req.param("reservationId");
      const body = (await c.req.json()) as {
        optionId?: ReservationOptionId;
        offerHash?: string;
        offerVersion?: number;
        payerAccount?: string;
      };
      if (
        !body.optionId ||
        !body.offerHash ||
        body.offerVersion === undefined ||
        !body.payerAccount
      ) {
        return c.json({ error: "INVALID_BODY" }, 400);
      }
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
        selected: record.selected,
      });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/api/reservations/:reservationId/pay/usdc", async (c) => {
    return payChallenge(c, service, "USDC");
  });

  app.post("/api/reservations/:reservationId/pay/usdc", async (c) => {
    return paySubmit(c, service, "USDC");
  });

  app.get("/api/reservations/:reservationId/pay/hbar", async (c) => {
    return payChallenge(c, service, "HBAR");
  });

  app.post("/api/reservations/:reservationId/pay/hbar", async (c) => {
    return paySubmit(c, service, "HBAR");
  });

  app.get("/api/reservations/:reservationId/status", async (c) => {
    try {
      const id = c.req.param("reservationId");
      const record = await service.getReservation(id);
      if (!record) {
        return c.json({ error: "NOT_FOUND" }, 404);
      }
      // Status is read-only — no writes
      return c.json({
        reservationId: record.reservationId,
        state: record.state,
        selectedOptionId: record.selected?.optionId ?? null,
        transactionId: record.transactionId,
        routeReserved: record.routeReserved !== null,
        failureCode: record.failureCode,
      });
    } catch (e) {
      return handleError(c, e);
    }
  });
}

async function payChallenge(
  c: {
    req: { param(name: string): string };
    json: (body: unknown, status?: number) => Response;
  },
  service: ReservationService,
  optionId: ReservationOptionId,
): Promise<Response> {
  try {
    const id = c.req.param("reservationId");
    const { challenge, record } = await service.issueChallenge(id, optionId);
    return c.json({
      reservationId: record.reservationId,
      state: record.state,
      optionId,
      challenge,
      note: "Demo reservation fee challenge — not freight price",
    });
  } catch (e) {
    return handleError(c, e);
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
): Promise<Response> {
  try {
    const id = c.req.param("reservationId");
    const body = (await c.req.json()) as {
      paymentPayloadHash?: string;
      httpStatus?: number;
    };
    if (!body.paymentPayloadHash) {
      return c.json({ error: "INVALID_BODY" }, 400);
    }
    const record = await service.submitPayment({
      reservationId: id,
      optionId,
      paymentPayloadHash: body.paymentPayloadHash,
      ...(body.httpStatus !== undefined
        ? { httpStatus: body.httpStatus }
        : {}),
    });
    return c.json({
      reservationId: record.reservationId,
      state: record.state,
      transactionId: record.transactionId,
      routeReserved: record.routeReserved,
      failureCode: record.failureCode,
    });
  } catch (e) {
    return handleError(c, e);
  }
}

function handleError(
  c: { json: (body: unknown, status?: number) => Response },
  e: unknown,
): Response {
  if (e instanceof ReservationError) {
    return c.json({ error: e.code, message: e.message }, errorStatus(e.code));
  }
  const message = e instanceof Error ? e.message : String(e);
  return c.json({ error: "INTERNAL", message }, 500);
}
