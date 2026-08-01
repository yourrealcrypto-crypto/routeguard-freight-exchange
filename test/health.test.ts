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

  it("keeps the USDC x402 smoke route disabled by default", async () => {
    const response = await app.request(
      "/api/x402/usdc-smoke",
    );

    expect(response.status).toBe(503);

    const body = await response.json();

    expect(body).toEqual({
      error: "USDC smoke challenge publication is disabled.",
      code: "LIVE_USDC_DISABLED",
      network: "hedera:testnet",
    });
  });

  it("serves every production product route as HTML", async () => {
    for (const path of ["/", "/proof", "/control", "/judge", "/pod-review"]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("RouteGuard Freight Exchange");
    }
  });

  it("keeps the legacy Operations Demo route as a permanent alias", async () => {
    const response = await app.request("/operations-demo");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/control");
  });

  it("does not let the SPA fallback consume unknown API routes", async () => {
    const response = await app.request("/api/not-a-route");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND", message: "Route not found" });
  });
});
