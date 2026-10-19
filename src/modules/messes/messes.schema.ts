import { MessGender } from "@prisma/client";
import { z } from "zod";
import { MAX_MONTH_START_DAY, MIN_MONTH_START_DAY } from "../months/month-period.js";

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use the HH:mm format, e.g. 10:30");

const timeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Unknown timezone");

export const mealSlotInput = z.object({
  name: z.string().trim().min(1).max(30),
  weight: z.coerce.number().min(0.25).max(5).multipleOf(0.25),
  cutoffTime: timeOfDay.nullish(),
});

export const DEFAULT_MEAL_SLOTS: z.infer<typeof mealSlotInput>[] = [
  { name: "Breakfast", weight: 0.5, cutoffTime: "07:00" },
  { name: "Lunch", weight: 1, cutoffTime: "10:00" },
  { name: "Dinner", weight: 1, cutoffTime: "17:00" },
];

const messDetails = {
  name: z.string().trim().min(2).max(60),
  address: z.string().trim().max(200).nullish(),
  gender: z.enum(MessGender).default(MessGender.MALE),
  monthStartDay: z.coerce.number().int().min(MIN_MONTH_START_DAY).max(MAX_MONTH_START_DAY).default(1),
  timezone: timeZone.default("Asia/Dhaka"),
};

export const createMessSchema = z.object({
  ...messDetails,
  mealSlots: z
    .array(mealSlotInput)
    .min(1)
    .max(6)
    .refine((slots) => new Set(slots.map((s) => s.name.toLowerCase())).size === slots.length, {
      message: "Meal names must be unique",
    })
    .default(DEFAULT_MEAL_SLOTS),
});

export const updateMessSchema = z
  .object({
    name: messDetails.name,
    address: messDetails.address,
    gender: z.enum(MessGender),
    monthStartDay: z.coerce.number().int().min(MIN_MONTH_START_DAY).max(MAX_MONTH_START_DAY),
    timezone: timeZone,
  })
  .partial();

export const updateSettingsSchema = z
  .object({
    autoGenerateMeals: z.boolean(),
    allowMemberMealEdit: z.boolean(),
    allowGuestMeal: z.boolean(),
    requireBazarApproval: z.boolean(),
    requireDepositApproval: z.boolean(),
    prorateSeatRent: z.boolean(),
    mealRateDecimals: z.number().int().min(0).max(4),
    dueReminderDay: z.number().int().min(1).max(28).nullable(),
  })
  .partial();

export const deleteMessSchema = z.object({
  /** The mess name, typed by the admin to confirm. */
  confirmName: z.string().trim(),
});

export const messIdParams = z.object({ messId: z.uuid() });

export type CreateMessInput = z.infer<typeof createMessSchema>;
export type UpdateMessInput = z.infer<typeof updateMessSchema>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
