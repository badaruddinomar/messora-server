import { z } from "zod";
import { dateString } from "../../utils/schemas.js";

export const dutiesQuery = z.object({ monthId: z.uuid().optional() });

export const generateDutiesSchema = z.object({
  monthId: z.uuid().optional(),
  /** Who shops, in rotation order. */
  memberIds: z.array(z.uuid()).min(1, "Pick at least one member").max(50),
  /** A bazar day every N days. */
  everyDays: z.number().int().min(1).max(7).default(1),
  /** How many members shop together on a bazar day. */
  perDay: z.number().int().min(1).max(3).default(1),
  /** First day to plan; defaults to today (or the month's first day, if later). */
  fromDate: dateString.optional(),
});

export const createDutySchema = z.object({ date: dateString, memberId: z.uuid() });

export const updateDutySchema = z
  .object({ date: dateString, memberId: z.uuid(), isDone: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

export const swapDutiesSchema = z
  .object({ dutyId: z.uuid(), otherDutyId: z.uuid() })
  .refine((v) => v.dutyId !== v.otherDutyId, { message: "Pick two different duties", path: ["otherDutyId"] });

export const dutyParams = z.object({ messId: z.uuid(), dutyId: z.uuid() });

export type GenerateDutiesInput = z.infer<typeof generateDutiesSchema>;
export type UpdateDutyInput = z.infer<typeof updateDutySchema>;
