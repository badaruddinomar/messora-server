import { z } from "zod";
import { isDateString } from "./date.js";

/** A calendar day, `YYYY-MM-DD` (BUSINESS_RULES §1). */
export const dateString = z.string().refine(isDateString, "Use a date like 2026-10-19");

/**
 * Money comes in as a decimal string ("1250.50") or a number, and is kept as a string so it never
 * passes through floating point on the way to Prisma.Decimal.
 */
export const money = z
  .union([z.string().trim(), z.number()])
  .transform(String)
  .pipe(z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, "Enter an amount like 1250 or 1250.50"))
  .refine((v) => Number(v) > 0, "Must be more than 0");
