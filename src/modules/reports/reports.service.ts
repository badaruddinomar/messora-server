import { ApprovalStatus, MonthStatus, type ExpenseCategory, type MessMonth } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import type { Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { toCsv } from "../../utils/csv.js";
import { addDays, fromDbDate, todayIn } from "../../utils/date.js";
import { Decimal } from "../../utils/money.js";
import { generateMonthToToday } from "../meals/meals.generation.js";
import { calculateMonth } from "../months/month-calc.js";
import { getMonthPreview } from "../months/month-preview.service.js";
import { getStatement } from "../months/month-statement.service.js";
import { ensureCurrentMonth, monthLabel } from "../months/months.service.js";

const money = (d: Decimal | null | undefined) => (d ?? new Decimal(0)).toFixed(2);

async function findMonth(messId: string, monthId: string) {
  const month = await prisma.messMonth.findFirst({
    where: { id: monthId, messId },
    include: { mess: { select: { slug: true, timezone: true } } },
  });
  if (!month) throw ApiError.notFound("Month not found");
  return month;
}

/**
 * The last `count` months, oldest first, for the trend charts. A closed month reports what was
 * written when it closed; an open one is the month so far (an estimate, `isFinal: false`).
 */
export async function getTrends(membership: Membership, count: number) {
  await ensureCurrentMonth(prisma, membership.messId);
  const months = (
    await prisma.messMonth.findMany({
      where: { messId: membership.messId },
      orderBy: { startDate: "desc" },
      take: count,
    })
  ).reverse();
  const deposits = await prisma.deposit.groupBy({
    by: ["monthId"],
    where: { monthId: { in: months.map((m) => m.id) }, status: ApprovalStatus.APPROVED },
    _sum: { amount: true },
  });
  const depositsOf = (monthId: string) => deposits.find((d) => d.monthId === monthId)?._sum.amount;

  return Promise.all(
    months.map(async (m) => {
      const base = {
        monthId: m.id,
        year: m.year,
        month: m.month,
        status: m.status,
        isFinal: m.status === MonthStatus.CLOSED,
        totalDeposits: money(depositsOf(m.id)),
      };
      if (m.status === MonthStatus.CLOSED) {
        return {
          ...base,
          mealRate: (m.mealRate ?? new Decimal(0)).toFixed(4),
          totalMeals: (m.totalMeals ?? new Decimal(0)).toString(),
          totalBazar: money(m.totalBazar),
          totalExpenses: money(m.totalExpenses),
        };
      }
      await generateMonthToToday(prisma, m);
      const calc = await calculateMonth(prisma, m.id);
      return {
        ...base,
        mealRate: calc.mealRate.toFixed(4),
        totalMeals: calc.totalMeals.toString(),
        totalBazar: money(calc.totalBazar),
        totalExpenses: money(calc.totalExpenses),
      };
    }),
  );
}

/** Days of the month up to today (all of them once it has ended). */
function daysSoFar(month: Pick<MessMonth, "startDate" | "endDate">, today: string) {
  const start = fromDbDate(month.startDate);
  const end = fromDbDate(month.endDate) < today ? fromDbDate(month.endDate) : today;
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Where a month's money went: approved shared costs by category, and approved bazar day by day. */
export async function getMonthReport(membership: Membership, monthId: string) {
  const month = await findMonth(membership.messId, monthId);
  const approved = { monthId, status: ApprovalStatus.APPROVED };
  const [byCategory, byDay] = await Promise.all([
    prisma.sharedExpense.groupBy({
      by: ["category"],
      where: approved,
      _sum: { amount: true },
      _count: true,
    }),
    prisma.bazar.groupBy({
      by: ["date"],
      where: approved,
      _sum: { totalAmount: true },
      _count: true,
      orderBy: { date: "asc" },
    }),
  ]);

  const bazarOn = new Map(byDay.map((d) => [fromDbDate(d.date), d]));
  const days = daysSoFar(month, todayIn(month.mess.timezone));
  // Bazar can't be dated in the future, but never drop a day that has money on it.
  for (const date of bazarOn.keys()) if (!days.includes(date)) days.push(date);

  return {
    month: { id: month.id, year: month.year, month: month.month, status: month.status },
    expensesByCategory: byCategory
      .map((c) => ({ category: c.category, total: money(c._sum.amount), count: c._count }))
      .sort((a, b) => Number(b.total) - Number(a.total)),
    bazarByDay: days.sort().map((date) => {
      const d = bazarOn.get(date);
      return { date, total: money(d?._sum.totalAmount), count: d?._count ?? 0 };
    }),
  };
}

// ---------- CSV exports ----------

export interface CsvFile {
  filename: string;
  body: string;
}

const fileName = (month: { year: number; month: number; mess: { slug: string } }, what: string) =>
  `${month.mess.slug}-${month.year}-${String(month.month).padStart(2, "0")}-${what}.csv`;

const balanceStatus = (balance: string) =>
  Number(balance) < 0 ? "Due" : Number(balance) > 0 ? "Refund" : "Settled";

/** Everyone's bill for the month, one row per member (as on the month summary). */
export async function summaryCsv(membership: Membership, monthId: string): Promise<CsvFile> {
  const month = await findMonth(membership.messId, monthId);
  const preview = await getMonthPreview(membership, monthId);
  const rows = preview.members.map((m) => [
    m.member.name,
    m.weightedMeals,
    m.mealCost,
    m.sharedCost,
    new Decimal(m.chargeTotal).plus(m.seatRentEstimate).toFixed(2),
    m.deposits,
    new Decimal(m.ownPocketBazar).plus(m.ownPocketExpenses).toFixed(2),
    m.openingBalance,
    m.closingBalance,
    balanceStatus(m.closingBalance),
  ]);
  return {
    filename: fileName(month, "summary"),
    body: toCsv(
      [
        "Member",
        "Meals",
        "Meal cost",
        "Shared cost",
        "Charges",
        "Deposits",
        "Paid themselves",
        "Carried in",
        "Balance",
        preview.isFinal ? "Status" : "Status so far",
      ],
      [
        ...rows,
        [],
        ["Meal rate", preview.totals.mealRate],
        ["Total bazar", preview.totals.totalBazar],
        ["Shared costs", preview.totals.totalExpenses],
        ["Cash in hand", preview.cash.closingCash],
        [preview.isFinal ? `Closed ${monthLabel(month)}` : `${monthLabel(month)} so far (estimate)`],
      ],
    ),
  };
}

/** Every bazar of the month with its status (rejected ones too, so the list matches the app). */
export async function bazarsCsv(membership: Membership, monthId: string): Promise<CsvFile> {
  const month = await findMonth(membership.messId, monthId);
  const bazars = await prisma.bazar.findMany({
    where: { monthId },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    select: {
      date: true,
      totalAmount: true,
      paidFrom: true,
      status: true,
      note: true,
      shopper: { select: { user: { select: { name: true } } } },
      items: { select: { name: true }, orderBy: { id: "asc" } },
    },
  });
  return {
    filename: fileName(month, "bazar"),
    body: toCsv(
      ["Date", "Shopper", "Amount", "Paid from", "Status", "Items", "Note"],
      bazars.map((b) => [
        fromDbDate(b.date),
        b.shopper.user.name,
        b.totalAmount.toFixed(2),
        b.paidFrom === "MESS_FUND" ? "Mess fund" : "Own pocket",
        b.status.charAt(0) + b.status.slice(1).toLowerCase(),
        b.items.map((i) => i.name).join("; "),
        b.note,
      ]),
    ),
  };
}

const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  ELECTRICITY: "Electricity",
  GAS: "Gas",
  WATER: "Water",
  INTERNET: "Internet",
  COOK_SALARY: "Cook's salary",
  MAID_SALARY: "Maid's salary",
  CLEANING: "Cleaning",
  MAINTENANCE: "Maintenance",
  HOUSE_RENT: "House rent",
  UTENSILS: "Utensils",
  OTHER: "Other",
};

/** One member's bill, line by line; costs are negative, what they paid is positive. */
export async function statementCsv(
  membership: Membership,
  monthId: string,
  memberId: string,
): Promise<CsvFile> {
  const month = await findMonth(membership.messId, monthId);
  const s = await getStatement(membership, monthId, memberId);
  const neg = (amount: string) => new Decimal(amount).negated().toFixed(2);
  const rows = [
    ["", "Carried in", "", s.totals.openingBalance],
    ...s.meals.map((m) => ["", `Meals: ${m.slot}`, `${m.meals} × ${m.weight}`, ""]),
    ["", "Meal cost", `${s.totals.weightedMeals} meals × ${s.mealRate}`, neg(s.totals.mealCost)],
    ...s.expenses.map((e) => [
      e.billDate,
      `${CATEGORY_LABELS[e.category]}: ${e.title}`,
      e.amount,
      neg(e.share),
    ]),
    ...(s.bazarShare ? [["", "Bazar shared equally", "", neg(s.bazarShare)]] : []),
    ...s.charges.map((c) => ["", c.description ?? c.type, c.isEstimate ? "estimate" : "", neg(c.amount)]),
    ...s.deposits.map((d) => [d.date, "Deposit", d.method, d.amount]),
    ...s.paidYourself.map((p) => [p.date, `Paid yourself: ${p.title}`, "", p.amount]),
    [],
    [
      "",
      s.isFinal ? "Balance" : "Balance so far",
      balanceStatus(s.totals.closingBalance),
      s.totals.closingBalance,
    ],
  ];
  const who = s.member.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return {
    filename: fileName(month, `bill-${who || "member"}`),
    body: toCsv(["Date", "Item", "Detail", "Amount"], rows),
  };
}
