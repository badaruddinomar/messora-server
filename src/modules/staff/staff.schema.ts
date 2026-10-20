import { StaffRole } from "@prisma/client";
import { z } from "zod";
import { money } from "../../utils/schemas.js";

export const staffSchema = z.object({
  name: z.string().trim().min(2, "Enter their name").max(60),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[\d\s()-]{8,20}$/, "Enter a valid phone number")
    .nullish()
    .or(z.literal("").transform(() => null)),
  role: z.enum(StaffRole),
  monthlySalary: money,
});

export const updateStaffSchema = staffSchema.extend({ isActive: z.boolean() }).partial();

export const staffParams = z.object({ messId: z.uuid(), staffId: z.uuid() });

export type StaffInput = z.infer<typeof staffSchema>;
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;
