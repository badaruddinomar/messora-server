import {
  ApprovalStatus,
  MemberStatus,
  MonthStatus,
  PaidFrom,
  type Prisma,
  SettlementDirection,
} from "@prisma/client";
import type { DbClient } from "../../lib/prisma.js";
import { Decimal, splitByWeight, splitEqually, sumMoney } from "../../utils/money.js";
import { weightedMeals } from "../meals/meals.rules.js";

/**
 * The month's bill, worked out from its approved records (BUSINESS_RULES §5, §7, §8, §9). Used for
 * the live "month so far" preview, and by closing (Phase 8) to write the final summaries. Shared
 * expenses and charges join in Phase 7; until then they are 0, except the §5 fallback below.
 */
export async function calculateMonth(db: DbClient, monthId: string) {
  const month = await db.messMonth.findUniqueOrThrow({ where: { id: monthId } });
  const approved = { monthId, status: ApprovalStatus.APPROVED };

  const [previous, members, entries, bazars, deposits, pendingBazars, pendingDeposits, settlements] =
    await Promise.all([
      db.messMonth.findFirst({
        where: { messId: month.messId, startDate: { lt: month.startDate } },
        orderBy: { startDate: "desc" },
        include: { summaries: true, settlements: true },
      }),
      // Everyone who was in the mess on at least one day of the month (§7 "takes part").
      db.messMember.findMany({
        where: {
          messId: month.messId,
          status: { not: MemberStatus.PENDING },
          joinedAt: { not: null, lte: month.endDate },
          OR: [{ leftAt: null }, { leftAt: { gte: month.startDate } }],
        },
        select: { id: true, user: { select: { name: true, avatarUrl: true } } },
      }),
      db.mealEntry.findMany({
        where: { monthId },
        select: { memberId: true, quantity: true, guestQuantity: true, slot: { select: { weight: true } } },
      }),
      db.bazar.findMany({ where: approved, select: { shopperId: true, totalAmount: true, paidFrom: true } }),
      db.deposit.findMany({ where: approved, select: { memberId: true, amount: true } }),
      db.bazar.aggregate({
        where: { monthId, status: ApprovalStatus.PENDING },
        _sum: { totalAmount: true },
        _count: true,
      }),
      db.deposit.aggregate({
        where: { monthId, status: ApprovalStatus.PENDING },
        _sum: { amount: true },
        _count: true,
      }),
      db.settlementPayment.findMany({ where: { monthId }, select: { direction: true, amount: true } }),
    ]);

  // Stable order for the largest-remainder tie-break (§7: lower memberId first).
  const memberIds = [...new Set([...members.map((m) => m.id), ...entries.map((e) => e.memberId)])].sort();
  const meals = new Map(memberIds.map((id) => [id, new Decimal(0)]));
  for (const e of entries)
    meals.set(e.memberId, meals.get(e.memberId)!.plus(weightedMeals(e, e.slot.weight)));

  const totalBazar = sumMoney(bazars.map((b) => b.totalAmount));
  const totalMeals = sumMoney(meals.values());
  // §5: with no meals at all, the bazar can't be priced per meal, so it's shared equally instead.
  const mealRate = totalMeals.isZero() ? new Decimal(0) : totalBazar.dividedBy(totalMeals).toDecimalPlaces(4);
  const mealCosts = totalMeals.isZero()
    ? new Map<string, Decimal>()
    : splitByWeight(
        totalBazar,
        memberIds.map((id) => ({ key: id, weight: meals.get(id)! })),
      );
  const bazarAsShared = totalMeals.isZero()
    ? splitEqually(totalBazar, memberIds)
    : new Map<string, Decimal>();

  // Opening balances carry over only from a closed month, adjusted by settlements made on it (§8).
  const previousClosed = previous?.status === MonthStatus.CLOSED;
  const opening = (memberId: string) => {
    const summary = previousClosed ? previous.summaries.find((s) => s.memberId === memberId) : undefined;
    if (!summary) return new Decimal(0);
    const paid = previous!.settlements.filter((p) => p.summaryId === summary.id);
    const signed = paid.map((p) =>
      p.direction === SettlementDirection.MEMBER_TO_MESS ? p.amount : p.amount.negated(),
    );
    return summary.closingBalance.plus(sumMoney(signed));
  };

  const sumFor = <T>(rows: T[], match: (row: T) => boolean, amount: (row: T) => Prisma.Decimal) =>
    sumMoney(rows.filter(match).map(amount));

  const rows = memberIds.map((memberId) => {
    const depositTotal = sumFor(
      deposits,
      (d) => d.memberId === memberId,
      (d) => d.amount,
    );
    const ownPocketBazar = sumFor(
      bazars,
      (b) => b.shopperId === memberId && b.paidFrom === PaidFrom.OWN_POCKET,
      (b) => b.totalAmount,
    );
    const mealCost = mealCosts.get(memberId) ?? new Decimal(0);
    const sharedCost = bazarAsShared.get(memberId) ?? new Decimal(0);
    const chargeTotal = new Decimal(0);
    const totalDeposit = depositTotal.plus(ownPocketBazar);
    const openingBalance = opening(memberId);
    return {
      memberId,
      weightedMeals: meals.get(memberId)!,
      mealCost,
      sharedCost,
      chargeTotal,
      deposits: depositTotal,
      ownPocketBazar,
      totalDeposit,
      openingBalance,
      closingBalance: openingBalance.plus(totalDeposit).minus(mealCost.plus(sharedCost).plus(chargeTotal)),
    };
  });

  const totalDeposits = sumMoney(deposits.map((d) => d.amount));
  const messFundBazar = sumFor(
    bazars,
    (b) => b.paidFrom === PaidFrom.MESS_FUND,
    (b) => b.totalAmount,
  );
  const settlementsIn = sumFor(
    settlements,
    (s) => s.direction === SettlementDirection.MEMBER_TO_MESS,
    (s) => s.amount,
  );
  const settlementsOut = sumFor(
    settlements,
    (s) => s.direction === SettlementDirection.MESS_TO_MEMBER,
    (s) => s.amount,
  );
  const openingCash = previousClosed ? (previous.closingCash ?? new Decimal(0)) : new Decimal(0);

  return {
    month,
    previousMonthClosed: !previous || previousClosed,
    members,
    totalBazar,
    totalMeals,
    mealRate,
    totalDeposits,
    pending: {
      bazars: { count: pendingBazars._count, total: pendingBazars._sum.totalAmount ?? new Decimal(0) },
      deposits: { count: pendingDeposits._count, total: pendingDeposits._sum.amount ?? new Decimal(0) },
    },
    cash: {
      openingCash,
      deposits: totalDeposits,
      settlementsIn,
      messFundBazar,
      settlementsOut,
      closingCash: openingCash
        .plus(totalDeposits)
        .plus(settlementsIn)
        .minus(messFundBazar)
        .minus(settlementsOut),
    },
    rows,
  };
}

export type MonthCalculation = Awaited<ReturnType<typeof calculateMonth>>;
