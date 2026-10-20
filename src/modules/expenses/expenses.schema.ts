import { ExpenseCategory, PaidFrom, SplitType } from "@prisma/client";
import { z } from "zod";
import { paginationQuery } from "../../utils/pagination.js";
import { dateString, money } from "../../utils/schemas.js";

const shareSchema = z.object({ memberId: z.uuid(), amount: money });

const expenseFields = {
  category: z.enum(ExpenseCategory),
  title: z.string().trim().min(2, "Name the expense").max(80),
  amount: money,
  splitType: z.enum(SplitType).default(SplitType.EQUAL),
  paidFrom: z.enum(PaidFrom).default(PaidFrom.MESS_FUND),
  /** Who paid, when it was paid out of their own pocket; they're credited for it (BUSINESS_RULES §8). */
  paidByMemberId: z.uuid().nullish(),
  /** The bill's date (today or earlier); it decides the month. */
  billDate: dateString,
  receiptKey: z.string().max(200).nullish(),
  /** CUSTOM only: each member's share; they must add up to the amount. */
  shares: z.array(shareSchema).max(100).optional(),
};

const ownPocketNeedsPayer = (v: { paidFrom?: PaidFrom; paidByMemberId?: string | null }) =>
  v.paidFrom !== PaidFrom.OWN_POCKET || !!v.paidByMemberId;

export const createExpenseSchema = z
  .object(expenseFields)
  .refine(ownPocketNeedsPayer, { message: "Say who paid", path: ["paidByMemberId"] })
  .refine((v) => v.splitType !== SplitType.CUSTOM || (v.shares?.length ?? 0) > 0, {
    message: "Add each member's share",
    path: ["shares"],
  });

export const updateExpenseSchema = z
  .object({ ...expenseFields, splitType: z.enum(SplitType), paidFrom: z.enum(PaidFrom) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

export const payStaffSchema = z
  .object({
    staffId: z.uuid(),
    amount: money.optional(),
    billDate: dateString,
    splitType: z.enum(SplitType).default(SplitType.EQUAL),
    paidFrom: z.enum(PaidFrom).default(PaidFrom.MESS_FUND),
    paidByMemberId: z.uuid().nullish(),
    /** Paying the same person twice in a month needs to be confirmed (an advance, a bonus). */
    again: z.boolean().default(false),
  })
  .refine(ownPocketNeedsPayer, { message: "Say who paid", path: ["paidByMemberId"] });

export const splitPreviewSchema = z.object({
  billDate: dateString,
  amount: money,
  splitType: z.enum([SplitType.EQUAL, SplitType.BY_MEAL]),
});

export const expenseParams = z.object({ messId: z.uuid(), expenseId: z.uuid() });

export const listExpensesQuery = paginationQuery.extend({
  monthId: z.uuid().optional(),
  category: z.enum(ExpenseCategory).optional(),
});

export const expenseSummaryQuery = z.object({ monthId: z.uuid().optional() });

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
export type PayStaffInput = z.infer<typeof payStaffSchema>;
export type ListExpensesQuery = z.infer<typeof listExpensesQuery>;
