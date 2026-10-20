import { ApprovalStatus, PaymentMethod } from "@prisma/client";
import { z } from "zod";
import { paginationQuery } from "../../utils/pagination.js";
import { dateString, money } from "../../utils/schemas.js";

const depositFields = {
  /** The day the money was paid; today or earlier. */
  date: dateString,
  /** Managers can record a deposit for someone else; members only for themselves. */
  memberId: z.uuid().optional(),
  amount: money,
  method: z.enum(PaymentMethod).default(PaymentMethod.CASH),
  /** bKash/Nagad/bank transaction id, so the manager can match it. */
  transactionRef: z.string().trim().max(60).nullish(),
  note: z.string().trim().max(300).nullish(),
};

export const createDepositSchema = z.object(depositFields);

export const updateDepositSchema = z
  .object({ ...depositFields, method: z.enum(PaymentMethod) })
  .omit({ memberId: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

export const rejectDepositSchema = z.object({
  reason: z.string().trim().min(3, "Say why, so they can fix it").max(300),
});

export const depositParams = z.object({ messId: z.uuid(), depositId: z.uuid() });

export const listDepositsQuery = paginationQuery.extend({
  monthId: z.uuid().optional(),
  status: z.enum(ApprovalStatus).optional(),
  memberId: z.uuid().optional(),
  method: z.enum(PaymentMethod).optional(),
});

export const summaryQuery = z.object({ monthId: z.uuid().optional() });

export type CreateDepositInput = z.infer<typeof createDepositSchema>;
export type UpdateDepositInput = z.infer<typeof updateDepositSchema>;
export type ListDepositsQuery = z.infer<typeof listDepositsQuery>;
