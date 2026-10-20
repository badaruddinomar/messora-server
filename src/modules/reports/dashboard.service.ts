import { ApprovalStatus, MemberStatus, MonthStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { hasManagerAccess, type Membership } from "../../middlewares/tenant.js";
import { fromDbDate, toDbDate } from "../../utils/date.js";
import { Decimal, sumMoney } from "../../utils/money.js";
import { generateMonthToToday } from "../meals/meals.generation.js";
import { calculateMonth } from "../months/month-calc.js";
import { ensureCurrentMonth, monthInclude, toMonthDto } from "../months/months.service.js";
import { listSettlements } from "../settlement/settlements.service.js";

const money = (d: Decimal) => d.toFixed(2);

/**
 * Everything the overview needs in one request (ROADMAP Phase 9). Every member gets their own
 * numbers so far this month, today's meals and their next bazar duty. Managers also get what they
 * act on: cash in hand, what's waiting for them, who owes what, and the last closed month's dues.
 */
export async function getDashboard(membership: Membership) {
  const { messId } = membership;
  const today = await ensureCurrentMonth(prisma, messId);
  const dbToday = toDbDate(today);
  const month = await prisma.messMonth.findFirstOrThrow({
    where: { messId, startDate: { lte: dbToday }, endDate: { gte: dbToday } },
    include: monthInclude,
  });
  // Usual meals up to today count, as in the month preview.
  await generateMonthToToday(prisma, month);
  const canManage = hasManagerAccess(membership);

  const [calc, slots, todayEntries, nextDuty, lastClosed] = await Promise.all([
    calculateMonth(prisma, month.id),
    prisma.mealSlot.findMany({
      where: { messId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
    prisma.mealEntry.findMany({
      where: { messId, date: dbToday },
      select: { memberId: true, slotId: true, quantity: true, guestQuantity: true },
    }),
    prisma.bazarSchedule.findFirst({
      where: { messId, memberId: membership.id, date: { gte: dbToday }, isDone: false },
      orderBy: { date: "asc" },
      select: { date: true },
    }),
    prisma.messMonth.findFirst({
      where: { messId, status: MonthStatus.CLOSED },
      orderBy: { startDate: "desc" },
      select: { id: true, year: true, month: true },
    }),
  ]);

  const mine = calc.rows.find((r) => r.memberId === membership.id);
  const todayMeals = slots.map((s) => {
    const forSlot = todayEntries.filter((e) => e.slotId === s.id);
    const own = forSlot.find((e) => e.memberId === membership.id);
    return {
      slot: s,
      meals: sumMoney(forSlot.map((e) => e.quantity)).toString(),
      guests: sumMoney(forSlot.map((e) => e.guestQuantity)).toString(),
      eating: forSlot.filter((e) => !e.quantity.isZero() || !e.guestQuantity.isZero()).length,
      yours: own ? new Decimal(own.quantity).plus(own.guestQuantity).toString() : "0",
    };
  });

  return {
    month: toMonthDto(month, today),
    today,
    mealRate: calc.mealRate.toFixed(4),
    todayMeals,
    you: {
      weightedMeals: (mine?.weightedMeals ?? new Decimal(0)).toString(),
      mealCost: money(mine?.mealCost ?? new Decimal(0)),
      totalDeposit: money(mine?.totalDeposit ?? new Decimal(0)),
      closingBalance: money(mine?.closingBalance ?? new Decimal(0)),
      nextDuty: nextDuty ? fromDbDate(nextDuty.date) : null,
    },
    manager: canManage ? await managerPart(membership, calc, lastClosed, dbToday) : null,
  };
}

async function managerPart(
  membership: Membership,
  calc: Awaited<ReturnType<typeof calculateMonth>>,
  lastClosed: { id: string; year: number; month: number } | null,
  dbToday: Date,
) {
  const { messId } = membership;
  const [joinRequests, mealRequests, settlements] = await Promise.all([
    prisma.messMember.count({ where: { messId, status: MemberStatus.PENDING } }),
    prisma.mealRequest.count({ where: { messId, status: ApprovalStatus.PENDING, date: { gte: dbToday } } }),
    lastClosed ? listSettlements(membership, lastClosed.id) : null,
  ]);

  const names = new Map(calc.members.map((m) => [m.id, m.user.name]));
  const balances = calc.rows
    .filter((r) => names.has(r.memberId))
    .map((r) => ({ member: { id: r.memberId, name: names.get(r.memberId)! }, balance: r.closingBalance }))
    .sort((a, b) => a.balance.comparedTo(b.balance));

  return {
    cashInHand: money(calc.cash.closingCash),
    pending: {
      bazars: { count: calc.pending.bazars.count, total: money(calc.pending.bazars.total) },
      deposits: { count: calc.pending.deposits.count, total: money(calc.pending.deposits.total) },
      joinRequests,
      mealRequests,
    },
    /** Everyone's balance so far, most owed first. */
    balances: balances.map((b) => ({ member: b.member, balance: money(b.balance) })),
    dueSoFar: money(sumMoney(balances.filter((b) => b.balance.isNegative()).map((b) => b.balance)).abs()),
    creditSoFar: money(sumMoney(balances.filter((b) => b.balance.isPositive()).map((b) => b.balance))),
    lastClosed:
      lastClosed && settlements
        ? {
            ...lastClosed,
            collectable: settlements.collectable,
            dueToMess: settlements.totals.dueToMess,
            owedToMembers: settlements.totals.owedToMembers,
            unsettled: settlements.rows.filter((r) => !r.isSettled && !r.carriedOver).length,
          }
        : null,
  };
}
