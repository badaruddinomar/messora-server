import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { env } from "../config/env.js";

export const generateToken = (bytes = 32) => randomBytes(bytes).toString("hex");

export const generateId = () => randomUUID();

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Numeric one-time code, e.g. "042917". */
export const generateOtp = (digits = 6) =>
  randomInt(0, 10 ** digits)
    .toString()
    .padStart(digits, "0");

/** OTPs have little entropy, so they are hashed with a server secret and bound to target + purpose. */
export const hashOtp = (target: string, purpose: string, code: string) =>
  createHmac("sha256", env.JWT_ACCESS_SECRET).update(`${target}:${purpose}:${code}`).digest("hex");

/** Short human-friendly code, e.g. for mess join codes. */
export const generateCode = (length = 8) => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
};

/**
 * `count` UUIDv7s that sort in the order they're returned (time prefix + sequence number), for child
 * rows like bazar items that must keep the order they were entered in.
 */
export function orderedIds(count: number) {
  const ms = BigInt(Date.now());
  return Array.from({ length: count }, (_, seq) => {
    const bytes = randomBytes(16);
    for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
    bytes[6] = 0x70 | ((seq >> 8) & 0x0f); // version 7 + high bits of the sequence
    bytes[7] = seq & 0xff;
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  });
}
