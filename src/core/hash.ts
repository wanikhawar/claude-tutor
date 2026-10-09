import { createHash } from "node:crypto";

export function sha256(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}
