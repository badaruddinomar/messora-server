import { z } from "zod";

export const monthParams = z.object({ messId: z.uuid(), monthId: z.uuid() });

export const setMonthManagerSchema = z.object({
  /** MessMember id of the new manager, or null to clear. */
  managerId: z.uuid().nullable(),
});

export const statementParams = z.object({
  messId: z.uuid(),
  monthId: z.uuid(),
  /** A member id, or "me". */
  memberId: z.union([z.literal("me"), z.uuid()]),
});

export const closeMonthSchema = z.object({
  /** The month's `version` the closer reviewed (optimistic lock). */
  version: z.number().int().min(0),
});
