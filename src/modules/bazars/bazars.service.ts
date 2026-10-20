import { ApprovalStatus, MonthStatus, NotificationType, PaidFrom, Prisma } from "@prisma/client";
import { ERROR_CODES } from "../../constants/error-codes.js";
import { audit } from "../../lib/audit.js";
import { logger } from "../../lib/logger.js";
import { notify } from "../../lib/notify.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import { belongsTo, storage } from "../../lib/storage/index.js";
import { hasManagerAccess, type Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { fromDbDate, toDbDate } from "../../utils/date.js";
import { sumMoney } from "../../utils/money.js";
import { orderedIds } from "../../utils/crypto.js";
import { cursorArgs, toPage } from "../../utils/pagination.js";
import { managerUserIds } from "../members/members.queries.js";
import {
  assertMonthEditable,
  ensureCurrentMonth,
  monthForDate,
  monthForPastEntry,
} from "../months/months.service.js";
import type { BazarItemInput, CreateBazarInput, ListBazarsQuery, UpdateBazarInput } from "./bazars.schema.js";

const person = {
  select: { id: true, userId: true, user: { select: { name: true, avatarUrl: true } } },
} as const;
const bazarInclude = {
  shopper: person,
  approvedBy: person,
  month: { select: { id: true, status: true } },
  items: { orderBy: { id: "asc" } },
} satisfies Prisma.BazarInclude;

type BazarRow = Prisma.BazarGetPayload<{ include: typeof bazarInclude }>;

const toPerson = (m: { id: string; user: { name: string; avatarUrl: string | null } }) => ({
  id: m.id,
  name: m.user.name,
  avatarUrl: m.user.avatarUrl,
});

const isMine = (b: Pick<BazarRow, "createdById" | "shopperId">, membership: Membership) =>
  b.createdById === membership.userId || b.shopperId === membership.id;

/** What the caller may do with a bazar (BUSINESS_RULES §10); the UI shows the same. */
function permissions(b: BazarRow, membership: Membership) {
  const open = b.month.status === MonthStatus.OPEN;
  const canManage = hasManagerAccess(membership);
  const ownEditable = isMine(b, membership) && b.status !== ApprovalStatus.APPROVED;
  return {
    canEdit: open && (canManage || ownEditable),
    canDelete: open && (canManage || ownEditable),
    canReview: open && canManage && b.status === ApprovalStatus.PENDING,
  };
}

async function toBazarDto(b: BazarRow, membership: Membership) {
  return {
    id: b.id,
    date: fromDbDate(b.date),
    monthId: b.monthId,
    shopper: toPerson(b.shopper),
    totalAmount: b.totalAmount.toFixed(2),
    paidFrom: b.paidFrom,
    receiptUrl: b.receiptUrl ? await storage.readUrl(b.receiptUrl) : null,
    note: b.note,
    status: b.status,
    approvedBy: b.approvedBy ? toPerson(b.approvedBy) : null,
    approvedAt: b.approvedAt,
    rejectionReason: b.rejectionReason,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    items: b.items.map((i) => ({
      id: i.id,
      name: i.name,
      quantity: i.quantity?.toString() ?? null,
      unit: i.unit,
      totalPrice: i.totalPrice.toFixed(2),
    })),
    ...permissions(b, membership),
  };
}

export type BazarDto = Awaited<ReturnType<typeof toBazarDto>>;

// ---------- validation helpers ----------

/** Itemised bazars total their items; a total sent along must match (it's what the shopper saw). */
function resolveTotal(items: BazarItemInput[], totalAmount: string | undefined) {
  if (items.length === 0) {
    if (totalAmount === undefined) throw ApiError.badRequest("Add items or the total amount");
    return new Prisma.Decimal(totalAmount);
  }
  const sum = sumMoney(items.map((i) => i.totalPrice));
  if (totalAmount !== undefined && !sum.equals(totalAmount)) {
    throw ApiError.unprocessable(
      `The items add up to ${sum.toFixed(2)}, not ${new Prisma.Decimal(totalAmount).toFixed(2)}`,
      ERROR_CODES.TOTAL_MISMATCH,
    );
  }
  return sum;
}

const itemRows = (items: BazarItemInput[]) => {
  const ids = orderedIds(items.length);
  return items.map((i, index) => ({
    id: ids[index],
    name: i.name,
    quantity: i.quantity ? new Prisma.Decimal(i.quantity) : null,
    unit: i.unit || null,
    totalPrice: new Prisma.Decimal(i.totalPrice),
  }));
};

async function assertReceipt(messId: string, key: string) {
  if (!belongsTo(key, messId, "receipt") || !(await storage.stat(key))) {
    throw ApiError.unprocessable(
      "The receipt didn't finish uploading. Try adding it again.",
      ERROR_CODES.RECEIPT_NOT_FOUND,
    );
  }
}

async function activeShopper(membership: Membership, shopperId: string | undefined) {
  const id = shopperId ?? membership.id;
  if (id !== membership.id && !hasManagerAccess(membership)) {
    throw ApiError.forbidden("You can only add your own bazar", ERROR_CODES.INSUFFICIENT_ROLE);
  }
  const shopper = await prisma.messMember.findFirst({
    where: { id, messId: membership.messId, status: "ACTIVE" },
    select: { id: true, userId: true },
  });
  if (!shopper) throw ApiError.notFound("Member not found");
  return shopper;
}

/** Deleting a replaced receipt is best effort: a leftover file is harmless, a failed request isn't. */
function discardFile(key: string | null) {
  if (!key) return;
  storage.delete(key).catch((err) => logger.warn({ err, key }, "Couldn't delete an old receipt"));
}

const findBazar = async (db: DbClient, messId: string, bazarId: string) => {
  const bazar = await db.bazar.findFirst({ where: { id: bazarId, messId }, include: bazarInclude });
  if (!bazar) throw ApiError.notFound("Bazar not found");
  return bazar;
};

// ---------- reads ----------

/** Everyone in the mess sees every bazar (transparency is normal in a mess). */
export async function listBazars(membership: Membership, query: ListBazarsQuery) {
  const rows = await prisma.bazar.findMany({
    where: {
      messId: membership.messId,
      ...(query.monthId && { monthId: query.monthId }),
      ...(query.status && { status: query.status }),
      ...(query.shopperId && { shopperId: query.shopperId }),
      ...(query.paidFrom && { paidFrom: query.paidFrom }),
    },
    include: bazarInclude,
    orderBy: [{ date: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(query),
  });
  const page = toPage(rows, query.limit);
  return { ...page, items: await Promise.all(page.items.map((b) => toBazarDto(b, membership))) };
}

export async function getBazar(membership: Membership, bazarId: string) {
  return toBazarDto(await findBazar(prisma, membership.messId, bazarId), membership);
}

/** Month totals: approved bazar is what the meal rate uses (BUSINESS_RULES §5). */
export async function bazarSummary(membership: Membership, monthId: string | undefined) {
  const month = monthId
    ? await prisma.messMonth.findFirst({ where: { id: monthId, messId: membership.messId } })
    : await monthForDate(prisma, membership.messId, await ensureCurrentMonth(prisma, membership.messId));
  if (!month) throw ApiError.notFound("Month not found");

  const where = { messId: membership.messId, monthId: month.id };
  const [byStatus, byPaidFrom, byShopper] = await Promise.all([
    prisma.bazar.groupBy({ by: ["status"], where, _sum: { totalAmount: true }, _count: true }),
    prisma.bazar.groupBy({
      by: ["paidFrom"],
      where: { ...where, status: ApprovalStatus.APPROVED },
      _sum: { totalAmount: true },
    }),
    prisma.bazar.groupBy({
      by: ["shopperId"],
      where: { ...where, status: ApprovalStatus.APPROVED },
      _sum: { totalAmount: true },
      _count: true,
    }),
  ]);
  const shoppers = await prisma.messMember.findMany({
    where: { id: { in: byShopper.map((s) => s.shopperId) } },
    select: person.select,
  });

  const status = (s: ApprovalStatus) => {
    const row = byStatus.find((r) => r.status === s);
    return { total: (row?._sum.totalAmount ?? new Prisma.Decimal(0)).toFixed(2), count: row?._count ?? 0 };
  };
  const paid = (p: PaidFrom) =>
    (byPaidFrom.find((r) => r.paidFrom === p)?._sum.totalAmount ?? new Prisma.Decimal(0)).toFixed(2);

  return {
    monthId: month.id,
    approved: status(ApprovalStatus.APPROVED),
    pending: status(ApprovalStatus.PENDING),
    rejected: status(ApprovalStatus.REJECTED),
    byPaidFrom: { MESS_FUND: paid(PaidFrom.MESS_FUND), OWN_POCKET: paid(PaidFrom.OWN_POCKET) },
    byShopper: byShopper
      .map((s) => ({
        member: toPerson(shoppers.find((m) => m.id === s.shopperId)!),
        total: (s._sum.totalAmount ?? new Prisma.Decimal(0)).toFixed(2),
        count: s._count,
      }))
      .sort((a, b) => Number(b.total) - Number(a.total)),
  };
}

// ---------- writes ----------

/**
 * Records a bazar. It's approved straight away when the mess doesn't require approval or a manager
 * adds it; otherwise the managers are asked to review it. A bazar duty for that day is marked done.
 */
export async function createBazar(membership: Membership, input: CreateBazarInput) {
  const shopper = await activeShopper(membership, input.shopperId);
  const month = await monthForPastEntry(prisma, membership.messId, input.date, "A bazar");
  const total = resolveTotal(input.items, input.totalAmount);
  if (input.receiptKey) await assertReceipt(membership.messId, input.receiptKey);

  const settings = await prisma.messSetting.findUnique({
    where: { messId: membership.messId },
    select: { requireBazarApproval: true },
  });
  const canManage = hasManagerAccess(membership);
  const approved = canManage || settings?.requireBazarApproval === false;

  const bazar = await prisma.$transaction(async (tx) => {
    const created = await tx.bazar.create({
      data: {
        messId: membership.messId,
        monthId: month.id,
        shopperId: shopper.id,
        date: toDbDate(input.date),
        totalAmount: total,
        paidFrom: input.paidFrom,
        receiptUrl: input.receiptKey ?? null,
        note: input.note ?? null,
        status: approved ? ApprovalStatus.APPROVED : ApprovalStatus.PENDING,
        ...(approved && { approvedAt: new Date(), approvedById: canManage ? membership.id : null }),
        createdById: membership.userId,
        items: { create: itemRows(input.items) },
      },
      include: bazarInclude,
    });

    await tx.bazarSchedule.updateMany({
      where: { messId: membership.messId, memberId: shopper.id, date: toDbDate(input.date) },
      data: { isDone: true },
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "BAZAR_CREATED",
      entity: "Bazar",
      entityId: created.id,
      after: {
        date: input.date,
        totalAmount: total.toFixed(2),
        paidFrom: input.paidFrom,
        status: created.status,
      },
    });

    if (!approved) {
      const managers = (await managerUserIds(tx, membership.messId)).filter((id) => id !== membership.userId);
      await notify(tx, {
        userIds: managers,
        messId: membership.messId,
        type: NotificationType.BAZAR_SUBMITTED,
        title: `${created.shopper.user.name} added a bazar`,
        body: `৳${total.toFixed(2)} on ${input.date}. Review it so it counts toward the meal rate.`,
        entity: "Bazar",
        entityId: created.id,
      });
    } else if (shopper.id !== membership.id) {
      await notify(tx, {
        userIds: [shopper.userId],
        messId: membership.messId,
        type: NotificationType.BAZAR_APPROVED,
        title: "A manager recorded your bazar",
        body: `৳${total.toFixed(2)} on ${input.date}`,
        entity: "Bazar",
        entityId: created.id,
      });
    }
    return created;
  });
  return toBazarDto(bazar, membership);
}

/**
 * Edits a bazar (BUSINESS_RULES §10): the creator while it's PENDING or REJECTED (a rejected bazar goes
 * back to PENDING); managers in any state while the month is OPEN.
 */
export async function updateBazar(membership: Membership, bazarId: string, input: UpdateBazarInput) {
  const before = await findBazar(prisma, membership.messId, bazarId);
  if (!permissions(before, membership).canEdit) {
    throw ApiError.forbidden(
      before.month.status !== MonthStatus.OPEN
        ? "This month is closed, so its bazars can't change"
        : "Only a manager can change an approved bazar",
      before.month.status !== MonthStatus.OPEN ? ERROR_CODES.MONTH_CLOSED : ERROR_CODES.NOT_EDITABLE,
    );
  }
  const canManage = hasManagerAccess(membership);

  const shopper = input.shopperId ? await activeShopper(membership, input.shopperId) : null;
  const month = input.date ? await monthForPastEntry(prisma, membership.messId, input.date, "A bazar") : null;
  const items = input.items;
  let total: Prisma.Decimal | undefined;
  if (items !== undefined) {
    total = resolveTotal(items, input.totalAmount);
  } else if (input.totalAmount !== undefined) {
    // An itemised bazar's total always follows its items.
    if (before.items.length > 0 && !before.totalAmount.equals(input.totalAmount)) {
      throw ApiError.unprocessable("Change the items to change the total", ERROR_CODES.TOTAL_MISMATCH);
    }
    total = new Prisma.Decimal(input.totalAmount);
  }
  if (input.receiptKey) await assertReceipt(membership.messId, input.receiptKey);

  // A creator fixing a rejected bazar sends it back for review.
  const resubmit = before.status === ApprovalStatus.REJECTED && !canManage;

  const updated = await prisma.$transaction(async (tx) => {
    if (items !== undefined) {
      await tx.bazarItem.deleteMany({ where: { bazarId: before.id } });
      await tx.bazarItem.createMany({ data: itemRows(items).map((i) => ({ ...i, bazarId: before.id })) });
    }
    const bazar = await tx.bazar.update({
      where: { id: before.id },
      data: {
        ...(shopper && { shopperId: shopper.id }),
        ...(month && { monthId: month.id, date: toDbDate(input.date!) }),
        ...(total && { totalAmount: total }),
        ...(input.paidFrom && { paidFrom: input.paidFrom }),
        ...(input.receiptKey !== undefined && { receiptUrl: input.receiptKey }),
        ...(input.note !== undefined && { note: input.note }),
        ...(resubmit && { status: ApprovalStatus.PENDING, rejectionReason: null }),
      },
      include: bazarInclude,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "BAZAR_UPDATED",
      entity: "Bazar",
      entityId: bazar.id,
      before: {
        date: fromDbDate(before.date),
        totalAmount: before.totalAmount.toFixed(2),
        status: before.status,
      },
      after: {
        date: fromDbDate(bazar.date),
        totalAmount: bazar.totalAmount.toFixed(2),
        status: bazar.status,
      },
    });
    if (resubmit) {
      const managers = (await managerUserIds(tx, membership.messId)).filter((id) => id !== membership.userId);
      await notify(tx, {
        userIds: managers,
        messId: membership.messId,
        type: NotificationType.BAZAR_SUBMITTED,
        title: `${bazar.shopper.user.name} fixed a bazar`,
        body: `৳${bazar.totalAmount.toFixed(2)} on ${fromDbDate(bazar.date)} is ready for review again.`,
        entity: "Bazar",
        entityId: bazar.id,
      });
    }
    return bazar;
  });

  if (input.receiptKey !== undefined && before.receiptUrl !== input.receiptKey)
    discardFile(before.receiptUrl);
  return toBazarDto(updated, membership);
}

export async function deleteBazar(membership: Membership, bazarId: string) {
  const bazar = await findBazar(prisma, membership.messId, bazarId);
  if (!permissions(bazar, membership).canDelete) {
    throw ApiError.forbidden(
      bazar.month.status !== MonthStatus.OPEN
        ? "This month is closed, so its bazars can't change"
        : "Only a manager can delete an approved bazar",
      bazar.month.status !== MonthStatus.OPEN ? ERROR_CODES.MONTH_CLOSED : ERROR_CODES.NOT_EDITABLE,
    );
  }
  await prisma.$transaction(async (tx) => {
    await tx.bazar.delete({ where: { id: bazar.id } });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "BAZAR_DELETED",
      entity: "Bazar",
      entityId: bazar.id,
      before: {
        date: fromDbDate(bazar.date),
        shopperId: bazar.shopperId,
        totalAmount: bazar.totalAmount.toFixed(2),
        status: bazar.status,
      },
    });
  });
  discardFile(bazar.receiptUrl);
}

/** Managers approve or reject a PENDING bazar; rejecting needs a reason. The shopper is told either way. */
export async function reviewBazar(
  membership: Membership,
  bazarId: string,
  decision: { status: "APPROVED" } | { status: "REJECTED"; reason: string },
) {
  const bazar = await findBazar(prisma, membership.messId, bazarId);
  assertMonthEditable(bazar.month);
  if (bazar.status !== ApprovalStatus.PENDING) throw ApiError.conflict("This bazar was already reviewed");

  const approved = decision.status === ApprovalStatus.APPROVED;
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.bazar.update({
      where: { id: bazar.id },
      data: approved
        ? {
            status: ApprovalStatus.APPROVED,
            approvedById: membership.id,
            approvedAt: new Date(),
            rejectionReason: null,
          }
        : {
            status: ApprovalStatus.REJECTED,
            approvedById: membership.id,
            approvedAt: new Date(),
            rejectionReason: decision.reason,
          },
      include: bazarInclude,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: approved ? "BAZAR_APPROVED" : "BAZAR_REJECTED",
      entity: "Bazar",
      entityId: bazar.id,
      after: { status: row.status, ...(!approved && { reason: decision.reason }) },
    });
    if (bazar.shopper.userId !== membership.userId) {
      await notify(tx, {
        userIds: [bazar.shopper.userId],
        messId: membership.messId,
        type: approved ? NotificationType.BAZAR_APPROVED : NotificationType.BAZAR_REJECTED,
        title: approved ? "Your bazar was approved" : "Your bazar was rejected",
        body: approved
          ? `৳${bazar.totalAmount.toFixed(2)} on ${fromDbDate(bazar.date)} now counts toward the meal rate.`
          : `৳${bazar.totalAmount.toFixed(2)} on ${fromDbDate(bazar.date)}: ${decision.reason}`,
        entity: "Bazar",
        entityId: bazar.id,
      });
    }
    return row;
  });
  return toBazarDto(updated, membership);
}
