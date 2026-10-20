import {
  ApprovalStatus,
  ExpenseCategory,
  MonthStatus,
  NotificationType,
  PaidFrom,
  Prisma,
  SplitType,
  type StaffRole,
  type MessMonth,
} from "@prisma/client";
import { ERROR_CODES } from "../../constants/error-codes.js";
import { audit } from "../../lib/audit.js";
import { notify } from "../../lib/notify.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import { storage } from "../../lib/storage/index.js";
import { assertReceipt, discardFile } from "../../lib/storage/receipts.js";
import { hasManagerAccess, type Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { fromDbDate, toDbDate } from "../../utils/date.js";
import { sumMoney } from "../../utils/money.js";
import { cursorArgs, toPage } from "../../utils/pagination.js";
import { generateMonthToToday } from "../meals/meals.generation.js";
import { loadMonthBasis, type MonthBasis } from "../months/month-basis.js";
import { ensureCurrentMonth, monthForDate, monthForPastEntry } from "../months/months.service.js";
import { splitExpense } from "./expense-split.js";
import type {
  CreateExpenseInput,
  ListExpensesQuery,
  PayStaffInput,
  UpdateExpenseInput,
} from "./expenses.schema.js";

const person = { select: { id: true, user: { select: { name: true, avatarUrl: true } } } } as const;
const expenseInclude = {
  paidBy: person,
  staff: { select: { id: true, name: true, role: true } },
  shares: { include: { member: person } },
  month: { select: { id: true, status: true } },
} satisfies Prisma.SharedExpenseInclude;

type ExpenseRow = Prisma.SharedExpenseGetPayload<{ include: typeof expenseInclude }>;

const toPerson = (m: { id: string; user: { name: string; avatarUrl: string | null } }) => ({
  id: m.id,
  name: m.user.name,
  avatarUrl: m.user.avatarUrl,
});

const SALARY_CATEGORY: Record<StaffRole, ExpenseCategory> = {
  COOK: ExpenseCategory.COOK_SALARY,
  MAID: ExpenseCategory.MAID_SALARY,
  GUARD: ExpenseCategory.OTHER,
  OTHER: ExpenseCategory.OTHER,
};

const SPLIT_LABELS: Record<SplitType, string> = {
  EQUAL: "split equally",
  BY_MEAL: "split by meals",
  CUSTOM: "split by set amounts",
};

async function toExpenseDto(e: ExpenseRow, membership: Membership, yourShare: Prisma.Decimal | undefined) {
  return {
    id: e.id,
    monthId: e.monthId,
    category: e.category,
    title: e.title,
    amount: e.amount.toFixed(2),
    splitType: e.splitType,
    paidFrom: e.paidFrom,
    paidBy: e.paidBy ? toPerson(e.paidBy) : null,
    staff: e.staff,
    billDate: fromDbDate(e.billDate),
    receiptUrl: e.receiptUrl ? await storage.readUrl(e.receiptUrl) : null,
    status: e.status,
    createdAt: e.createdAt,
    yourShare: (yourShare ?? new Prisma.Decimal(0)).toFixed(2),
    canEdit: hasManagerAccess(membership) && e.month.status === MonthStatus.OPEN,
  };
}

async function findExpense(db: DbClient, messId: string, expenseId: string) {
  const expense = await db.sharedExpense.findFirst({
    where: { id: expenseId, messId },
    include: expenseInclude,
  });
  if (!expense) throw ApiError.notFound("Expense not found");
  return expense;
}

async function resolveMonth(messId: string, monthId: string | undefined) {
  if (!monthId) return monthForDate(prisma, messId, await ensureCurrentMonth(prisma, messId));
  const month = await prisma.messMonth.findFirst({ where: { id: monthId, messId } });
  if (!month) throw ApiError.notFound("Month not found");
  return month;
}

/** Meals are filled in first so BY_MEAL shares are up to date. */
async function basisFor(month: MessMonth) {
  await generateMonthToToday(prisma, month);
  return loadMonthBasis(prisma, month);
}

const sharesOf = (
  e: { amount: Prisma.Decimal; splitType: SplitType; shares: { memberId: string; amount: Prisma.Decimal }[] },
  basis: MonthBasis,
) => splitExpense(e.amount, e.splitType, basis, e.shares);

async function assertPayer(messId: string, memberId: string | null | undefined) {
  if (!memberId) return;
  const member = await prisma.messMember.findFirst({ where: { id: memberId, messId, status: "ACTIVE" } });
  if (!member) throw ApiError.notFound("Member not found");
}

/** CUSTOM shares: members of this mess, each once, adding up to the amount exactly (BUSINESS_RULES §7). */
async function assertCustomShares(
  messId: string,
  amount: string | Prisma.Decimal,
  shares: { memberId: string; amount: string }[],
) {
  const ids = shares.map((s) => s.memberId);
  if (new Set(ids).size !== ids.length) throw ApiError.badRequest("Each member can have one share");
  const found = await prisma.messMember.count({
    where: { id: { in: ids }, messId, status: { not: "PENDING" } },
  });
  if (found !== ids.length) throw ApiError.notFound("Member not found");
  const total = sumMoney(shares.map((s) => s.amount));
  if (!total.equals(amount)) {
    throw ApiError.unprocessable(
      `The shares add up to ${total.toFixed(2)}, not ${new Prisma.Decimal(amount).toFixed(2)}`,
      ERROR_CODES.SHARES_MISMATCH,
    );
  }
}

const shareRows = (shares: { memberId: string; amount: string }[]) =>
  shares.map((s) => ({ memberId: s.memberId, amount: new Prisma.Decimal(s.amount) }));

// ---------- reads ----------

/** A month's expenses, newest first, with the caller's share of each. Everyone can see them. */
export async function listExpenses(membership: Membership, query: ListExpensesQuery) {
  const month = await resolveMonth(membership.messId, query.monthId);
  const rows = await prisma.sharedExpense.findMany({
    where: {
      messId: membership.messId,
      monthId: month.id,
      ...(query.category && { category: query.category }),
    },
    include: expenseInclude,
    orderBy: [{ billDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(query),
  });
  const page = toPage(rows, query.limit);
  const basis = await basisFor(month);
  return {
    ...page,
    monthId: month.id,
    items: await Promise.all(
      page.items.map((e) => toExpenseDto(e, membership, sharesOf(e, basis).get(membership.id))),
    ),
  };
}

/** One expense with every member's share. */
export async function getExpense(membership: Membership, expenseId: string) {
  const expense = await findExpense(prisma, membership.messId, expenseId);
  const month = await prisma.messMonth.findUniqueOrThrow({ where: { id: expense.monthId } });
  const basis = await basisFor(month);
  const shares = sharesOf(expense, basis);
  const people = new Map(basis.members.map((m) => [m.id, toPerson(m)]));
  for (const s of expense.shares) people.set(s.memberId, toPerson(s.member));
  return {
    ...(await toExpenseDto(expense, membership, shares.get(membership.id))),
    shares: [...shares.entries()]
      .map(([memberId, amount]) => ({ member: people.get(memberId)!, amount: amount.toFixed(2) }))
      .filter((s) => s.member)
      .sort((a, b) => a.member.name.localeCompare(b.member.name)),
  };
}

/** The month's expenses by category, the caller's total share, and how they were paid. */
export async function expenseSummary(membership: Membership, monthId: string | undefined) {
  const month = await resolveMonth(membership.messId, monthId);
  const expenses = await prisma.sharedExpense.findMany({
    where: { monthId: month.id, status: ApprovalStatus.APPROVED },
    select: { category: true, amount: true, paidFrom: true, splitType: true, shares: true },
  });
  const basis = await basisFor(month);
  const byCategory = new Map<ExpenseCategory, Prisma.Decimal>();
  for (const e of expenses)
    byCategory.set(e.category, (byCategory.get(e.category) ?? new Prisma.Decimal(0)).plus(e.amount));

  return {
    monthId: month.id,
    total: sumMoney(expenses.map((e) => e.amount)).toFixed(2),
    count: expenses.length,
    yourShare: sumMoney(expenses.map((e) => sharesOf(e, basis).get(membership.id) ?? 0)).toFixed(2),
    byPaidFrom: {
      MESS_FUND: sumMoney(
        expenses.filter((e) => e.paidFrom === PaidFrom.MESS_FUND).map((e) => e.amount),
      ).toFixed(2),
      OWN_POCKET: sumMoney(
        expenses.filter((e) => e.paidFrom === PaidFrom.OWN_POCKET).map((e) => e.amount),
      ).toFixed(2),
    },
    byCategory: [...byCategory.entries()]
      .map(([category, total]) => ({ category, total: total.toFixed(2) }))
      .sort((a, b) => Number(b.total) - Number(a.total)),
  };
}

/** What each member would pay for an EQUAL or BY_MEAL expense today: the form's live preview. */
export async function previewSplit(
  membership: Membership,
  input: { billDate: string; amount: string; splitType: "EQUAL" | "BY_MEAL" },
) {
  const month = await monthForDate(prisma, membership.messId, input.billDate);
  const basis = await basisFor(month);
  const shares = splitExpense(input.amount, input.splitType, basis);
  return {
    monthId: month.id,
    fellBackToEqual: input.splitType === SplitType.BY_MEAL && basis.totalMeals.isZero(),
    shares: basis.members
      .map((m) => ({
        member: toPerson(m),
        weightedMeals: (basis.meals.get(m.id) ?? 0).toString(),
        amount: (shares.get(m.id) ?? new Prisma.Decimal(0)).toFixed(2),
      }))
      .sort((a, b) => a.member.name.localeCompare(b.member.name)),
  };
}

// ---------- writes ----------

async function announce(
  tx: DbClient,
  membership: Membership,
  expense: { id: string; title: string; amount: Prisma.Decimal; splitType: SplitType },
) {
  const members = await tx.messMember.findMany({
    where: { messId: membership.messId, status: "ACTIVE", userId: { not: membership.userId } },
    select: { userId: true },
  });
  await notify(tx, {
    userIds: members.map((m) => m.userId),
    messId: membership.messId,
    type: NotificationType.EXPENSE_ADDED,
    title: `${expense.title}: ৳${expense.amount.toFixed(2)}`,
    body: `Added to this month's shared costs, ${SPLIT_LABELS[expense.splitType]}.`,
    entity: "SharedExpense",
    entityId: expense.id,
  });
}

/** Managers add shared costs (BUSINESS_RULES §2, §7). */
export async function createExpense(
  membership: Membership,
  input: CreateExpenseInput,
  link: { staffId?: string } = {},
) {
  const month = await monthForPastEntry(prisma, membership.messId, input.billDate, "An expense");
  await assertPayer(membership.messId, input.paidByMemberId);
  if (input.splitType === SplitType.CUSTOM)
    await assertCustomShares(membership.messId, input.amount, input.shares ?? []);
  if (input.receiptKey) await assertReceipt(membership.messId, input.receiptKey);

  const expense = await prisma.$transaction(async (tx) => {
    const created = await tx.sharedExpense.create({
      data: {
        messId: membership.messId,
        monthId: month.id,
        category: input.category,
        title: input.title,
        amount: new Prisma.Decimal(input.amount),
        splitType: input.splitType,
        paidFrom: input.paidFrom,
        paidByMemberId: input.paidFrom === PaidFrom.OWN_POCKET ? input.paidByMemberId! : null,
        billDate: toDbDate(input.billDate),
        receiptUrl: input.receiptKey ?? null,
        createdById: membership.userId,
        staffId: link.staffId ?? null,
        ...(input.splitType === SplitType.CUSTOM && { shares: { create: shareRows(input.shares!) } }),
      },
      include: expenseInclude,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "EXPENSE_CREATED",
      entity: "SharedExpense",
      entityId: created.id,
      after: { title: created.title, amount: created.amount.toFixed(2), splitType: created.splitType },
    });
    await announce(tx, membership, created);
    return created;
  });
  return toExpenseDto(expense, membership, undefined);
}

export async function updateExpense(membership: Membership, expenseId: string, input: UpdateExpenseInput) {
  const before = await findExpense(prisma, membership.messId, expenseId);
  if (before.month.status !== MonthStatus.OPEN) {
    throw ApiError.forbidden("This month is closed, so its expenses can't change", ERROR_CODES.MONTH_CLOSED);
  }
  const month = input.billDate
    ? await monthForPastEntry(prisma, membership.messId, input.billDate, "An expense")
    : null;
  const amount = input.amount ?? before.amount.toString();
  const splitType = input.splitType ?? before.splitType;
  const paidFrom = input.paidFrom ?? before.paidFrom;
  const paidByMemberId =
    paidFrom === PaidFrom.OWN_POCKET ? (input.paidByMemberId ?? before.paidByMemberId) : null;
  if (paidFrom === PaidFrom.OWN_POCKET && !paidByMemberId) throw ApiError.badRequest("Say who paid");
  await assertPayer(membership.messId, input.paidByMemberId);

  const shares =
    splitType === SplitType.CUSTOM
      ? (input.shares ?? before.shares.map((s) => ({ memberId: s.memberId, amount: s.amount.toString() })))
      : [];
  if (splitType === SplitType.CUSTOM) await assertCustomShares(membership.messId, amount, shares);
  if (input.receiptKey) await assertReceipt(membership.messId, input.receiptKey);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.expenseShare.deleteMany({ where: { expenseId: before.id } });
    const row = await tx.sharedExpense.update({
      where: { id: before.id },
      data: {
        ...(input.category && { category: input.category }),
        ...(input.title && { title: input.title }),
        amount: new Prisma.Decimal(amount),
        splitType,
        paidFrom,
        paidByMemberId,
        ...(month && { monthId: month.id, billDate: toDbDate(input.billDate!) }),
        ...(input.receiptKey !== undefined && { receiptUrl: input.receiptKey }),
        shares: { create: shareRows(shares) },
      },
      include: expenseInclude,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "EXPENSE_UPDATED",
      entity: "SharedExpense",
      entityId: row.id,
      before: { amount: before.amount.toFixed(2), splitType: before.splitType },
      after: { amount: row.amount.toFixed(2), splitType: row.splitType },
    });
    return row;
  });
  if (input.receiptKey !== undefined && before.receiptUrl !== input.receiptKey)
    discardFile(before.receiptUrl);
  return toExpenseDto(updated, membership, undefined);
}

export async function deleteExpense(membership: Membership, expenseId: string) {
  const expense = await findExpense(prisma, membership.messId, expenseId);
  if (expense.month.status !== MonthStatus.OPEN) {
    throw ApiError.forbidden("This month is closed, so its expenses can't change", ERROR_CODES.MONTH_CLOSED);
  }
  await prisma.$transaction(async (tx) => {
    await tx.sharedExpense.delete({ where: { id: expense.id } });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "EXPENSE_DELETED",
      entity: "SharedExpense",
      entityId: expense.id,
      before: { title: expense.title, amount: expense.amount.toFixed(2) },
    });
  });
  discardFile(expense.receiptUrl);
}

/**
 * "Pay staff": records a salary as a shared expense linked to the staff member. Paying someone twice
 * in a month (an advance, a bonus) has to be asked for explicitly.
 */
export async function payStaff(membership: Membership, input: PayStaffInput) {
  const staff = await prisma.messStaff.findFirst({ where: { id: input.staffId, messId: membership.messId } });
  if (!staff) throw ApiError.notFound("Staff member not found");
  if (!staff.isActive) throw ApiError.conflict(`${staff.name} doesn't work for the mess any more`);

  const month = await monthForPastEntry(prisma, membership.messId, input.billDate, "A salary");
  if (
    !input.again &&
    (await prisma.sharedExpense.count({ where: { monthId: month.id, staffId: staff.id } })) > 0
  ) {
    throw ApiError.conflict(`${staff.name} was already paid this month`, ERROR_CODES.SALARY_ALREADY_PAID);
  }
  const amount = input.amount ?? staff.monthlySalary.toString();
  return createExpense(
    membership,
    {
      category: SALARY_CATEGORY[staff.role],
      title: `${staff.name}'s salary`,
      amount,
      splitType: input.splitType,
      paidFrom: input.paidFrom,
      paidByMemberId: input.paidByMemberId,
      billDate: input.billDate,
    },
    { staffId: staff.id },
  );
}
