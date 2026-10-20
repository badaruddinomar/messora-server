import {
  ApprovalStatus,
  ChargeType,
  MonthStatus,
  PaidFrom,
  type Prisma,
  SettlementDirection,
} from "@prisma/client";
import type { DbClient } from "../../lib/prisma.js";
import { Decimal, splitByWeight, splitEqually, sumMoney } from "../../utils/money.js";
import { splitExpense } from "../expenses/expense-split.js";
import { seatRent } from "../rooms/seat-rent.js";
import { loadMonthBasis } from "./month-basis.js";

const zero = () => new Decimal(0);

/**
 * The month's bill, worked out from its approved records (BUSINESS_RULES §5–§9). Used for the live
 * "month so far" preview, and by closing (Phase 8) to write the final summaries.
 *
 * Seat rent becomes a charge when the month closes (§6); until then it's estimated from the seat
 * each member holds, unless a SEAT_RENT charge already exists (e.g. written when they left).
 */
export async function calculateMonth(db: DbClient, monthId: string) {
  const month = await db.messMonth.findUniqueOrThrow({
    where: { id: monthId },
    include: { mess: { select: { settings: { select: { prorateSeatRent: true } } } } },
  });
  const approved = { monthId, status: ApprovalStatus.APPROVED };

  const [basis, previous, bazars, deposits, expenses, charges, pendingBazars, pendingDeposits, settlements] =
    await Promise.all([
      loadMonthBasis(db, month),
      db.messMonth.findFirst({
        where: { messId: month.messId, startDate: { lt: month.startDate } },
        orderBy: { startDate: "desc" },
        include: { summaries: true, settlements: true },
      }),
      db.bazar.findMany({ where: approved, select: { shopperId: true, totalAmount: true, paidFrom: true } }),
      db.deposit.findMany({ where: approved, select: { memberId: true, amount: true } }),
      db.sharedExpense.findMany({
        where: approved,
        select: {
          amount: true,
          splitType: true,
          paidFrom: true,
          paidByMemberId: true,
          shares: { select: { memberId: true, amount: true } },
        },
      }),
      db.memberCharge.findMany({ where: { monthId }, select: { memberId: true, type: true, amount: true } }),
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

  const memberIds = [...new Set([...basis.memberIds, ...charges.map((c) => c.memberId)])].sort();
  const sumFor = <T>(rows: T[], match: (row: T) => boolean, amount: (row: T) => Prisma.Decimal) =>
    sumMoney(rows.filter(match).map(amount));

  // §5 meal rate; with no meals at all the bazar can't be priced per meal, so it's shared equally.
  const totalBazar = sumMoney(bazars.map((b) => b.totalAmount));
  const mealRate = basis.totalMeals.isZero()
    ? zero()
    : totalBazar.dividedBy(basis.totalMeals).toDecimalPlaces(4);
  const mealCosts = basis.totalMeals.isZero()
    ? new Map<string, Decimal>()
    : splitByWeight(
        totalBazar,
        basis.memberIds.map((id) => ({ key: id, weight: basis.meals.get(id)! })),
      );
  const bazarAsShared = basis.totalMeals.isZero()
    ? splitEqually(totalBazar, basis.memberIds)
    : new Map<string, Decimal>();

  // §7 shared expenses.
  const sharedCosts = new Map<string, Decimal>();
  for (const expense of expenses) {
    for (const [memberId, share] of splitExpense(expense.amount, expense.splitType, basis, expense.shares)) {
      sharedCosts.set(memberId, (sharedCosts.get(memberId) ?? zero()).plus(share));
    }
  }

  // §6 seat rent, estimated until the month is closed.
  const prorate = month.mess.settings?.prorateSeatRent ?? true;
  const seatRents = new Map<string, Decimal>();
  if (month.status !== MonthStatus.CLOSED) {
    for (const m of basis.members) {
      const charged = charges.some((c) => c.memberId === m.id && c.type === ChargeType.SEAT_RENT);
      const rent = m.seat && !charged ? seatRent(m.seat.monthlyRent, m, month, prorate) : null;
      if (rent) seatRents.set(m.id, rent.amount);
    }
  }

  // §8 opening balances carry over only from a closed month, adjusted by settlements made on it.
  const previousClosed = previous?.status === MonthStatus.CLOSED;
  const opening = (memberId: string) => {
    const summary = previousClosed ? previous.summaries.find((s) => s.memberId === memberId) : undefined;
    if (!summary) return zero();
    const paid = previous!.settlements.filter((p) => p.summaryId === summary.id);
    const signed = paid.map((p) =>
      p.direction === SettlementDirection.MEMBER_TO_MESS ? p.amount : p.amount.negated(),
    );
    return summary.closingBalance.plus(sumMoney(signed));
  };

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
    const ownPocketExpenses = sumFor(
      expenses,
      (e) => e.paidByMemberId === memberId && e.paidFrom === PaidFrom.OWN_POCKET,
      (e) => e.amount,
    );
    const mealCost = mealCosts.get(memberId) ?? zero();
    const sharedCost = (sharedCosts.get(memberId) ?? zero()).plus(bazarAsShared.get(memberId) ?? zero());
    const rentEstimate = seatRents.get(memberId) ?? zero();
    const chargeTotal = sumFor(
      charges,
      (c) => c.memberId === memberId,
      (c) => c.amount,
    ).plus(rentEstimate);
    const totalDeposit = depositTotal.plus(ownPocketBazar).plus(ownPocketExpenses);
    const openingBalance = opening(memberId);
    return {
      memberId,
      weightedMeals: basis.meals.get(memberId) ?? zero(),
      mealCost,
      sharedCost,
      chargeTotal,
      seatRentEstimate: rentEstimate,
      deposits: depositTotal,
      ownPocketBazar,
      ownPocketExpenses,
      totalDeposit,
      openingBalance,
      closingBalance: openingBalance.plus(totalDeposit).minus(mealCost.plus(sharedCost).plus(chargeTotal)),
    };
  });

  // §9 cash in hand.
  const totalDeposits = sumMoney(deposits.map((d) => d.amount));
  const totalExpenses = sumMoney(expenses.map((e) => e.amount));
  const messFundBazar = sumFor(
    bazars,
    (b) => b.paidFrom === PaidFrom.MESS_FUND,
    (b) => b.totalAmount,
  );
  const messFundExpenses = sumFor(
    expenses,
    (e) => e.paidFrom === PaidFrom.MESS_FUND,
    (e) => e.amount,
  );
  // Settlements recorded in this month.
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
  const openingCash = previousClosed ? (previous.closingCash ?? zero()) : zero();

  return {
    month,
    previousMonthClosed: !previous || previousClosed,
    members: basis.members,
    totalBazar,
    totalMeals: basis.totalMeals,
    mealRate,
    totalDeposits,
    totalExpenses,
    pending: {
      bazars: { count: pendingBazars._count, total: pendingBazars._sum.totalAmount ?? zero() },
      deposits: { count: pendingDeposits._count, total: pendingDeposits._sum.amount ?? zero() },
    },
    cash: {
      openingCash,
      deposits: totalDeposits,
      settlementsIn,
      messFundBazar,
      messFundExpenses,
      settlementsOut,
      closingCash: openingCash
        .plus(totalDeposits)
        .plus(settlementsIn)
        .minus(messFundBazar)
        .minus(messFundExpenses)
        .minus(settlementsOut),
    },
    rows,
  };
}

export type MonthCalculation = Awaited<ReturnType<typeof calculateMonth>>;
