import { ChargeType, MonthStatus, NotificationType, Prisma } from "@prisma/client";
import { ERROR_CODES } from "../../constants/error-codes.js";
import { audit } from "../../lib/audit.js";
import { notify } from "../../lib/notify.js";
import { prisma } from "../../lib/prisma.js";
import { hasManagerAccess, type Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { fromDbDate } from "../../utils/date.js";
import { sumMoney } from "../../utils/money.js";
import { assertMonthEditable, ensureCurrentMonth, monthForDate } from "../months/months.service.js";
import type { CreateChargeInput, UpdateChargeInput } from "./charges.schema.js";

const chargeInclude = {
  member: { select: { id: true, userId: true, user: { select: { name: true, avatarUrl: true } } } },
  month: { select: { id: true, status: true } },
} satisfies Prisma.MemberChargeInclude;

type ChargeRow = Prisma.MemberChargeGetPayload<{ include: typeof chargeInclude }>;

const TYPE_LABELS: Record<ChargeType, string> = {
  SEAT_RENT: "Seat rent",
  FINE: "Fine",
  PERSONAL: "Personal charge",
  ADJUSTMENT: "Adjustment",
};

const toChargeDto = (c: ChargeRow, membership: Membership) => ({
  id: c.id,
  monthId: c.monthId,
  member: { id: c.member.id, name: c.member.user.name, avatarUrl: c.member.user.avatarUrl },
  type: c.type,
  amount: c.amount.toFixed(2),
  description: c.description,
  periodFrom: c.periodFrom ? fromDbDate(c.periodFrom) : null,
  periodTo: c.periodTo ? fromDbDate(c.periodTo) : null,
  isProrated: c.isProrated,
  createdAt: c.createdAt,
  canEdit: hasManagerAccess(membership) && c.month.status === MonthStatus.OPEN,
});

async function resolveMonth(messId: string, monthId: string | undefined) {
  if (!monthId) return monthForDate(prisma, messId, await ensureCurrentMonth(prisma, messId));
  const month = await prisma.messMonth.findFirst({ where: { id: monthId, messId } });
  if (!month) throw ApiError.notFound("Month not found");
  return month;
}

async function findCharge(messId: string, chargeId: string) {
  const charge = await prisma.memberCharge.findFirst({
    where: { id: chargeId, messId },
    include: chargeInclude,
  });
  if (!charge) throw ApiError.notFound("Charge not found");
  return charge;
}

/** A month's charges: members see their own, managers everyone's. */
export async function listCharges(membership: Membership, query: { monthId?: string; memberId?: string }) {
  const month = await resolveMonth(membership.messId, query.monthId);
  const memberId = hasManagerAccess(membership) ? query.memberId : membership.id;
  const charges = await prisma.memberCharge.findMany({
    where: { monthId: month.id, ...(memberId && { memberId }) },
    include: chargeInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return {
    monthId: month.id,
    total: sumMoney(charges.map((c) => c.amount)).toFixed(2),
    items: charges.map((c) => toChargeDto(c, membership)),
  };
}

/** Managers add fines, personal charges and adjustments (BUSINESS_RULES §6); the member is told. */
export async function createCharge(membership: Membership, input: CreateChargeInput) {
  const month = await resolveMonth(membership.messId, input.monthId);
  assertMonthEditable(month);
  const member = await prisma.messMember.findFirst({
    where: { id: input.memberId, messId: membership.messId, status: { not: "PENDING" } },
    select: { id: true, userId: true },
  });
  if (!member) throw ApiError.notFound("Member not found");

  const charge = await prisma.$transaction(async (tx) => {
    const created = await tx.memberCharge.create({
      data: {
        messId: membership.messId,
        monthId: month.id,
        memberId: member.id,
        type: input.type,
        amount: new Prisma.Decimal(input.amount),
        description: input.description,
        createdById: membership.userId,
      },
      include: chargeInclude,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "CHARGE_CREATED",
      entity: "MemberCharge",
      entityId: created.id,
      after: { memberId: member.id, type: input.type, amount: created.amount.toFixed(2) },
    });
    if (member.userId !== membership.userId) {
      const credit = created.amount.isNegative();
      await notify(tx, {
        userIds: [member.userId],
        messId: membership.messId,
        type: NotificationType.CHARGE_ADDED,
        title: credit
          ? `৳${created.amount.abs().toFixed(2)} taken off your bill`
          : `${TYPE_LABELS[input.type]}: ৳${created.amount.toFixed(2)}`,
        body: input.description,
        entity: "MemberCharge",
        entityId: created.id,
      });
    }
    return created;
  });
  return toChargeDto(charge, membership);
}

export async function updateCharge(membership: Membership, chargeId: string, input: UpdateChargeInput) {
  const before = await findCharge(membership.messId, chargeId);
  assertMonthEditable(before.month);
  if (input.amount?.startsWith("-") && before.type !== ChargeType.ADJUSTMENT) {
    throw ApiError.unprocessable("Only an adjustment can be negative", ERROR_CODES.BAD_REQUEST);
  }
  const charge = await prisma.$transaction(async (tx) => {
    const row = await tx.memberCharge.update({
      where: { id: before.id },
      data: {
        ...(input.amount && { amount: new Prisma.Decimal(input.amount) }),
        ...(input.description && { description: input.description }),
      },
      include: chargeInclude,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "CHARGE_UPDATED",
      entity: "MemberCharge",
      entityId: row.id,
      before: { amount: before.amount.toFixed(2) },
      after: { amount: row.amount.toFixed(2) },
    });
    return row;
  });
  return toChargeDto(charge, membership);
}

export async function deleteCharge(membership: Membership, chargeId: string) {
  const charge = await findCharge(membership.messId, chargeId);
  assertMonthEditable(charge.month);
  await prisma.$transaction(async (tx) => {
    await tx.memberCharge.delete({ where: { id: charge.id } });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "CHARGE_DELETED",
      entity: "MemberCharge",
      entityId: charge.id,
      before: { memberId: charge.memberId, type: charge.type, amount: charge.amount.toFixed(2) },
    });
  });
}
