/**
 * Private carrier-bid body store.
 *
 * Bid bodies carry the freight amount and the commitment salt. They are never
 * public evidence, never returned in an HTTP response, and never written into
 * the lifecycle record — the record holds only the salted commitment hash.
 *
 * Bodies are content-addressed by their salted bid hash, so writing the same
 * body twice is idempotent and a stored body can never silently disagree with
 * the commitment that the lifecycle record committed to.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  parseV2CarrierBid,
  signedV2BidEnvelopeHash,
  v2BidHash,
  type SignedV2CarrierBid,
} from "../schemas/bid";

export type StoredBidBody = {
  readonly bidHash: string;
  readonly signedBidEnvelopeHash: string;
  readonly signed: SignedV2CarrierBid;
  readonly storedAt: string;
};

export class BidBodyConflictError extends Error {
  readonly code = "BID_BODY_CONFLICT" as const;

  constructor(bidId: string) {
    super(`A different private bid body is already stored for bid "${bidId}"`);
    this.name = "BidBodyConflictError";
  }
}

export interface BidBodyStore {
  /**
   * Store a private bid body. Idempotent for an identical body; a different
   * body for the same tender/bid fails closed.
   */
  put(input: {
    tenderId: string;
    tenderVersion: number;
    signed: SignedV2CarrierBid;
    storedAt: string;
  }): Promise<StoredBidBody>;

  get(
    tenderId: string,
    tenderVersion: number,
    bidId: string,
  ): Promise<StoredBidBody | null>;
}

function safeSegment(label: string, value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} is not a filesystem-safe identifier`);
  }
  return value;
}

function bodyKey(tenderId: string, tenderVersion: number, bidId: string): string {
  return `${tenderId}|${tenderVersion}|${bidId}`;
}

function buildStored(
  signed: SignedV2CarrierBid,
  storedAt: string,
): StoredBidBody {
  const bid = parseV2CarrierBid(signed.bid);
  const normalized: SignedV2CarrierBid = { bid, signature: signed.signature };
  return {
    bidHash: v2BidHash(bid),
    signedBidEnvelopeHash: signedV2BidEnvelopeHash(normalized),
    signed: normalized,
    storedAt,
  };
}

function assertMatchesTender(
  signed: SignedV2CarrierBid,
  tenderId: string,
  tenderVersion: number,
): void {
  if (
    signed.bid.tenderId !== tenderId ||
    signed.bid.tenderVersion !== tenderVersion
  ) {
    throw new Error("bid body does not belong to this tender version");
  }
}

export class InMemoryBidBodyStore implements BidBodyStore {
  private readonly bodies = new Map<string, StoredBidBody>();

  async put(input: {
    tenderId: string;
    tenderVersion: number;
    signed: SignedV2CarrierBid;
    storedAt: string;
  }): Promise<StoredBidBody> {
    assertMatchesTender(input.signed, input.tenderId, input.tenderVersion);
    const stored = buildStored(input.signed, input.storedAt);
    const key = bodyKey(
      input.tenderId,
      input.tenderVersion,
      input.signed.bid.bidId,
    );
    const existing = this.bodies.get(key);
    if (existing) {
      if (
        existing.signedBidEnvelopeHash !== stored.signedBidEnvelopeHash
      ) {
        throw new BidBodyConflictError(input.signed.bid.bidId);
      }
      return existing;
    }
    this.bodies.set(key, stored);
    return stored;
  }

  async get(
    tenderId: string,
    tenderVersion: number,
    bidId: string,
  ): Promise<StoredBidBody | null> {
    return this.bodies.get(bodyKey(tenderId, tenderVersion, bidId)) ?? null;
  }
}

/**
 * Filesystem bid-body store. One file per tender version + bid id, written
 * through a unique temp file and an atomic rename.
 */
export class FileBidBodyStore implements BidBodyStore {
  constructor(private readonly baseDir: string) {
    mkdirSync(this.baseDir, { recursive: true });
  }

  private filePath(
    tenderId: string,
    tenderVersion: number,
    bidId: string,
  ): string {
    safeSegment("tenderId", tenderId);
    safeSegment("bidId", bidId);
    if (!Number.isSafeInteger(tenderVersion) || tenderVersion < 1) {
      throw new Error("tenderVersion must be a positive safe integer");
    }
    return path.join(
      this.baseDir,
      `bid-${tenderId}-v${tenderVersion}-${bidId}.json`,
    );
  }

  async put(input: {
    tenderId: string;
    tenderVersion: number;
    signed: SignedV2CarrierBid;
    storedAt: string;
  }): Promise<StoredBidBody> {
    assertMatchesTender(input.signed, input.tenderId, input.tenderVersion);
    const stored = buildStored(input.signed, input.storedAt);
    const existing = await this.get(
      input.tenderId,
      input.tenderVersion,
      input.signed.bid.bidId,
    );
    if (existing) {
      if (existing.signedBidEnvelopeHash !== stored.signedBidEnvelopeHash) {
        throw new BidBodyConflictError(input.signed.bid.bidId);
      }
      return existing;
    }

    const fp = this.filePath(
      input.tenderId,
      input.tenderVersion,
      input.signed.bid.bidId,
    );
    const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify(stored, null, 2)}\n`;
    const fd = openSync(tmp, "wx");
    try {
      writeSync(fd, payload, null, "utf8");
      try {
        fsyncSync(fd);
      } catch {
        // best effort
      }
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, fp);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // nothing owned to clean up
      }
      throw err;
    }
    return stored;
  }

  async get(
    tenderId: string,
    tenderVersion: number,
    bidId: string,
  ): Promise<StoredBidBody | null> {
    const fp = this.filePath(tenderId, tenderVersion, bidId);
    let raw: string;
    try {
      raw = readFileSync(fp, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
    const parsed = JSON.parse(raw) as { signed?: unknown; storedAt?: unknown };
    const signed = parsed.signed as SignedV2CarrierBid | undefined;
    if (
      !signed ||
      typeof signed !== "object" ||
      typeof (signed as { signature?: unknown }).signature !== "string"
    ) {
      throw new Error("stored bid body is malformed");
    }
    const storedAt =
      typeof parsed.storedAt === "string" ? parsed.storedAt : "";
    // Re-derive hashes rather than trusting the stored values.
    return buildStored(signed, storedAt);
  }
}
