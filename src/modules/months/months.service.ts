import { MemberStatus, MonthStatus, NotificationType, type MessMonth, type Prisma } from "@prisma/client";
import { ERROR_CODES } from "../../constants/error-codes.js";
import { audit } from "../../lib/audit.js";
import { notify } from "../../lib/notify.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import type { Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { fromDbDate, todayIn, toDbDate, type DateString } from "../../utils/date.js";
import { periodAfter, periodContaining } from "./month-period.js";

// ---------- DTO ----------

const monthInclude = {
  manager: { select: { id: true, user: { select: { name: true, avatarUrl: true } } } },
} satisfies Prisma.MessMonthInclude;

type MonthRow = Prisma.MessMonthGetPayload<{ include: typeof monthInclude }>;

function toMonthDto(month: MonthRow, today: DateString) {
  const startDate = fromDbDate(month.startDate);
  const endDate = fromDbDate(month.endDate);
  return {
    id: month.id,
    year: month.year,
    month: month.month,
    startDate,
    endDate,
    status: month.status,
    /** Today falls inside this month. */
    isCurrent: startDate <= today && today <= endDate,
    /** The month is over but hasn't been closed yet. */
    hasEnded: endDate < today,
    closedAt: month.closedAt,
    manager: month.manager
      ? { memberId: month.manager.id, name: month.manager.user.name, avatarUrl: month.manager.user.avatarUrl }
      : null,
  };
}

export type MonthDto = ReturnType<typeof toMonthDto>;

// ---------- opening months ----------

async function messCalendar(db: DbClient, messId: string) {
  const mess = await db.mess.findUniqueOrThrow({
    where: { id: messId },
    select: { timezone: true, monthStartDay: true },
  });
  return { ...mess, today: todayIn(mess.timezone) };
}

/**
 * Makes sure the billing month containing today exists (BUSINESS_RULES §3). Months open on their
 * own as time passes, so meals and bazar can be recorded on the 1st even if last month isn't closed
 * yet. If nobody used the mess for a while, every month in between is created, so there are no gaps.
 * Safe to call concurrently: duplicate months are skipped by the (mess, year, month) unique key.
 */
export async function ensureCurrentMonth(db: DbClient, messId: string) {
  const { today, monthStartDay } = await messCalendar(db, messId);
  const latest = await db.messMonth.findFirst({ where: { messId }, orderBy: { startDate: "desc" } });

  const toCreate = [];
  let period = latest
    ? { endDate: fromDbDate(latest.endDate) }
    : // Only happens for messes created without a month; start with the one containing today.
      null;
  if (!period) {
    const first = periodContaining(today, monthStartDay);
    toCreate.push(first);
    period = first;
  }
  while (period.endDate < today) {
    const next = periodAfter(period.endDate, monthStartDay);
    toCreate.push(next);
    period = next;
  }

  if (toCreate.length > 0) {
    await db.messMonth.createMany({
      data: toCreate.map((p) => ({
        messId,
        year: p.year,
        month: p.month,
        startDate: toDbDate(p.startDate),
        endDate: toDbDate(p.endDate),
      })),
      skipDuplicates: true,
    });
  }
  return today;
}

/**
 * The month a dated record (meal, bazar, deposit…) belongs to. Throws when the date is before the
 * mess's first month or after the current one.
 */
export async function monthForDate(db: DbClient, messId: string, date: DateString) {
  await ensureCurrentMonth(db, messId);
  const month = await db.messMonth.findFirst({
    where: { messId, startDate: { lte: toDbDate(date) }, endDate: { gte: toDbDate(date) } },
  });
  if (!month) {
    throw ApiError.unprocessable(
      "That date isn't in any of this mess's billing months",
      ERROR_CODES.DATE_OUTSIDE_MONTHS,
    );
  }
  return month;
}

/** Every meal or money change goes through this: only OPEN months can be edited (BUSINESS_RULES §3). */
export function assertMonthEditable(month: Pick<MessMonth, "status">) {
  if (month.status !== MonthStatus.OPEN) {
    throw ApiError.unprocessable(
      month.status === MonthStatus.CLOSING
        ? "This month is being closed, so it can't be changed"
        : "This month is closed, so it can't be changed",
      ERROR_CODES.MONTH_CLOSED,
    );
  }
}

/**
 * Months are closed in order: a month can only start closing once every earlier month is closed.
 * Used by the close flow (Phase 8).
 */
export async function assertEarlierMonthsClosed(
  db: DbClient,
  month: Pick<MessMonth, "messId" | "startDate">,
) {
  const earlierOpen = await db.messMonth.count({
    where: { messId: month.messId, startDate: { lt: month.startDate }, status: { not: MonthStatus.CLOSED } },
  });
  if (earlierOpen > 0) {
    throw ApiError.unprocessable("Close the earlier months first", ERROR_CODES.MONTHS_OUT_OF_ORDER);
  }
}

// ---------- use cases ----------

export async function listMonths(membership: Membership) {
  const today = await ensureCurrentMonth(prisma, membership.messId);
  const months = await prisma.messMonth.findMany({
    where: { messId: membership.messId },
    include: monthInclude,
    orderBy: { startDate: "desc" },
  });
  return months.map((m) => toMonthDto(m, today));
}

export async function getCurrentMonth(membership: Membership) {
  const today = await ensureCurrentMonth(prisma, membership.messId);
  const month = await prisma.messMonth.findFirstOrThrow({
    where: {
      messId: membership.messId,
      startDate: { lte: toDbDate(today) },
      endDate: { gte: toDbDate(today) },
    },
    include: monthInclude,
  });
  return toMonthDto(month, today);
}

async function findMonth(db: DbClient, messId: string, monthId: string) {
  const month = await db.messMonth.findFirst({ where: { id: monthId, messId }, include: monthInclude });
  if (!month) throw ApiError.notFound("Month not found");
  return month;
}

export async function getMonth(membership: Membership, monthId: string) {
  const today = await ensureCurrentMonth(prisma, membership.messId);
  return toMonthDto(await findMonth(prisma, membership.messId, monthId), today);
}

/** Assigns (or clears) the member who manages a month. They get manager powers while it's open. */
export async function setMonthManager(membership: Membership, monthId: string, memberId: string | null) {
  return prisma.$transaction(async (tx) => {
    const month = await findMonth(tx, membership.messId, monthId);
    if (month.status === MonthStatus.CLOSED) {
      throw ApiError.unprocessable("A closed month's manager can't be changed", ERROR_CODES.MONTH_CLOSED);
    }

    let managerUserId: string | null = null;
    if (memberId) {
      const member = await tx.messMember.findFirst({
        where: { id: memberId, messId: membership.messId, status: MemberStatus.ACTIVE },
        select: { userId: true },
      });
      if (!member) throw ApiError.notFound("Member not found");
      managerUserId = member.userId;
    }

    const updated = await tx.messMonth.update({
      where: { id: month.id },
      data: { managerId: memberId },
      include: monthInclude,
    });

    if (managerUserId && managerUserId !== membership.userId) {
      await notify(tx, {
        userIds: [managerUserId],
        messId: membership.messId,
        type: NotificationType.ROLE_CHANGED,
        title: "You're this month's manager",
        body: `You'll manage meals, bazar and deposits for ${monthLabel(month)}`,
        entity: "MessMonth",
        entityId: month.id,
      });
    }
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "MONTH_MANAGER_CHANGED",
      entity: "MessMonth",
      entityId: month.id,
      before: { managerId: month.managerId },
      after: { managerId: memberId },
    });

    const { today } = await messCalendar(tx, membership.messId);
    return toMonthDto(updated, today);
  });
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "October 2026" */
export const monthLabel = (m: Pick<MessMonth, "year" | "month">) => `${MONTH_NAMES[m.month - 1]} ${m.year}`;
