import { ChargeType } from "@prisma/client";
import { z } from "zod";

/** Signed money: an adjustment can be negative (a discount or a correction). */
const signedMoney = z
  .union([z.string().trim(), z.number()])
  .transform(String)
  .pipe(z.string().regex(/^-?\d{1,10}(\.\d{1,2})?$/, "Enter an amount like 250 or -100"))
  .refine((v) => Number(v) !== 0, "Can't be 0");

export const chargeTypes = [ChargeType.FINE, ChargeType.PERSONAL, ChargeType.ADJUSTMENT] as const;

const onlyAdjustmentsNegative = (v: { type?: ChargeType; amount?: string }) =>
  v.type === undefined ||
  v.type === ChargeType.ADJUSTMENT ||
  v.amount === undefined ||
  !v.amount.startsWith("-");

export const createChargeSchema = z
  .object({
    /** Defaults to the current month. */
    monthId: z.uuid().optional(),
    memberId: z.uuid(),
    /** Seat rent is charged by the app when a month closes (BUSINESS_RULES §6). */
    type: z.enum(chargeTypes),
    amount: signedMoney,
    description: z.string().trim().min(2, "Say what it's for").max(200),
  })
  .refine(onlyAdjustmentsNegative, { message: "Only an adjustment can be negative", path: ["amount"] });

export const updateChargeSchema = z
  .object({ amount: signedMoney, description: z.string().trim().min(2).max(200) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

export const listChargesQuery = z.object({ monthId: z.uuid().optional(), memberId: z.uuid().optional() });

export const chargeParams = z.object({ messId: z.uuid(), chargeId: z.uuid() });

export type CreateChargeInput = z.infer<typeof createChargeSchema>;
export type UpdateChargeInput = z.infer<typeof updateChargeSchema>;
