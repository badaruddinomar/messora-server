import { ApprovalStatus } from "@prisma/client";
import { z } from "zod";
import { paginationQuery } from "../../utils/pagination.js";
import { dateString } from "../../utils/schemas.js";
import { mealSlotInput } from "../messes/messes.schema.js";

// ---------- slots ----------

export const createSlotSchema = mealSlotInput;
export const updateSlotSchema = mealSlotInput
  .extend({ sortOrder: z.number().int().min(0).max(20), isActive: z.boolean() })
  .partial();
export const slotParams = z.object({ messId: z.uuid(), slotId: z.uuid() });

// ---------- entries ----------

/** Meal counts go in half steps: half a meal is common for breakfast. */
const mealCount = (max: number) => z.number().min(0).max(max).multipleOf(0.5);

export const dayQuery = z.object({ date: dateString });

export const rangeQuery = z
  .object({ from: dateString, to: dateString })
  .refine((v) => v.from <= v.to, { message: "`from` must be on or before `to`", path: ["to"] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 62, {
    message: "Ask for at most 62 days at a time",
    path: ["to"],
  });

export const upsertEntriesSchema = z.object({
  entries: z
    .array(
      z.object({
        memberId: z.uuid(),
        slotId: z.uuid(),
        date: dateString,
        quantity: mealCount(5),
        guestQuantity: mealCount(10).default(0),
        note: z.string().trim().max(200).nullish(),
      }),
    )
    .min(1)
    .max(300),
});

export type UpsertEntriesInput = z.infer<typeof upsertEntriesSchema>;

// ---------- usual meals ----------

export const preferenceSchema = z.object({
  defaultMealOn: z.boolean(),
  /** Managers may set it for someone else; defaults to the caller. */
  memberId: z.uuid().optional(),
});

// ---------- meal-off periods ----------

/** A meal-off period covers at most 90 days; longer absences are better handled by leaving. */
export const MAX_OFF_DAYS = 90;

export const createOffPeriodSchema = z
  .object({
    memberId: z.uuid().optional(),
    fromDate: dateString,
    toDate: dateString,
    reason: z.string().trim().max(200).nullish(),
  })
  .refine((v) => v.fromDate <= v.toDate, {
    message: "The last day can't be before the first",
    path: ["toDate"],
  })
  .refine((v) => (Date.parse(v.toDate) - Date.parse(v.fromDate)) / 86_400_000 < MAX_OFF_DAYS, {
    message: `A meal-off can be at most ${MAX_OFF_DAYS} days`,
    path: ["toDate"],
  });

export const listOffPeriodsQuery = z.object({
  memberId: z.uuid().optional(),
  when: z.enum(["upcoming", "past"]).default("upcoming"),
});

export const offPeriodParams = z.object({ messId: z.uuid(), periodId: z.uuid() });

// ---------- meal requests ----------

export const createRequestSchema = z.object({
  date: dateString,
  slotId: z.uuid().nullish(),
  request: z.string().trim().min(2).max(300),
});

export const listRequestsQuery = paginationQuery.extend({
  status: z.enum(ApprovalStatus).optional(),
  date: dateString.optional(),
});

export const respondRequestSchema = z.object({
  status: z.enum([ApprovalStatus.APPROVED, ApprovalStatus.REJECTED]),
  response: z.string().trim().max(300).nullish(),
});

export const requestParams = z.object({ messId: z.uuid(), requestId: z.uuid() });

// ---------- daily menu ----------

export const upsertMenuSchema = z.object({
  date: dateString,
  slotId: z.uuid(),
  items: z.string().trim().min(2).max(300),
  note: z.string().trim().max(200).nullish(),
});

export const menuParams = z.object({ messId: z.uuid(), menuId: z.uuid() });

export type CreateOffPeriodInput = z.infer<typeof createOffPeriodSchema>;
export type ListOffPeriodsQuery = z.infer<typeof listOffPeriodsQuery>;
export type CreateRequestInput = z.infer<typeof createRequestSchema>;
export type ListRequestsQuery = z.infer<typeof listRequestsQuery>;
export type RespondRequestInput = z.infer<typeof respondRequestSchema>;
export type UpsertMenuInput = z.infer<typeof upsertMenuSchema>;
