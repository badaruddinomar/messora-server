import { ApprovalStatus, NotificationType, type Prisma } from "@prisma/client";
import { ERROR_CODES } from "../../constants/error-codes.js";
import { notify } from "../../lib/notify.js";
import { prisma } from "../../lib/prisma.js";
import { hasManagerAccess, type Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { fromDbDate, todayIn, toDbDate } from "../../utils/date.js";
import { cursorArgs, toPage } from "../../utils/pagination.js";
import { managerUserIds } from "../members/members.queries.js";
import { monthForDate } from "../months/months.service.js";
import type { CreateRequestInput, ListRequestsQuery, RespondRequestInput } from "./meals.schema.js";

const person = {
  select: { id: true, userId: true, user: { select: { name: true, avatarUrl: true } } },
} as const;
const requestInclude = {
  member: person,
  respondedBy: person,
  slot: { select: { id: true, name: true } },
} satisfies Prisma.MealRequestInclude;

type RequestRow = Prisma.MealRequestGetPayload<{ include: typeof requestInclude }>;
type PersonRow = NonNullable<RequestRow["respondedBy"]>;

const toPerson = (m: PersonRow) => ({ id: m.id, name: m.user.name, avatarUrl: m.user.avatarUrl });

const toRequestDto = (r: RequestRow) => ({
  id: r.id,
  date: fromDbDate(r.date),
  slot: r.slot,
  request: r.request,
  status: r.status,
  response: r.response,
  respondedAt: r.respondedAt,
  respondedBy: r.respondedBy ? toPerson(r.respondedBy) : null,
  createdAt: r.createdAt,
  member: toPerson(r.member),
});

/** Members see their own requests; managers see everyone's. */
export async function listRequests(membership: Membership, query: ListRequestsQuery) {
  const rows = await prisma.mealRequest.findMany({
    where: {
      messId: membership.messId,
      ...(!hasManagerAccess(membership) && { memberId: membership.id }),
      ...(query.status && { status: query.status }),
      ...(query.date && { date: toDbDate(query.date) }),
    },
    include: requestInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...cursorArgs(query),
  });
  const page = toPage(rows, query.limit);
  return { ...page, items: page.items.map(toRequestDto) };
}

/** "Fish tomorrow, please": a member asks the managers for something on a day (today or later). */
export async function createRequest(membership: Membership, input: CreateRequestInput) {
  const mess = await prisma.mess.findUniqueOrThrow({
    where: { id: membership.messId },
    select: { timezone: true },
  });
  if (input.date < todayIn(mess.timezone)) {
    throw ApiError.unprocessable("Requests are for today or later", ERROR_CODES.BAD_REQUEST);
  }
  await monthForDate(prisma, membership.messId, input.date);
  if (input.slotId) {
    const slot = await prisma.mealSlot.findFirst({
      where: { id: input.slotId, messId: membership.messId, isActive: true },
    });
    if (!slot) throw ApiError.notFound("Meal not found");
  }

  return prisma.$transaction(async (tx) => {
    const created = await tx.mealRequest.create({
      data: {
        messId: membership.messId,
        memberId: membership.id,
        slotId: input.slotId ?? null,
        date: toDbDate(input.date),
        request: input.request,
      },
      include: requestInclude,
    });
    const managers = (await managerUserIds(tx, membership.messId)).filter((id) => id !== membership.userId);
    await notify(tx, {
      userIds: managers,
      messId: membership.messId,
      type: NotificationType.MEAL_REQUEST,
      title: `Meal request from ${created.member.user.name}`,
      body: `${created.slot ? `${created.slot.name}, ` : ""}${input.date}: ${input.request}`,
      entity: "MealRequest",
      entityId: created.id,
    });
    return toRequestDto(created);
  });
}

async function findRequest(messId: string, requestId: string) {
  const request = await prisma.mealRequest.findFirst({
    where: { id: requestId, messId },
    include: requestInclude,
  });
  if (!request) throw ApiError.notFound("Request not found");
  return request;
}

/** A manager approves or turns down a pending request; the member is told either way. */
export async function respondToRequest(
  membership: Membership,
  requestId: string,
  input: RespondRequestInput,
) {
  const request = await findRequest(membership.messId, requestId);
  if (request.status !== ApprovalStatus.PENDING) throw ApiError.conflict("This request was already answered");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.mealRequest.update({
      where: { id: request.id },
      data: {
        status: input.status,
        response: input.response ?? null,
        respondedById: membership.id,
        respondedAt: new Date(),
      },
      include: requestInclude,
    });
    if (request.member.id !== membership.id) {
      const verdict = input.status === ApprovalStatus.APPROVED ? "approved" : "turned down";
      await notify(tx, {
        userIds: [request.member.userId],
        messId: membership.messId,
        type: NotificationType.MEAL_REQUEST_RESPONDED,
        title: `Your meal request was ${verdict}`,
        body: input.response ? `${request.request} — ${input.response}` : request.request,
        entity: "MealRequest",
        entityId: request.id,
      });
    }
    return toRequestDto(updated);
  });
}

/** Members withdraw their own requests while they're still pending. */
export async function cancelRequest(membership: Membership, requestId: string) {
  const request = await findRequest(membership.messId, requestId);
  if (request.memberId !== membership.id) {
    throw ApiError.forbidden("You can only withdraw your own requests", ERROR_CODES.INSUFFICIENT_ROLE);
  }
  if (request.status !== ApprovalStatus.PENDING) throw ApiError.conflict("This request was already answered");
  await prisma.mealRequest.delete({ where: { id: request.id } });
}
