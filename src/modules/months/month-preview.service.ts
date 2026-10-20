import { prisma } from "../../lib/prisma.js";
import type { Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import type { Decimal } from "../../utils/money.js";
import { generateMonthToToday } from "../meals/meals.generation.js";
import { calculateMonth } from "./month-calc.js";

const money = (d: Decimal) => d.toFixed(2);

/**
 * The month so far: meal rate and every member's running balance from what's approved today. It's an
 * estimate until the month is closed (Phase 8); everyone in the mess can see it (BUSINESS_RULES §2).
 */
export async function getMonthPreview(membership: Membership, monthId: string) {
  const month = await prisma.messMonth.findFirst({ where: { id: monthId, messId: membership.messId } });
  if (!month) throw ApiError.notFound("Month not found");

  // Usual meals up to today are filled in first, as when a day is opened, so the meal rate never
  // waits for the worker.
  await generateMonthToToday(prisma, month);
  const calc = await calculateMonth(prisma, monthId);

  const people = new Map(
    calc.members.map((m) => [m.id, { id: m.id, name: m.user.name, avatarUrl: m.user.avatarUrl }]),
  );
  return {
    monthId,
    isFinal: false,
    previousMonthClosed: calc.previousMonthClosed,
    totals: {
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
    cash: Object.fromEntries(Object.entries(calc.cash).map(([k, v]) => [k, money(v)])) as Record<
      keyof typeof calc.cash,
      string
    >,
    members: calc.rows
      .filter((r) => people.has(r.memberId))
      .map((r) => ({
        member: { ...people.get(r.memberId)!, isYou: r.memberId === membership.id },
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
      }))
      .sort((a, b) => a.member.name.localeCompare(b.member.name)),
  };
}
