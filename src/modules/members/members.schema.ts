import { MemberStatus, MessRole } from "@prisma/client";
import { z } from "zod";

export const joinMessSchema = z.object({
  joinCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6,12}$/, "Enter a valid join code"),
});

export const memberParams = z.object({ messId: z.uuid(), memberId: z.uuid() });

export const listMembersQuery = z.object({
  status: z.enum(MemberStatus).default(MemberStatus.ACTIVE),
});

export const changeRoleSchema = z.object({ role: z.enum(MessRole) });

export const removeMemberSchema = z.object({
  reason: z.string().trim().max(200).optional(),
});

export const leaveMessSchema = removeMemberSchema;
