import { HandoverStatus, MonthStatus, NotificationType, Prisma } from "@prisma/client";
import { audit } from "../../lib/audit.js";
import { notify } from "../../lib/notify.js";
import { prisma } from "../../lib/prisma.js";
import type { Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { monthLabel } from "../months/months.service.js";
import type { CreateHandoverInput, RespondHandoverInput } from "./settlement.schema.js";

const person = {
  select: { id: true, userId: true, user: { select: { name: true, avatarUrl: true } } },
} as const;
const handoverInclude = { fromMember: person, toMember: person } satisfies Prisma.FundHandoverInclude;
type HandoverRow = Prisma.FundHandoverGetPayload<{ include: typeof handoverInclude }>;

const toPerson = (m: HandoverRow["fromMember"]) => ({
  id: m.id,
  name: m.user.name,
  avatarUrl: m.user.avatarUrl,
});

const toHandoverDto = (h: HandoverRow, membership: Membership) => ({
  id: h.id,
  monthId: h.monthId,
  from: toPerson(h.fromMember),
  to: toPerson(h.toMember),
  expectedAmount: h.expectedAmount.toFixed(2),
  handedAmount: h.handedAmount.toFixed(2),
  /** handed − expected: negative means cash is missing. */
  difference: h.handedAmount.minus(h.expectedAmount).toFixed(2),
  status: h.status,
  note: h.note,
  confirmedAt: h.confirmedAt,
  createdAt: h.createdAt,
  canRespond: h.status === HandoverStatus.PENDING && h.toMemberId === membership.id,
});

export async function listHandovers(membership: Membership, monthId: string) {
  const handovers = await prisma.fundHandover.findMany({
    where: { messId: membership.messId, monthId },
    include: handoverInclude,
    orderBy: { createdAt: "desc" },
  });
  return handovers.map((h) => toHandoverDto(h, membership));
}

/**
 * The outgoing manager hands the mess's cash to the next one (BUSINESS_RULES §9): the app knows how
 * much there should be (the closed month's `closingCash`), and the record shows what was handed.
 */
export async function createHandover(membership: Membership, monthId: string, input: CreateHandoverInput) {
  const month = await prisma.messMonth.findFirst({ where: { id: monthId, messId: membership.messId } });
  if (!month) throw ApiError.notFound("Month not found");
  if (month.status !== MonthStatus.CLOSED)
    throw ApiError.conflict("Hand over the cash once the month is closed");
  if (input.toMemberId === membership.id) throw ApiError.badRequest("Pick the member who's taking over");
  const to = await prisma.messMember.findFirst({
    where: { id: input.toMemberId, messId: membership.messId, status: "ACTIVE" },
  });
  if (!to) throw ApiError.notFound("Member not found");
  const open = await prisma.fundHandover.count({
    where: { monthId, status: { in: [HandoverStatus.PENDING, HandoverStatus.CONFIRMED] } },
  });
  if (open > 0) throw ApiError.conflict(`${monthLabel(month)}'s cash has already been handed over`);

  const handover = await prisma.$transaction(async (tx) => {
    const created = await tx.fundHandover.create({
      data: {
        messId: membership.messId,
        monthId,
        fromMemberId: membership.id,
        toMemberId: to.id,
        expectedAmount: month.closingCash ?? new Prisma.Decimal(0),
        handedAmount: new Prisma.Decimal(input.handedAmount),
        note: input.note ?? null,
      },
      include: handoverInclude,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "FUND_HANDED_OVER",
      entity: "FundHandover",
      entityId: created.id,
      after: {
        to: to.id,
        expected: created.expectedAmount.toFixed(2),
        handed: created.handedAmount.toFixed(2),
      },
    });
    await notify(tx, {
      userIds: [to.userId],
      messId: membership.messId,
      type: NotificationType.FUND_HANDOVER,
      title: `${created.fromMember.user.name} handed you ৳${created.handedAmount.toFixed(2)}`,
      body: `The mess's cash from ${monthLabel(month)} (expected ৳${created.expectedAmount.toFixed(2)}). Confirm it or say what's wrong.`,
      entity: "FundHandover",
      entityId: created.id,
    });
    return created;
  });
  return toHandoverDto(handover, membership);
}

/** The receiving member confirms the amount, or disputes it (with a note). */
export async function respondToHandover(
  membership: Membership,
  handoverId: string,
  input: RespondHandoverInput,
) {
  const handover = await prisma.fundHandover.findFirst({
    where: { id: handoverId, messId: membership.messId },
    include: handoverInclude,
  });
  if (!handover) throw ApiError.notFound("Handover not found");
  if (handover.toMemberId !== membership.id)
    throw ApiError.forbidden("Only the person receiving the cash can answer");
  if (handover.status !== HandoverStatus.PENDING)
    throw ApiError.conflict("This handover was already answered");
  if (input.status === HandoverStatus.DISPUTED && !input.note) throw ApiError.badRequest("Say what's wrong");

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.fundHandover.update({
      where: { id: handover.id },
      data: {
        status: input.status,
        ...(input.note && { note: input.note }),
        ...(input.status === HandoverStatus.CONFIRMED && { confirmedAt: new Date() }),
      },
      include: handoverInclude,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action:
        input.status === HandoverStatus.CONFIRMED ? "FUND_HANDOVER_CONFIRMED" : "FUND_HANDOVER_DISPUTED",
      entity: "FundHandover",
      entityId: handover.id,
      after: { note: input.note ?? null },
    });
    await notify(tx, {
      userIds: [handover.fromMember.userId],
      messId: membership.messId,
      type: NotificationType.FUND_HANDOVER,
      title:
        input.status === HandoverStatus.CONFIRMED
          ? `${handover.toMember.user.name} confirmed the cash`
          : `${handover.toMember.user.name} disputed the cash`,
      body: input.note ?? `৳${handover.handedAmount.toFixed(2)} received.`,
      entity: "FundHandover",
      entityId: handover.id,
    });
    return row;
  });
  return toHandoverDto(updated, membership);
}
