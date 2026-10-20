import { ApprovalStatus, MonthStatus, NotificationType, PaymentMethod, Prisma } from "@prisma/client";
import { ERROR_CODES } from "../../constants/error-codes.js";
import { audit } from "../../lib/audit.js";
import { notify } from "../../lib/notify.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import { hasManagerAccess, type Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { todayIn, zonedDateTime, type DateString } from "../../utils/date.js";
import { cursorArgs, toPage } from "../../utils/pagination.js";
import { managerUserIds } from "../members/members.queries.js";
import {
  assertMonthEditable,
  ensureCurrentMonth,
  monthForDate,
  monthForPastEntry,
} from "../months/months.service.js";
import type { CreateDepositInput, ListDepositsQuery, UpdateDepositInput } from "./deposits.schema.js";

const person = {
  select: { id: true, userId: true, user: { select: { name: true, avatarUrl: true } } },
} as const;
const depositInclude = {
  member: person,
  receivedBy: person,
  month: { select: { id: true, status: true } },
  mess: { select: { timezone: true } },
} satisfies Prisma.DepositInclude;

type DepositRow = Prisma.DepositGetPayload<{ include: typeof depositInclude }>;

const toPerson = (m: { id: string; user: { name: string; avatarUrl: string | null } }) => ({
  id: m.id,
  name: m.user.name,
  avatarUrl: m.user.avatarUrl,
});

const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: "cash",
  BKASH: "bKash",
  NAGAD: "Nagad",
  ROCKET: "Rocket",
  BANK: "bank",
  OTHER: "other",
};

/**
 * `depositedAt` is a timestamp; its calendar day in the mess timezone decides the month. A deposit
 * made today keeps the current time, an earlier one is stored at noon (safely inside that day).
 */
const depositedAtFor = (date: DateString, timezone: string) =>
  date === todayIn(timezone) ? new Date() : zonedDateTime(date, "12:00", timezone);

/** What the caller may do with a deposit (BUSINESS_RULES §10); the UI shows the same. */
function permissions(d: DepositRow, membership: Membership) {
  const open = d.month.status === MonthStatus.OPEN;
  const canManage = hasManagerAccess(membership);
  const ownEditable = d.memberId === membership.id && d.status !== ApprovalStatus.APPROVED;
  return {
    canEdit: open && (canManage || ownEditable),
    canDelete: open && (canManage || ownEditable),
    canReview: open && canManage && d.status === ApprovalStatus.PENDING,
  };
}

const toDepositDto = (d: DepositRow, membership: Membership) => ({
  id: d.id,
  date: todayIn(d.mess.timezone, d.depositedAt),
  depositedAt: d.depositedAt,
  monthId: d.monthId,
  member: toPerson(d.member),
  amount: d.amount.toFixed(2),
  method: d.method,
  transactionRef: d.transactionRef,
  note: d.note,
  status: d.status,
  receivedBy: d.receivedBy ? toPerson(d.receivedBy) : null,
  rejectionReason: d.rejectionReason,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  ...permissions(d, membership),
});

export type DepositDto = ReturnType<typeof toDepositDto>;

async function findDeposit(db: DbClient, messId: string, depositId: string) {
  const deposit = await db.deposit.findFirst({ where: { id: depositId, messId }, include: depositInclude });
  if (!deposit) throw ApiError.notFound("Deposit not found");
  return deposit;
}

async function activeMember(membership: Membership, memberId: string | undefined) {
  const id = memberId ?? membership.id;
  if (id !== membership.id && !hasManagerAccess(membership)) {
    throw ApiError.forbidden("You can only add your own deposit", ERROR_CODES.INSUFFICIENT_ROLE);
  }
  const member = await prisma.messMember.findFirst({
    where: { id, messId: membership.messId, status: "ACTIVE" },
    select: { id: true, userId: true, user: { select: { name: true } } },
  });
  if (!member) throw ApiError.notFound("Member not found");
  return member;
}

/** The same mobile-money transaction can't be counted twice (unless the earlier one was rejected). */
async function assertNewTransaction(
  messId: string,
  method: PaymentMethod,
  ref: string | null | undefined,
  exceptId?: string,
) {
  if (!ref || method === PaymentMethod.CASH) return;
  const existing = await prisma.deposit.findFirst({
    where: {
      messId,
      method,
      transactionRef: { equals: ref, mode: "insensitive" },
      status: { not: ApprovalStatus.REJECTED },
      ...(exceptId && { id: { not: exceptId } }),
    },
    select: { id: true },
  });
  if (existing) {
    throw ApiError.conflict(
      `This ${METHOD_LABELS[method]} transaction is already recorded`,
      ERROR_CODES.DUPLICATE_TRANSACTION,
    );
  }
}

const notEditable = (d: DepositRow) =>
  d.month.status !== MonthStatus.OPEN
    ? ApiError.forbidden("This month is closed, so its deposits can't change", ERROR_CODES.MONTH_CLOSED)
    : ApiError.forbidden("Only a manager can change an approved deposit", ERROR_CODES.NOT_EDITABLE);

// ---------- reads ----------

/** Members see their own deposits; managers see everyone's. */
export async function listDeposits(membership: Membership, query: ListDepositsQuery) {
  const canManage = hasManagerAccess(membership);
  const rows = await prisma.deposit.findMany({
    where: {
      messId: membership.messId,
      ...(canManage ? query.memberId && { memberId: query.memberId } : { memberId: membership.id }),
      ...(query.monthId && { monthId: query.monthId }),
      ...(query.status && { status: query.status }),
      ...(query.method && { method: query.method }),
    },
    include: depositInclude,
    orderBy: [{ depositedAt: "desc" }, { id: "desc" }],
    ...cursorArgs(query),
  });
  const page = toPage(rows, query.limit);
  return { ...page, items: page.items.map((d) => toDepositDto(d, membership)) };
}

export async function getDeposit(membership: Membership, depositId: string) {
  const deposit = await findDeposit(prisma, membership.messId, depositId);
  if (deposit.memberId !== membership.id && !hasManagerAccess(membership))
    throw ApiError.notFound("Deposit not found");
  return toDepositDto(deposit, membership);
}

/**
 * Month totals. Everyone sees each member's approved total (it's on the month summary anyway);
 * pending totals are for managers, and for members only their own.
 */
export async function depositSummary(membership: Membership, monthId: string | undefined) {
  const month = monthId
    ? await prisma.messMonth.findFirst({ where: { id: monthId, messId: membership.messId } })
    : await monthForDate(prisma, membership.messId, await ensureCurrentMonth(prisma, membership.messId));
  if (!month) throw ApiError.notFound("Month not found");

  const canManage = hasManagerAccess(membership);
  const where = { messId: membership.messId, monthId: month.id };
  const mine = canManage ? {} : { memberId: membership.id };
  const [byStatus, byMethod, byMember] = await Promise.all([
    prisma.deposit.groupBy({
      by: ["status"],
      where: { ...where, ...mine },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.deposit.groupBy({
      by: ["method"],
      where: { ...where, ...mine, status: ApprovalStatus.APPROVED },
      _sum: { amount: true },
    }),
    prisma.deposit.groupBy({
      by: ["memberId"],
      where: { ...where, status: ApprovalStatus.APPROVED },
      _sum: { amount: true },
      _count: true,
    }),
  ]);
  const members = await prisma.messMember.findMany({
    where: { id: { in: byMember.map((m) => m.memberId) } },
    select: person.select,
  });
  const zero = new Prisma.Decimal(0);
  const status = (s: ApprovalStatus) => {
    const row = byStatus.find((r) => r.status === s);
    return { total: (row?._sum.amount ?? zero).toFixed(2), count: row?._count ?? 0 };
  };

  return {
    monthId: month.id,
    approved: status(ApprovalStatus.APPROVED),
    pending: status(ApprovalStatus.PENDING),
    rejected: status(ApprovalStatus.REJECTED),
    byMethod: Object.fromEntries(
      Object.values(PaymentMethod).map((m) => [
        m,
        (byMethod.find((r) => r.method === m)?._sum.amount ?? zero).toFixed(2),
      ]),
    ) as Record<PaymentMethod, string>,
    byMember: byMember
      .map((m) => ({
        member: toPerson(members.find((x) => x.id === m.memberId)!),
        total: (m._sum.amount ?? zero).toFixed(2),
        count: m._count,
      }))
      .sort((a, b) => Number(b.total) - Number(a.total)),
  };
}

// ---------- writes ----------

/**
 * Records a deposit. A manager recording one (or a mess without deposit approval) makes it APPROVED
 * straight away, with the manager as the receiver; otherwise the managers are asked to confirm it.
 */
export async function createDeposit(membership: Membership, input: CreateDepositInput) {
  const member = await activeMember(membership, input.memberId);
  const month = await monthForPastEntry(prisma, membership.messId, input.date, "A deposit");
  await assertNewTransaction(membership.messId, input.method, input.transactionRef);

  const [mess, settings] = await Promise.all([
    prisma.mess.findUniqueOrThrow({ where: { id: membership.messId }, select: { timezone: true } }),
    prisma.messSetting.findUnique({
      where: { messId: membership.messId },
      select: { requireDepositApproval: true },
    }),
  ]);
  const canManage = hasManagerAccess(membership);
  const approved = canManage || settings?.requireDepositApproval === false;
  const amount = new Prisma.Decimal(input.amount);

  const deposit = await prisma.$transaction(async (tx) => {
    const created = await tx.deposit.create({
      data: {
        messId: membership.messId,
        monthId: month.id,
        memberId: member.id,
        amount,
        method: input.method,
        transactionRef: input.transactionRef || null,
        note: input.note ?? null,
        depositedAt: depositedAtFor(input.date, mess.timezone),
        status: approved ? ApprovalStatus.APPROVED : ApprovalStatus.PENDING,
        receivedById: approved && canManage ? membership.id : null,
      },
      include: depositInclude,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "DEPOSIT_CREATED",
      entity: "Deposit",
      entityId: created.id,
      after: {
        memberId: member.id,
        date: input.date,
        amount: amount.toFixed(2),
        method: input.method,
        status: created.status,
      },
    });

    if (!approved) {
      const managers = (await managerUserIds(tx, membership.messId)).filter((id) => id !== membership.userId);
      await notify(tx, {
        userIds: managers,
        messId: membership.messId,
        type: NotificationType.DEPOSIT_SUBMITTED,
        title: `${member.user.name} paid ৳${amount.toFixed(2)}`,
        body: `By ${METHOD_LABELS[input.method]}${input.transactionRef ? ` (${input.transactionRef})` : ""}. Confirm it once you've received it.`,
        entity: "Deposit",
        entityId: created.id,
      });
    } else if (member.id !== membership.id) {
      await notify(tx, {
        userIds: [member.userId],
        messId: membership.messId,
        type: NotificationType.DEPOSIT_APPROVED,
        title: `Your deposit of ৳${amount.toFixed(2)} was recorded`,
        body: `${created.receivedBy?.user.name ?? "A manager"} received it by ${METHOD_LABELS[input.method]}.`,
        entity: "Deposit",
        entityId: created.id,
      });
    }
    return created;
  });
  return toDepositDto(deposit, membership);
}

/**
 * Edits a deposit (BUSINESS_RULES §10): the member while it's PENDING or REJECTED (a rejected deposit
 * goes back to PENDING); managers in any state while the month is OPEN.
 */
export async function updateDeposit(membership: Membership, depositId: string, input: UpdateDepositInput) {
  const before = await findDeposit(prisma, membership.messId, depositId);
  if (before.memberId !== membership.id && !hasManagerAccess(membership))
    throw ApiError.notFound("Deposit not found");
  if (!permissions(before, membership).canEdit) throw notEditable(before);

  const month = input.date
    ? await monthForPastEntry(prisma, membership.messId, input.date, "A deposit")
    : null;
  const method = input.method ?? before.method;
  const ref = input.transactionRef !== undefined ? input.transactionRef : before.transactionRef;
  if (input.method !== undefined || input.transactionRef !== undefined) {
    await assertNewTransaction(membership.messId, method, ref, before.id);
  }
  const resubmit = before.status === ApprovalStatus.REJECTED && !hasManagerAccess(membership);

  const updated = await prisma.$transaction(async (tx) => {
    const deposit = await tx.deposit.update({
      where: { id: before.id },
      data: {
        ...(month && { monthId: month.id, depositedAt: depositedAtFor(input.date!, before.mess.timezone) }),
        ...(input.amount && { amount: new Prisma.Decimal(input.amount) }),
        ...(input.method && { method: input.method }),
        ...(input.transactionRef !== undefined && { transactionRef: input.transactionRef || null }),
        ...(input.note !== undefined && { note: input.note }),
        ...(resubmit && { status: ApprovalStatus.PENDING, rejectionReason: null, receivedById: null }),
      },
      include: depositInclude,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "DEPOSIT_UPDATED",
      entity: "Deposit",
      entityId: deposit.id,
      before: { amount: before.amount.toFixed(2), method: before.method, status: before.status },
      after: { amount: deposit.amount.toFixed(2), method: deposit.method, status: deposit.status },
    });
    if (resubmit) {
      const managers = (await managerUserIds(tx, membership.messId)).filter((id) => id !== membership.userId);
      await notify(tx, {
        userIds: managers,
        messId: membership.messId,
        type: NotificationType.DEPOSIT_SUBMITTED,
        title: `${deposit.member.user.name} fixed a deposit`,
        body: `৳${deposit.amount.toFixed(2)} by ${METHOD_LABELS[deposit.method]} is ready to confirm again.`,
        entity: "Deposit",
        entityId: deposit.id,
      });
    }
    return deposit;
  });
  return toDepositDto(updated, membership);
}

export async function deleteDeposit(membership: Membership, depositId: string) {
  const deposit = await findDeposit(prisma, membership.messId, depositId);
  if (deposit.memberId !== membership.id && !hasManagerAccess(membership))
    throw ApiError.notFound("Deposit not found");
  if (!permissions(deposit, membership).canDelete) throw notEditable(deposit);
  await prisma.$transaction(async (tx) => {
    await tx.deposit.delete({ where: { id: deposit.id } });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "DEPOSIT_DELETED",
      entity: "Deposit",
      entityId: deposit.id,
      before: {
        memberId: deposit.memberId,
        amount: deposit.amount.toFixed(2),
        method: deposit.method,
        status: deposit.status,
      },
    });
  });
}

/** Managers confirm a pending deposit once they have the money, or reject it with a reason. */
export async function reviewDeposit(
  membership: Membership,
  depositId: string,
  decision: { status: "APPROVED" } | { status: "REJECTED"; reason: string },
) {
  const deposit = await findDeposit(prisma, membership.messId, depositId);
  assertMonthEditable(deposit.month);
  if (deposit.status !== ApprovalStatus.PENDING) throw ApiError.conflict("This deposit was already reviewed");

  const approved = decision.status === ApprovalStatus.APPROVED;
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.deposit.update({
      where: { id: deposit.id },
      data: approved
        ? { status: ApprovalStatus.APPROVED, receivedById: membership.id, rejectionReason: null }
        : { status: ApprovalStatus.REJECTED, receivedById: membership.id, rejectionReason: decision.reason },
      include: depositInclude,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: approved ? "DEPOSIT_APPROVED" : "DEPOSIT_REJECTED",
      entity: "Deposit",
      entityId: deposit.id,
      after: { status: row.status, ...(!approved && { reason: decision.reason }) },
    });
    if (deposit.member.userId !== membership.userId) {
      await notify(tx, {
        userIds: [deposit.member.userId],
        messId: membership.messId,
        type: approved ? NotificationType.DEPOSIT_APPROVED : NotificationType.DEPOSIT_REJECTED,
        title: approved ? "Your deposit was confirmed" : "Your deposit was rejected",
        body: approved
          ? `৳${deposit.amount.toFixed(2)} is now in your balance.`
          : `৳${deposit.amount.toFixed(2)}: ${decision.reason}`,
        entity: "Deposit",
        entityId: deposit.id,
      });
    }
    return row;
  });
  return toDepositDto(updated, membership);
}
