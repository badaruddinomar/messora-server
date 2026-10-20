import type { RequestHandler } from "express";
import { MemberStatus, MessRole, MonthStatus } from "@prisma/client";
import { z } from "zod";
import { ERROR_CODES } from "../constants/error-codes.js";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../utils/api-error.js";

const messIdParam = z.uuid();

interface RequireMessMemberOptions {
  /** Roles allowed through. Omit to allow any active member. */
  roles?: readonly MessRole[];
  /** Also allow the assigned manager of the mess's OPEN month (BUSINESS_RULES §2). */
  allowMonthManager?: boolean;
}

/** Shortcut for the manager-level permission set: ADMIN, MANAGER and the month's manager. */
export const MANAGER_ACCESS = {
  roles: [MessRole.ADMIN, MessRole.MANAGER],
  allowMonthManager: true,
} as const satisfies RequireMessMemberOptions;

export const ADMIN_ONLY = { roles: [MessRole.ADMIN] } as const satisfies RequireMessMemberOptions;

/** The caller's membership on mess-scoped routes (set by `requireMessMember`). */
export type Membership = NonNullable<Express.Request["membership"]>;

/**
 * A month manager has manager powers while their month is OPEN, and while it's being closed so they
 * can finish closing it (BUSINESS_RULES §2, §3).
 */
export const MANAGED_STATUSES: MonthStatus[] = [MonthStatus.OPEN, MonthStatus.CLOSING];

/** Manager-level powers: ADMIN, MANAGER, or manager of an OPEN or CLOSING month (BUSINESS_RULES §2). */
export const hasManagerAccess = (m: Pick<Membership, "role" | "isMonthManager">) =>
  m.role === MessRole.ADMIN || m.role === MessRole.MANAGER || m.isMonthManager;

/** `req.membership` for handlers behind `requireMessMember`. */
export function membershipOf(req: Express.Request): Membership {
  if (!req.membership) throw new Error("requireMessMember must run before this handler");
  return req.membership;
}

/**
 * Loads the caller's membership for `:messId` and sets `req.membership`.
 * Must run after `requireAuth`. Responds 404 for messes the user doesn't belong to (so a mess's
 * existence isn't leaked), and 403 for inactive members or missing roles.
 */
export const requireMessMember =
  (options: RequireMessMemberOptions = {}): RequestHandler =>
  async (req, _res, next) => {
    if (!req.user) throw ApiError.unauthorized();

    const messId = messIdParam.safeParse(req.params.messId);
    if (!messId.success) throw ApiError.notFound("Mess not found", ERROR_CODES.NOT_A_MEMBER);

    const member = await prisma.messMember.findFirst({
      where: { messId: messId.data, userId: req.user.id, mess: { isActive: true, deletedAt: null } },
      select: { id: true, messId: true, userId: true, role: true, status: true },
    });
    if (!member) throw ApiError.notFound("Mess not found", ERROR_CODES.NOT_A_MEMBER);
    if (member.status !== MemberStatus.ACTIVE) {
      throw ApiError.forbidden("Your membership in this mess is not active", ERROR_CODES.MEMBERSHIP_INACTIVE);
    }

    // ADMIN/MANAGER already have manager powers, so only plain members need the month lookup.
    const isMonthManager =
      member.role === MessRole.MEMBER &&
      !!(await prisma.messMonth.findFirst({
        where: { messId: member.messId, status: { in: MANAGED_STATUSES }, managerId: member.id },
        select: { id: true },
      }));

    const hasRole = !options.roles || options.roles.includes(member.role);
    if (!hasRole && !(options.allowMonthManager && isMonthManager)) {
      throw ApiError.forbidden("You don't have permission to do this", ERROR_CODES.INSUFFICIENT_ROLE);
    }

    req.membership = { ...member, isMonthManager };
    next();
  };
