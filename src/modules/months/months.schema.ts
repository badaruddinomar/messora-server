import { z } from "zod";

export const monthParams = z.object({ messId: z.uuid(), monthId: z.uuid() });

export const setMonthManagerSchema = z.object({
  /** MessMember id of the new manager, or null to clear. */
  managerId: z.uuid().nullable(),
});
