import { ApprovalStatus, MonthStatus } from "@prisma/client";
import type { DbClient } from "../../lib/prisma.js";
import { Decimal } from "../../utils/money.js";
import { carriedBalance, computeMonth } from "../settlement/engine.js";
import { loadMonthBasis } from "./month-basis.js";

/**
 * Loads a month's approved records and runs the bill engine on them (BUSINESS_RULES §5–§9). Used for
 * the live "month so far" preview and by closing, which writes the result as the final bill.
 */
export async function calculateMonth(db: DbClient, monthId: string) {
  const month = await db.messMonth.findUniqueOrThrow({
    where: { id: monthId },
    include: { mess: { select: { settings: { select: { prorateSeatRent: true } } } } },
  });
  const approved = { monthId, status: ApprovalStatus.APPROVED };

  const [
    basis,
    previous,
    entries,
    bazars,
    deposits,
    expenses,
    charges,
    pendingBazars,
    pendingDeposits,
    settlements,
  ] = await Promise.all([
    loadMonthBasis(db, month),
    db.messMonth.findFirst({
      where: { messId: month.messId, startDate: { lt: month.startDate } },
      orderBy: { startDate: "desc" },
      // Payments against a summary are filed under the month they were made in, so go through the summary.
      include: { summaries: { include: { settlements: true } } },
    }),
    db.mealEntry.findMany({
      where: { monthId },
      select: { memberId: true, quantity: true, guestQuantity: true, slot: { select: { weight: true } } },
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

  // §8: balances and cash carry over only from a closed month, adjusted by settlements made on it.
  const previousClosed = previous?.status === MonthStatus.CLOSED;
  const openingBalances = new Map(
    previousClosed
      ? previous.summaries.map((s) => [s.memberId, carriedBalance(s.closingBalance, s.settlements)])
      : [],
  );

  const bill = computeMonth({
    month,
    members: basis.members.map((m) => ({
      id: m.id,
      joinedAt: m.joinedAt,
      leftAt: m.leftAt,
      seatRent: m.seat?.monthlyRent ?? null,
    })),
    meals: entries.map((e) => ({ ...e, weight: e.slot.weight })),
    bazars: bazars.map((b) => ({ shopperId: b.shopperId, amount: b.totalAmount, paidFrom: b.paidFrom })),
    deposits,
    expenses,
    charges,
    openingBalances,
    openingCash: previousClosed ? (previous.closingCash ?? 0) : 0,
    settlements,
    prorateSeatRent: month.mess.settings?.prorateSeatRent ?? true,
    includeSeatRent: month.status !== MonthStatus.CLOSED,
  });

  return {
    ...bill,
    month,
    previousMonthClosed: !previous || previousClosed,
    members: basis.members,
    pending: {
      bazars: { count: pendingBazars._count, total: pendingBazars._sum.totalAmount ?? new Decimal(0) },
      deposits: { count: pendingDeposits._count, total: pendingDeposits._sum.amount ?? new Decimal(0) },
    },
    rows: bill.rows.map((r) => ({ ...r, seatRentEstimate: r.seatRent })),
  };
}

export type MonthCalculation = Awaited<ReturnType<typeof calculateMonth>>;
