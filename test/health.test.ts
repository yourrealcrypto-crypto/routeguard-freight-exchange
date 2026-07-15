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
});