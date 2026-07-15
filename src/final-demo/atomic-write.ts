/**
 * Atomic write-then-rename for durable final-demo artifacts.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function atomicWriteJson(filePath: string, data: unknown): void {
  const absolute = path.resolve(filePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tmp, payload, { encoding: "utf8", flag: "w" });
  renameSync(tmp, absolute);
}

export function atomicWriteText(filePath: string, content: string): void {
  const absolute = path.resolve(filePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const tmp = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tmp, content, { encoding: "utf8", flag: "w" });
  renameSync(tmp, absolute);
}
