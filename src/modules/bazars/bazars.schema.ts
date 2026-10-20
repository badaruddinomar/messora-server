import { ApprovalStatus, PaidFrom } from "@prisma/client";
import { z } from "zod";
import { paginationQuery } from "../../utils/pagination.js";
import { dateString } from "../meals/meals.schema.js";

/**
 * Money comes in as a decimal string ("1250.50") or a number, and is kept as a string so it never
 * passes through floating point on the way to Prisma.Decimal.
 */
export const money = z
  .union([z.string().trim(), z.number()])
  .transform(String)
  .pipe(z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, "Enter an amount like 1250 or 1250.50"))
  .refine((v) => Number(v) > 0, "Must be more than 0");

const quantity = z
  .union([z.string().trim(), z.number()])
  .transform(String)
  .pipe(z.string().regex(/^\d{1,7}(\.\d{1,3})?$/, "Enter a quantity like 2 or 1.5"))
  .refine((v) => Number(v) > 0, "Must be more than 0");

export const bazarItemSchema = z.object({
  name: z.string().trim().min(1, "Name the item").max(60),
  quantity: quantity.nullish(),
  unit: z.string().trim().max(15).nullish(),
  totalPrice: money,
});

const bazarFields = {
  date: dateString,
  /** Managers can record a bazar for someone else; members only for themselves. */
  shopperId: z.uuid().optional(),
  paidFrom: z.enum(PaidFrom).default(PaidFrom.MESS_FUND),
  /** Itemised bazars: the total is the sum of the items. A quick bazar sends only `totalAmount`. */
  items: z.array(bazarItemSchema).max(100).default([]),
  totalAmount: money.optional(),
  /** From POST /uploads; null removes the receipt. */
  receiptKey: z.string().max(200).nullish(),
  note: z.string().trim().max(300).nullish(),
};

export const createBazarSchema = z
  .object(bazarFields)
  .refine((v) => v.items.length > 0 || v.totalAmount !== undefined, {
    message: "Add items or the total amount",
    path: ["totalAmount"],
  });

export const updateBazarSchema = z
  .object({ ...bazarFields, paidFrom: z.enum(PaidFrom), items: z.array(bazarItemSchema).max(100) })
  .partial();

export const rejectBazarSchema = z.object({
  reason: z.string().trim().min(3, "Say why, so they can fix it").max(300),
});

export const bazarParams = z.object({ messId: z.uuid(), bazarId: z.uuid() });

export const listBazarsQuery = paginationQuery.extend({
  monthId: z.uuid().optional(),
  status: z.enum(ApprovalStatus).optional(),
  shopperId: z.uuid().optional(),
  paidFrom: z.enum(PaidFrom).optional(),
});

export const summaryQuery = z.object({ monthId: z.uuid().optional() });

export type BazarItemInput = z.infer<typeof bazarItemSchema>;
export type CreateBazarInput = z.infer<typeof createBazarSchema>;
export type UpdateBazarInput = z.infer<typeof updateBazarSchema>;
export type ListBazarsQuery = z.infer<typeof listBazarsQuery>;
