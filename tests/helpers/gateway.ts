import { createHmac } from "node:crypto";
import { env } from "./env";

/**
 * Brief §5 signature, written independently of the app: every field except x_signature, sorted by
 * key (char code), `key+value`, joined by "|", HMAC-SHA256(GATEWAY_X_SIGNATURE_KEY), lowercase hex.
 */
export function gatewaySignature(fields: Record<string, string>, key: string = env.gatewayKey): string {
  const source = Object.keys(fields)
    .filter((k) => k !== "x_signature")
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => `${k}${fields[k]}`)
    .join("|");
  return createHmac("sha256", key).update(source).digest("hex");
}

/** "2026-04-01 00:30:12 +0800" for an instant (the gateway's paid_at format, Malaysia time). */
export function gatewayPaidAt(instant: Date): string {
  const myt = new Date(instant.getTime() + 8 * 3600 * 1000).toISOString();
  return `${myt.slice(0, 10)} ${myt.slice(11, 19)} +0800`;
}

/** A signed callback body like the brief's simulator; override any field via `extra`. */
export function signedCallback(
  billId: string,
  amountSen: number,
  paid: boolean,
  extra: Record<string, string> = {},
  key: string = env.gatewayKey,
): Record<string, string> {
  const fields: Record<string, string> = {
    id: billId,
    paid: paid ? "true" : "false",
    paid_amount: paid ? String(amountSen) : "0",
    paid_at: gatewayPaidAt(new Date("2026-04-01T00:30:12+08:00")),
    transaction_id: `TX-${billId.slice(0, 8)}`,
    transaction_status: paid ? "completed" : "failed",
    ...extra,
  };
  delete fields.x_signature;
  return { ...fields, x_signature: gatewaySignature(fields, key) };
}
