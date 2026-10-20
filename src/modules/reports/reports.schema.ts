import { z } from "zod";

export const messParams = z.object({ messId: z.uuid() });
export const monthParams = z.object({ messId: z.uuid(), monthId: z.uuid() });

export const trendsQuery = z.object({
  /** How many months back, the current one included. */
  months: z.coerce.number().int().min(2).max(24).default(6),
});

export const exportParams = monthParams.extend({ kind: z.enum(["summary", "bazars"]) });

export const statementExportParams = monthParams.extend({
  /** A member id, or "me". */
  memberId: z.union([z.literal("me"), z.uuid()]),
});
