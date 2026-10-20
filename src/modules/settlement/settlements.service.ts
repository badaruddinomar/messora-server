import { MonthStatus, NotificationType, Prisma, SettlementDirection, type MessMonth } from "@prisma/client";
import { ERROR_CODES } from "../../constants/error-codes.js";
import { audit } from "../../lib/audit.js";
import { notify } from "../../lib/notify.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import { hasManagerAccess, type Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { todayIn, zonedDateTime } from "../../utils/date.js";
import { assertMonthEditable, monthForPastEntry, monthLabel } from "../months/months.service.js";
import type { RecordSettlementInput } from "./settlement.schema.js";

const money = (d: Prisma.Decimal) => d.toFixed(2);

const summaryInclude = {
  member: { select: { id: true, userId: true, user: { select: { name: true, avatarUrl: true } } } },
  settlements: { orderBy: { paidAt: "asc" } },
} satisfies Prisma.MemberMonthSummaryInclude;

type SummaryRow = Prisma.MemberMonthSummaryGetPayload<{ include: typeof summaryInclude }>;

/** The month after this one, if it exists. */
const nextMonth = (db: DbClient, month: Pick<MessMonth, "messId" | "endDate">) =>
  db.messMonth.findFirst({
    where: { messId: month.messId, startDate: { gt: month.endDate } },
    orderBy: { startDate: "asc" },
  });

async function closedMonth(db: DbClient, messId: string, monthId: string) {
  const month = await db.messMonth.findFirst({ where: { id: monthId, messId } });
  if (!month) throw ApiError.notFound("Month not found");
  if (month.status !== MonthStatus.CLOSED)
    throw ApiError.conflict("Balances are settled once the month is closed");
  return month;
}

/**
 * A closed month's balances can be settled while the next month is still open; after that they've
 * carried into the next month's bill (BUSINESS_RULES §8) and are settled there.
 */
async function assertCollectable(db: DbClient, month: MessMonth) {
  const next = await nextMonth(db, month);
  if (next?.status === MonthStatus.CLOSED) {
    throw ApiError.unprocessable(
      `This balance carried into ${monthLabel(next)}. Settle it from there.`,
      ERROR_CODES.BALANCE_CARRIED_OVER,
    );
  }
}

const remainingOf = (s: { closingBalance: Prisma.Decimal; settledAmount: Prisma.Decimal }) =>
  s.closingBalance.abs().minus(s.settledAmount);

function toSettlementRow(s: SummaryRow, carried: boolean) {
  return {
    summaryId: s.id,
    member: { id: s.member.id, name: s.member.user.name, avatarUrl: s.member.user.avatarUrl },
    closingBalance: money(s.closingBalance),
    /** MEMBER_TO_MESS: they pay a due; MESS_TO_MEMBER: they get a refund; null: nothing to settle. */
    direction: s.closingBalance.isZero()
      ? null
      : s.closingBalance.isNegative()
        ? SettlementDirection.MEMBER_TO_MESS
        : SettlementDirection.MESS_TO_MEMBER,
    settledAmount: money(s.settledAmount),
    remaining: money(remainingOf(s)),
    isSettled: s.isSettled,
    /** The next month has closed, so whatever is left now lives on in its bill. */
    carriedOver: carried && !s.isSettled,
    payments: s.settlements.map((p) => ({
      id: p.id,
      direction: p.direction,
      amount: money(p.amount),
      method: p.method,
      transactionRef: p.transactionRef,
      note: p.note,
      paidAt: p.paidAt,
    })),
  };
}

/** Who still owes, and who's owed, from a closed month. Members see their own row; managers everyone's. */
export async function listSettlements(
  membership: Membership,
  monthId: string,
  status?: "settled" | "unsettled",
) {
  const month = await closedMonth(prisma, membership.messId, monthId);
  const next = await nextMonth(prisma, month);
  const summaries = await prisma.memberMonthSummary.findMany({
    where: {
      monthId,
      ...(!hasManagerAccess(membership) && { memberId: membership.id }),
      ...(status && { isSettled: status === "settled" }),
    },
    include: summaryInclude,
  });
  const rows = summaries
    .map((s) => toSettlementRow(s, next?.status === MonthStatus.CLOSED))
    .sort((a, b) => Number(a.closingBalance) - Number(b.closingBalance));
  return {
    monthId,
    collectable: next?.status !== MonthStatus.CLOSED,
    totals: {
      dueToMess: money(
        summaries
          .filter((s) => s.closingBalance.isNegative())
          .reduce((t, s) => t.plus(remainingOf(s)), new Prisma.Decimal(0)),
      ),
      owedToMembers: money(
        summaries
          .filter((s) => s.closingBalance.isPositive() && !s.closingBalance.isZero())
          .reduce((t, s) => t.plus(remainingOf(s)), new Prisma.Decimal(0)),
      ),
    },
    rows,
  };
}

/**
 * Records money changing hands for a closed month's balance: a member paying a due, or the mess
 * refunding a credit. The payment belongs to the month it's made in (it moves that month's cash, §9).
 */
export async function recordSettlement(
  membership: Membership,
  monthId: string,
  input: RecordSettlementInput,
) {
  const month = await closedMonth(prisma, membership.messId, monthId);
  await assertCollectable(prisma, month);
  const summary = await prisma.memberMonthSummary.findUnique({
    where: { monthId_memberId: { monthId, memberId: input.memberId } },
    include: summaryInclude,
  });
  if (!summary) throw ApiError.notFound("That member has no bill for this month");
  if (summary.isSettled || summary.closingBalance.isZero())
    throw ApiError.conflict("This balance is already settled");

  const amount = new Prisma.Decimal(input.amount);
  const remaining = remainingOf(summary);
  if (amount.greaterThan(remaining)) {
    throw ApiError.unprocessable(`Only ৳${money(remaining)} is left to settle`, ERROR_CODES.OVERPAYMENT);
  }
  const mess = await prisma.mess.findUniqueOrThrow({
    where: { id: membership.messId },
    select: { timezone: true },
  });
  const today = todayIn(mess.timezone);
  const date = input.date ?? today;
  const paymentMonth = await monthForPastEntry(prisma, membership.messId, date, "A payment");
  const direction = summary.closingBalance.isNegative()
    ? SettlementDirection.MEMBER_TO_MESS
    : SettlementDirection.MESS_TO_MEMBER;
  const settledAmount = summary.settledAmount.plus(amount);
  const isSettled = settledAmount.equals(summary.closingBalance.abs());

  const updated = await prisma.$transaction(async (tx) => {
    await tx.settlementPayment.create({
      data: {
        messId: membership.messId,
        monthId: paymentMonth.id,
        summaryId: summary.id,
        memberId: summary.memberId,
        direction,
        amount,
        method: input.method,
        transactionRef: input.transactionRef || null,
        note: input.note ?? null,
        recordedById: membership.id,
        paidAt: date === today ? new Date() : zonedDateTime(date, "12:00", mess.timezone),
      },
    });
    const row = await tx.memberMonthSummary.update({
      where: { id: summary.id },
      data: { settledAmount, isSettled, settledAt: isSettled ? new Date() : null },
      include: summaryInclude,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "SETTLEMENT_RECORDED",
      entity: "MemberMonthSummary",
      entityId: summary.id,
      after: { direction, amount: money(amount), settledAmount: money(settledAmount), isSettled },
    });
    if (summary.member.userId !== membership.userId) {
      await notify(tx, {
        userIds: [summary.member.userId],
        messId: membership.messId,
        type: NotificationType.SETTLEMENT_RECORDED,
        title:
          direction === SettlementDirection.MEMBER_TO_MESS
            ? `Your payment of ৳${money(amount)} was recorded`
            : `You were refunded ৳${money(amount)}`,
        body: isSettled
          ? `Your ${monthLabel(month)} balance is settled.`
          : `৳${money(remainingOf(row))} of your ${monthLabel(month)} balance is left.`,
        entity: "MemberMonthSummary",
        entityId: summary.id,
      });
    }
    return row;
  });
  return toSettlementRow(updated, false);
}

/** Undoes a payment recorded by mistake, while its month is still open. */
export async function deleteSettlement(membership: Membership, settlementId: string) {
  const payment = await prisma.settlementPayment.findFirst({
    where: { id: settlementId, messId: membership.messId },
    include: { month: true, summary: { include: { month: true } } },
  });
  if (!payment) throw ApiError.notFound("Payment not found");
  assertMonthEditable(payment.month);
  await assertCollectable(prisma, payment.summary.month);

  await prisma.$transaction(async (tx) => {
    await tx.settlementPayment.delete({ where: { id: payment.id } });
    await tx.memberMonthSummary.update({
      where: { id: payment.summaryId },
      data: {
        settledAmount: payment.summary.settledAmount.minus(payment.amount),
        isSettled: false,
        settledAt: null,
      },
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "SETTLEMENT_DELETED",
      entity: "MemberMonthSummary",
      entityId: payment.summaryId,
      before: { amount: money(payment.amount), direction: payment.direction },
    });
  });
}
