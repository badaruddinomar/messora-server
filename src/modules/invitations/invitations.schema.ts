import { MessRole } from "@prisma/client";
import { z } from "zod";
import { emailField, phoneField } from "../auth/auth.schema.js";

export const createInvitationSchema = z
  .object({
    email: emailField.optional(),
    phone: phoneField.optional(),
    // Admins are made by promoting an existing member, never by invite.
    role: z.enum([MessRole.MEMBER, MessRole.MANAGER]).default(MessRole.MEMBER),
  })
  .refine((v) => v.email || v.phone, { message: "Enter a phone number or an email", path: ["phone"] });

export const invitationIdParams = z.object({ messId: z.uuid(), invitationId: z.uuid() });
export const receivedInvitationParams = z.object({ invitationId: z.uuid() });
export const tokenParams = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/, "Invalid invitation link") });

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
