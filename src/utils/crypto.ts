import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { env } from "../config/env.js";

export const generateToken = (bytes = 32) => randomBytes(bytes).toString("hex");

export const generateId = () => randomUUID();

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Numeric one-time code, e.g. "042917". */
export const generateOtp = (digits = 6) => randomInt(0, 10 ** digits).toString().padStart(digits, "0");

/** OTPs have little entropy, so they are hashed with a server secret and bound to target + purpose. */
export const hashOtp = (target: string, purpose: string, code: string) =>
  createHmac("sha256", env.JWT_ACCESS_SECRET).update(`${target}:${purpose}:${code}`).digest("hex");

/** Short human-friendly code, e.g. for mess join codes. */
export const generateCode = (length = 8) => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
};
