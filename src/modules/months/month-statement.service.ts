import { ApprovalStatus, MonthStatus, PaidFrom } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { storage } from "../../lib/storage/index.js";
import { hasManagerAccess, type Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { fromDbDate, todayIn } from "../../utils/date.js";
import { Decimal, sumMoney } from "../../utils/money.js";
import { generateMonthToToday } from "../meals/meals.generation.js";
import { expenseShares, weighted } from "../settlement/engine.js";
import { loadMonthBasis } from "./month-basis.js";
import { calculateMonth } from "./month-calc.js";
import { monthLabel } from "./months.service.js";

const money = (d: Decimal) => d.toFixed(2);

/**
 * One member's bill for a month, line by line ("why do I owe this?"): meals by slot, each shared
 * expense with their share, charges, deposits and what they paid themselves. Members see their own;
 * managers anyone's. For a CLOSED month the totals are the stored summary (never recalculated).
 */
export async function getStatement(membership: Membership, monthId: string, memberId: string) {
  if (memberId !== membership.id && !hasManagerAccess(membership))
    throw ApiError.notFound("Statement not found");
  const month = await prisma.messMonth.findFirst({
    where: { id: monthId, messId: membership.messId },
    include: { mess: { select: { timezone: true } } },
  });
  if (!month) throw ApiError.notFound("Month not found");
  const member = await prisma.messMember.findFirst({
    where: { id: memberId, messId: membership.messId },
    select: { id: true, user: { select: { name: true, avatarUrl: true } } },
  });
  if (!member) throw ApiError.notFound("Member not found");

  await generateMonthToToday(prisma, month);
  const approved = { monthId, status: ApprovalStatus.APPROVED };
  const [calc, basis, summary, entries, expenses, charges, deposits, bazars] = await Promise.all([
    calculateMonth(prisma, monthId),
    loadMonthBasis(prisma, month),
    prisma.memberMonthSummary.findUnique({
      where: { monthId_memberId: { monthId, memberId } },
      include: { settlements: { orderBy: { paidAt: "asc" } } },
    }),
    prisma.mealEntry.findMany({
      where: { monthId, memberId },
      select: {
        quantity: true,
        guestQuantity: true,
        slot: { select: { id: true, name: true, weight: true, sortOrder: true } },
      },
    }),
    prisma.sharedExpense.findMany({
      where: approved,
      select: {
        id: true,
        title: true,
        category: true,
        billDate: true,
        amount: true,
        splitType: true,
        paidFrom: true,
        paidByMemberId: true,
        shares: { select: { memberId: true, amount: true } },
      },
      orderBy: { billDate: "asc" },
    }),
    prisma.memberCharge.findMany({ where: { monthId, memberId }, orderBy: { createdAt: "asc" } }),
    prisma.deposit.findMany({ where: { ...approved, memberId }, orderBy: { depositedAt: "asc" } }),
    prisma.bazar.findMany({
      where: { ...approved, shopperId: memberId, paidFrom: PaidFrom.OWN_POCKET },
      orderBy: { date: "asc" },
    }),
  ]);

  const isFinal = month.status === MonthStatus.CLOSED;
  const row = calc.rows.find((r) => r.memberId === memberId);
  if (isFinal ? !summary : !row)
    throw ApiError.notFound(`${member.user.name} wasn't part of ${monthLabel(month)}`);

  // Meals, grouped by slot.
  const slots = new Map<
    string,
    { name: string; sortOrder: number; weight: Decimal; meals: Decimal; weightedMeals: Decimal }
  >();
  for (const e of entries) {
    const slot = slots.get(e.slot.id) ?? {
      name: e.slot.name,
      sortOrder: e.slot.sortOrder,
      weight: e.slot.weight,
      meals: new Decimal(0),
      weightedMeals: new Decimal(0),
    };
    slot.meals = slot.meals.plus(e.quantity).plus(e.guestQuantity);
    slot.weightedMeals = slot.weightedMeals.plus(weighted({ ...e, weight: e.slot.weight }));
    slots.set(e.slot.id, slot);
  }

  const expenseLines = expenses
    .map((e) => ({
      e,
      share: expenseShares(e, basis.memberIds, basis.meals).get(memberId) ?? new Decimal(0),
    }))
    .filter(({ share }) => !share.isZero())
    .map(({ e, share }) => ({
      id: e.id,
      title: e.title,
      category: e.category,
      billDate: fromDbDate(e.billDate),
      amount: money(e.amount),
      splitType: e.splitType,
      share: money(share),
    }));
  const sharedCost = isFinal ? summary!.sharedCost : row!.sharedCost;
  // With no meals at all, the bazar is shared equally (§5): whatever isn't an expense share.
  const bazarShare = sharedCost.minus(sumMoney(expenseLines.map((l) => l.share)));

  const totals = isFinal
    ? {
        weightedMeals: summary!.totalMeals.toString(),
        mealCost: money(summary!.mealCost),
        sharedCost: money(summary!.sharedCost),
        chargeTotal: money(summary!.chargeTotal),
        totalDeposit: money(summary!.totalDeposit),
        openingBalance: money(summary!.openingBalance),
        closingBalance: money(summary!.closingBalance),
      }
    : {
        weightedMeals: row!.weightedMeals.toString(),
        mealCost: money(row!.mealCost),
        sharedCost: money(row!.sharedCost),
        chargeTotal: money(row!.chargeTotal),
        totalDeposit: money(row!.totalDeposit),
        openingBalance: money(row!.openingBalance),
        closingBalance: money(row!.closingBalance),
      };

  return {
    month: { id: month.id, year: month.year, month: month.month, status: month.status },
    member: {
      id: member.id,
      name: member.user.name,
      avatarUrl: member.user.avatarUrl,
      isYou: member.id === membership.id,
    },
    isFinal,
    mealRate: (isFinal ? (month.mealRate ?? new Decimal(0)) : calc.mealRate).toFixed(4),
    totals,
    meals: [...slots.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((s) => ({
        slot: s.name,
        meals: s.meals.toString(),
        weight: s.weight.toString(),
        weightedMeals: s.weightedMeals.toString(),
      })),
    expenses: expenseLines,
    bazarShare: bazarShare.isZero() ? null : money(bazarShare),
    charges: [
      ...charges.map((c) => ({
        id: c.id,
        type: c.type,
        description: c.description,
        amount: money(c.amount),
        isEstimate: false,
      })),
      ...(!isFinal && row && !row.seatRentEstimate.isZero()
        ? [
            {
              id: "seat-rent",
              type: "SEAT_RENT" as const,
              description: "Seat rent (charged when the month closes)",
              amount: money(row.seatRentEstimate),
              isEstimate: true,
            },
          ]
        : []),
    ],
    deposits: deposits.map((d) => ({
      id: d.id,
      date: todayIn(month.mess.timezone, d.depositedAt),
      amount: money(d.amount),
      method: d.method,
    })),
    paidYourself: [
      ...(await Promise.all(
        bazars.map(async (b) => ({
          kind: "BAZAR" as const,
          id: b.id,
          title: "Bazar",
          date: fromDbDate(b.date),
          amount: money(b.totalAmount),
          receiptUrl: b.receiptUrl ? await storage.readUrl(b.receiptUrl) : null,
        })),
      )),
      ...expenses
        .filter((e) => e.paidFrom === PaidFrom.OWN_POCKET && e.paidByMemberId === memberId)
        .map((e) => ({
          kind: "EXPENSE" as const,
          id: e.id,
          title: e.title,
          date: fromDbDate(e.billDate),
          amount: money(e.amount),
          receiptUrl: null,
        })),
    ],
    settlement: summary
      ? {
          settledAmount: money(summary.settledAmount),
          isSettled: summary.isSettled,
          payments: summary.settlements.map((p) => ({
            id: p.id,
            direction: p.direction,
            amount: money(p.amount),
            method: p.method,
            paidAt: p.paidAt,
          })),
        }
      : null,
  };
}
