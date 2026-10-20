import { ApprovalStatus, ChargeType, MemberStatus, MonthStatus, NotificationType } from "@prisma/client";
import { ERROR_CODES } from "../../constants/error-codes.js";
import { audit } from "../../lib/audit.js";
import { notify } from "../../lib/notify.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import type { Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { fromDbDate, todayIn, toDbDate } from "../../utils/date.js";
import type { Decimal } from "../../utils/money.js";
import { generateMealEntries } from "../meals/meals.generation.js";
import { calculateMonth } from "./month-calc.js";
import {
  assertEarlierMonthsClosed,
  ensureCurrentMonth,
  monthInclude,
  monthLabel,
  toMonthDto,
} from "./months.service.js";

async function findMonth(db: DbClient, messId: string, monthId: string) {
  const month = await db.messMonth.findFirst({ where: { id: monthId, messId }, include: monthInclude });
  if (!month) throw ApiError.notFound("Month not found");
  return month;
}

const messToday = async (db: DbClient, messId: string) =>
  todayIn((await db.mess.findUniqueOrThrow({ where: { id: messId }, select: { timezone: true } })).timezone);

const activeUserIds = async (db: DbClient, messId: string) =>
  (
    await db.messMember.findMany({ where: { messId, status: MemberStatus.ACTIVE }, select: { userId: true } })
  ).map((m) => m.userId);

const pendingCounts = async (db: DbClient, monthId: string) => {
  const [bazars, deposits] = await Promise.all([
    db.bazar.count({ where: { monthId, status: ApprovalStatus.PENDING } }),
    db.deposit.count({ where: { monthId, status: ApprovalStatus.PENDING } }),
  ]);
  return { bazars, deposits };
};

/**
 * What stands between a month and closing it (BUSINESS_RULES §3): it must have ended, earlier months
 * must be closed, and nothing may be waiting for approval (nothing can be approved once closing starts).
 * Warnings don't block but are worth a look.
 */
export async function closeChecks(membership: Membership, monthId: string) {
  const month = await findMonth(prisma, membership.messId, monthId);
  const today = await messToday(prisma, membership.messId);
  const [earlierOpen, pending, calc] = await Promise.all([
    prisma.messMonth.findMany({
      where: {
        messId: month.messId,
        startDate: { lt: month.startDate },
        status: { not: MonthStatus.CLOSED },
      },
      orderBy: { startDate: "asc" },
    }),
    pendingCounts(prisma, month.id),
    month.status === MonthStatus.CLOSED ? null : calculateMonth(prisma, month.id),
  ]);
  const ended = fromDbDate(month.endDate) < today;
  const noMeals =
    calc?.members.filter((m) => calc.rows.find((r) => r.memberId === m.id)?.weightedMeals.isZero()) ?? [];

  return {
    month: toMonthDto(month, today),
    ended,
    earlierOpen: earlierOpen.map((m) => ({ id: m.id, label: monthLabel(m) })),
    pending,
    warnings: {
      /** With no meals, the bazar is shared equally instead (§5). */
      noMealsAtAll: calc ? calc.totalMeals.isZero() && !calc.totalBazar.isZero() : false,
      membersWithoutMeals: noMeals.map((m) => ({ id: m.id, name: m.user.name })),
    },
    canStartClosing:
      month.status === MonthStatus.OPEN &&
      ended &&
      earlierOpen.length === 0 &&
      pending.bazars + pending.deposits === 0,
    canClose: month.status === MonthStatus.CLOSING,
  };
}

/**
 * OPEN → CLOSING: edits to the month stop (`MONTH_CLOSED`) while the bill is reviewed. Usual meals are
 * filled in for every day first, since nobody can open those days afterwards.
 */
export async function startClosing(membership: Membership, monthId: string) {
  const month = await findMonth(prisma, membership.messId, monthId);
  if (month.status !== MonthStatus.OPEN) throw ApiError.conflict("This month isn't open");
  const today = await messToday(prisma, membership.messId);
  if (fromDbDate(month.endDate) >= today) {
    throw ApiError.unprocessable(`${monthLabel(month)} hasn't ended yet`, ERROR_CODES.MONTH_NOT_ENDED);
  }
  await assertEarlierMonthsClosed(prisma, month);
  // Nothing can be approved once the month is locked, so it all has to be decided first.
  const pending = await pendingCounts(prisma, month.id);
  if (pending.bazars + pending.deposits > 0) {
    throw ApiError.unprocessable(
      "Approve or reject the waiting bazars and deposits first",
      ERROR_CODES.PENDING_ENTRIES,
    );
  }
  await generateMealEntries(prisma, month.messId, fromDbDate(month.startDate), fromDbDate(month.endDate));

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.messMonth.update({
      where: { id: month.id },
      data: { status: MonthStatus.CLOSING, version: { increment: 1 } },
      include: monthInclude,
    });
    await audit(tx, {
      messId: month.messId,
      actorId: membership.userId,
      action: "MONTH_CLOSING_STARTED",
      entity: "MessMonth",
      entityId: month.id,
    });
    await notify(tx, {
      userIds: (await activeUserIds(tx, month.messId)).filter((id) => id !== membership.userId),
      messId: month.messId,
      type: NotificationType.SYSTEM,
      title: `${monthLabel(month)} is being closed`,
      body: "Its meals and money are locked while the bill is checked.",
      entity: "MessMonth",
      entityId: month.id,
    });
    return row;
  });
  return toMonthDto(updated, today);
}

/** CLOSING → OPEN (ADMIN): something was missing, so the month takes edits again. */
export async function reopenMonth(membership: Membership, monthId: string) {
  const month = await findMonth(prisma, membership.messId, monthId);
  if (month.status !== MonthStatus.CLOSING) {
    throw ApiError.conflict(
      month.status === MonthStatus.CLOSED ? "A closed month can't be reopened" : "This month is already open",
    );
  }
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.messMonth.update({
      where: { id: month.id },
      data: { status: MonthStatus.OPEN, version: { increment: 1 } },
      include: monthInclude,
    });
    await audit(tx, {
      messId: month.messId,
      actorId: membership.userId,
      action: "MONTH_REOPENED",
      entity: "MessMonth",
      entityId: month.id,
    });
    return row;
  });
  return toMonthDto(updated, await messToday(prisma, membership.messId));
}

const balanceLine = (balance: Decimal) =>
  balance.isZero()
    ? "You're all settled."
    : balance.isNegative()
      ? `You owe the mess ৳${balance.abs().toFixed(2)}.`
      : `The mess owes you ৳${balance.abs().toFixed(2)}.`;

/**
 * CLOSING → CLOSED, in one transaction (BUSINESS_RULES §8): seat rent becomes charges, every member's
 * bill is written as a `MemberMonthSummary`, the month's totals are stored, and the month is CLOSED.
 * `version` must match what the closer reviewed (optimistic lock), so a month changed meanwhile (e.g.
 * reopened and edited) isn't closed on numbers nobody checked. A CLOSED month is never recalculated.
 */
export async function closeMonth(membership: Membership, monthId: string, version: number) {
  const before = await findMonth(prisma, membership.messId, monthId);
  if (before.status !== MonthStatus.CLOSING) {
    throw ApiError.conflict(
      before.status === MonthStatus.CLOSED ? "This month is already closed" : "Start closing the month first",
    );
  }

  const closed = await prisma.$transaction(
    async (tx) => {
      const locked = await tx.messMonth.updateMany({
        where: { id: monthId, status: MonthStatus.CLOSING, version },
        data: { version: { increment: 1 } },
      });
      if (locked.count !== 1) {
        throw ApiError.conflict(
          "The month changed while you were checking it. Look over the numbers again.",
          ERROR_CODES.VERSION_CONFLICT,
        );
      }
      const pending = await pendingCounts(tx, monthId);
      if (pending.bazars + pending.deposits > 0) {
        throw ApiError.unprocessable(
          "Approve or reject the waiting bazars and deposits first",
          ERROR_CODES.PENDING_ENTRIES,
        );
      }

      const calc = await calculateMonth(tx, monthId);
      for (const [memberId, rent] of calc.seatRentPeriods) {
        await tx.memberCharge.create({
          data: {
            messId: before.messId,
            monthId,
            memberId,
            type: ChargeType.SEAT_RENT,
            amount: rent.amount,
            description: rent.isProrated
              ? `Seat rent, ${rent.daysPresent} of ${rent.daysInMonth} days`
              : "Seat rent",
            periodFrom: toDbDate(rent.periodFrom),
            periodTo: toDbDate(rent.periodTo),
            isProrated: rent.isProrated,
            createdById: membership.userId,
          },
        });
      }
      await tx.memberMonthSummary.createMany({
        data: calc.rows.map((r) => ({
          monthId,
          memberId: r.memberId,
          totalMeals: r.weightedMeals,
          mealCost: r.mealCost,
          sharedCost: r.sharedCost,
          chargeTotal: r.chargeTotal,
          totalDeposit: r.totalDeposit,
          openingBalance: r.openingBalance,
          closingBalance: r.closingBalance,
          isSettled: r.closingBalance.isZero(),
        })),
      });
      const month = await tx.messMonth.update({
        where: { id: monthId },
        data: {
          status: MonthStatus.CLOSED,
          closedAt: new Date(),
          closedById: membership.userId,
          totalBazar: calc.totalBazar,
          totalMeals: calc.totalMeals,
          mealRate: calc.mealRate,
          totalExpenses: calc.totalExpenses,
          openingCash: calc.cash.openingCash,
          closingCash: calc.cash.closingCash,
        },
        include: monthInclude,
      });

      await audit(tx, {
        messId: before.messId,
        actorId: membership.userId,
        action: "MONTH_CLOSED",
        entity: "MessMonth",
        entityId: monthId,
        after: {
          totalBazar: calc.totalBazar.toFixed(2),
          totalMeals: calc.totalMeals.toString(),
          mealRate: calc.mealRate.toFixed(4),
          closingCash: calc.cash.closingCash.toFixed(2),
          members: calc.rows.length,
        },
      });
      const people = await tx.messMember.findMany({
        where: { id: { in: calc.rows.map((r) => r.memberId) } },
        select: { id: true, userId: true },
      });
      for (const row of calc.rows) {
        const userId = people.find((p) => p.id === row.memberId)?.userId;
        if (!userId) continue;
        await notify(tx, {
          userIds: [userId],
          messId: before.messId,
          type: NotificationType.MONTH_CLOSED,
          title: `${monthLabel(month)} is closed`,
          body: `Meal rate ৳${calc.mealRate.toFixed(2)}. ${balanceLine(row.closingBalance)}`,
          entity: "MessMonth",
          entityId: monthId,
        });
      }
      return month;
    },
    { timeout: 30_000 },
  );

  // The next month is normally open already; this covers a mess that skipped ahead.
  await ensureCurrentMonth(prisma, membership.messId);
  return toMonthDto(closed, await messToday(prisma, membership.messId));
}
