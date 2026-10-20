import { prisma } from "../../lib/prisma.js";
import type { Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import type { Decimal } from "../../utils/money.js";
import { calculateMonth } from "./month-calc.js";

const money = (d: Decimal) => d.toFixed(2);

/**
 * The month so far: meal rate and every member's running balance from what's approved today. It's an
 * estimate until the month is closed (Phase 8); everyone in the mess can see it (BUSINESS_RULES §2).
 */
export async function getMonthPreview(membership: Membership, monthId: string) {
  const exists = await prisma.messMonth.findFirst({
    where: { id: monthId, messId: membership.messId },
    select: { id: true },
  });
  if (!exists) throw ApiError.notFound("Month not found");
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
        deposits: money(r.deposits),
        ownPocketBazar: money(r.ownPocketBazar),
        totalDeposit: money(r.totalDeposit),
        openingBalance: money(r.openingBalance),
        closingBalance: money(r.closingBalance),
      }))
      .sort((a, b) => a.member.name.localeCompare(b.member.name)),
  };
}
