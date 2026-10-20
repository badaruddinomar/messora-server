import { HandoverStatus, PaymentMethod } from "@prisma/client";
import { z } from "zod";
import { dateString, money } from "../../utils/schemas.js";

export const recordSettlementSchema = z.object({
  memberId: z.uuid(),
  amount: money,
  method: z.enum(PaymentMethod).default(PaymentMethod.CASH),
  transactionRef: z.string().trim().max(60).nullish(),
  note: z.string().trim().max(200).nullish(),
  /** When the money changed hands; defaults to today. */
  date: dateString.optional(),
});

export const listSettlementsQuery = z.object({ status: z.enum(["settled", "unsettled"]).optional() });

export const settlementParams = z.object({ messId: z.uuid(), settlementId: z.uuid() });

export const createHandoverSchema = z.object({
  toMemberId: z.uuid(),
  handedAmount: z
    .union([z.string().trim(), z.number()])
    .transform(String)
    .pipe(z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, "Enter an amount like 5000 or 0")),
  note: z.string().trim().max(300).nullish(),
});

export const respondHandoverSchema = z.object({
  status: z.enum([HandoverStatus.CONFIRMED, HandoverStatus.DISPUTED]),
  note: z.string().trim().max(300).nullish(),
});

export const handoverParams = z.object({ messId: z.uuid(), handoverId: z.uuid() });

export type RecordSettlementInput = z.infer<typeof recordSettlementSchema>;
export type CreateHandoverInput = z.infer<typeof createHandoverSchema>;
export type RespondHandoverInput = z.infer<typeof respondHandoverSchema>;
