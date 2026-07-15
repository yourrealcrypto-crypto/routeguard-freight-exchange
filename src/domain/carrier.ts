import { z } from "zod";

import { isSafePositiveInteger } from "./money";
import { isValidHederaAccountId } from "./payment-option";

/** Compressed ECDSA secp256k1 public key: 33 bytes → 66 hex chars. */
const ECDSA_PUBKEY_HEX_RE = /^(02|03)[0-9a-f]{64}$/i;

export const CarrierRecordSchema = z
  .object({
    carrierId: z.string().min(1).max(128),
    carrierAccountId: z.string().min(1),
    signingPublicKey: z.string().min(1),
    active: z.boolean(),
    allowedEquipment: z.array(z.string().min(1)).min(1),
    registryVersion: z.number(),
  })
  .superRefine((value, ctx) => {
    if (!isValidHederaAccountId(value.carrierAccountId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "carrierAccountId must be a valid Hedera account ID",
        path: ["carrierAccountId"],
      });
    }
    if (!ECDSA_PUBKEY_HEX_RE.test(value.signingPublicKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "signingPublicKey must be a compressed ECDSA secp256k1 hex public key",
        path: ["signingPublicKey"],
      });
    }
    if (!isSafePositiveInteger(value.registryVersion)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "registryVersion must be a positive safe integer",
        path: ["registryVersion"],
      });
    }
  });

export type CarrierRecord = z.infer<typeof CarrierRecordSchema>;

export function parseCarrierRecord(input: unknown): CarrierRecord {
  return CarrierRecordSchema.parse(input);
}

export interface CarrierRegistry {
  getById(carrierId: string): CarrierRecord | undefined;
  listActive(): readonly CarrierRecord[];
}

export class InMemoryCarrierRegistry implements CarrierRegistry {
  private readonly byId: ReadonlyMap<string, CarrierRecord>;

  constructor(records: readonly CarrierRecord[]) {
    const map = new Map<string, CarrierRecord>();
    for (const raw of records) {
      const record = parseCarrierRecord(raw);
      if (map.has(record.carrierId)) {
        throw new Error(`Duplicate carrierId in registry: ${record.carrierId}`);
      }
      const frozen: CarrierRecord = {
        ...record,
        allowedEquipment: [...record.allowedEquipment],
        signingPublicKey: record.signingPublicKey.toLowerCase(),
      };
      Object.freeze(frozen.allowedEquipment);
      Object.freeze(frozen);
      map.set(record.carrierId, frozen);
    }
    this.byId = map;
  }

  getById(carrierId: string): CarrierRecord | undefined {
    return this.byId.get(carrierId);
  }

  listActive(): readonly CarrierRecord[] {
    return [...this.byId.values()].filter((r) => r.active);
  }
}
