import { MonthStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import type { Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { Decimal } from "../../utils/money.js";
import { generateMonthToToday } from "../meals/meals.generation.js";
import { calculateMonth } from "./month-calc.js";

const money = (d: Decimal) => d.toFixed(2);
const zero = new Decimal(0);

/**
 * A month's bill for everyone (everyone in the mess can see it, BUSINESS_RULES §2).
 * - OPEN / CLOSING: the month so far, worked out from what's approved now (an estimate).
 * - CLOSED: the bill written when it closed. Its totals and balances come from the stored
 *   summaries and are never recalculated; only the breakdown of deposits is read from the
 *   (frozen) records.
 */
export async function getMonthPreview(membership: Membership, monthId: string) {
  const month = await prisma.messMonth.findFirst({ where: { id: monthId, messId: membership.messId } });
  if (!month) throw ApiError.notFound("Month not found");
  const isFinal = month.status === MonthStatus.CLOSED;

  // Usual meals up to today are filled in first, as when a day is opened, so the meal rate never
  // waits for the worker.
  await generateMonthToToday(prisma, month);
  const [calc, summaries] = await Promise.all([
    calculateMonth(prisma, monthId),
    isFinal
      ? prisma.memberMonthSummary.findMany({
          where: { monthId },
          include: { member: { select: { id: true, user: { select: { name: true, avatarUrl: true } } } } },
        })
      : Promise.resolve([]),
  ]);

  const people = new Map(
    [...calc.members, ...summaries.map((s) => s.member)].map((m) => [
      m.id,
      { id: m.id, name: m.user.name, avatarUrl: m.user.avatarUrl, isYou: m.id === membership.id },
    ]),
  );
  const breakdown = (memberId: string) => calc.rows.find((r) => r.memberId === memberId);

  const members = isFinal
    ? summaries.map((s) => {
        const b = breakdown(s.memberId);
        return {
          member: people.get(s.memberId)!,
          weightedMeals: s.totalMeals.toString(),
          mealCost: money(s.mealCost),
          sharedCost: money(s.sharedCost),
          chargeTotal: money(s.chargeTotal),
          seatRentEstimate: money(zero),
          deposits: money(b?.deposits ?? zero),
          ownPocketBazar: money(b?.ownPocketBazar ?? zero),
          ownPocketExpenses: money(b?.ownPocketExpenses ?? zero),
          totalDeposit: money(s.totalDeposit),
          openingBalance: money(s.openingBalance),
          closingBalance: money(s.closingBalance),
          settledAmount: money(s.settledAmount),
          isSettled: s.isSettled,
        };
      })
    : calc.rows
        .filter((r) => people.has(r.memberId))
        .map((r) => ({
          member: people.get(r.memberId)!,
          weightedMeals: r.weightedMeals.toString(),
          mealCost: money(r.mealCost),
          sharedCost: money(r.sharedCost),
          chargeTotal: money(r.chargeTotal),
          seatRentEstimate: money(r.seatRentEstimate),
          deposits: money(r.deposits),
          ownPocketBazar: money(r.ownPocketBazar),
          ownPocketExpenses: money(r.ownPocketExpenses),
          totalDeposit: money(r.totalDeposit),
          openingBalance: money(r.openingBalance),
          closingBalance: money(r.closingBalance),
          settledAmount: money(zero),
          isSettled: false,
        }));

  const cash = Object.fromEntries(Object.entries(calc.cash).map(([k, v]) => [k, money(v)])) as Record<
    keyof typeof calc.cash,
    string
  >;
  if (isFinal) {
    cash.openingCash = money(month.openingCash ?? zero);
    cash.closingCash = money(month.closingCash ?? zero);
  }

  return {
    monthId,
    status: month.status,
    isFinal,
    closedAt: month.closedAt,
    previousMonthClosed: calc.previousMonthClosed,
    totals: isFinal
      ? {
          totalBazar: money(month.totalBazar ?? zero),
          totalMeals: (month.totalMeals ?? zero).toString(),
          mealRate: (month.mealRate ?? zero).toFixed(4),
          totalDeposits: money(calc.totalDeposits),
          totalExpenses: money(month.totalExpenses ?? zero),
        }
      : {
          totalBazar: money(calc.totalBazar),
          totalMeals: calc.totalMeals.toString(),
          mealRate: calc.mealRate.toFixed(4),
          totalDeposits: money(calc.totalDeposits),
          totalExpenses: money(calc.totalExpenses),
        },
    pending: {
      bazars: { count: calc.pending.bazars.count, total: money(calc.pending.bazars.total) },
      deposits: { count: calc.pending.deposits.count, total: money(calc.pending.deposits.total) },
    },
    cash,
    members: members.sort((a, b) => a.member.name.localeCompare(b.member.name)),
  };
}
