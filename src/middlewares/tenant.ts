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

    let isMonthManager = false;
    const hasRole = !options.roles || options.roles.includes(member.role);
    if (!hasRole && options.allowMonthManager) {
      const managedMonth = await prisma.messMonth.findFirst({
        where: { messId: member.messId, status: MonthStatus.OPEN, managerId: member.id },
        select: { id: true },
      });
      isMonthManager = !!managedMonth;
    }
    if (!hasRole && !isMonthManager) {
      throw ApiError.forbidden("You don't have permission to do this", ERROR_CODES.INSUFFICIENT_ROLE);
    }

    req.membership = { ...member, isMonthManager };
    next();
  };
