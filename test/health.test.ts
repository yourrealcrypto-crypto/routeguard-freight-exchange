import { describe, expect, it } from "vitest";
import app from "../src/server/app";

describe("RouteGuard server", () => {
  it("returns a healthy testnet-only status", async () => {
    const response = await app.request("/api/health");

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body).toEqual({
      status: "ok",
      service: "routeguard-freight-exchange",
      network: "hedera:testnet",
      livePaymentsEnabled: false,
    });
  });
it("keeps the HBAR x402 smoke route disabled by default", async () => {
  const response = await app.request(
    "/api/x402/hbar-smoke",
  );

  expect(response.status).toBe(503);

  const body = await response.json();

  expect(body).toEqual({
    error: "HBAR smoke challenge publication is disabled.",
    code: "LIVE_HBAR_DISABLED",
    network: "hedera:testnet",
  });
});
  it("serves the initial development page", async () => {
    const response = await app.request("/");

    expect(response.status).toBe(200);

    const html = await response.text();

    expect(html).toContain("RouteGuard Freight Exchange");
    expect(html).toContain("DEVELOPMENT SHELL");
    expect(html).toContain("LIVE PAYMENTS DISABLED");
  });
});
