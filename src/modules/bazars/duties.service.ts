import { MemberStatus, NotificationType, Prisma, type MessMonth } from "@prisma/client";
import { ERROR_CODES } from "../../constants/error-codes.js";
import { audit } from "../../lib/audit.js";
import { notify } from "../../lib/notify.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import { hasManagerAccess, type Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { addDays, fromDbDate, todayIn, toDbDate, type DateString } from "../../utils/date.js";
import { wasMemberOn } from "../meals/meals.rules.js";
import {
  assertMonthEditable,
  ensureCurrentMonth,
  monthForDate,
  monthLabel,
} from "../months/months.service.js";
import type { GenerateDutiesInput, UpdateDutyInput } from "./duties.schema.js";

const dutyInclude = {
  member: { select: { id: true, userId: true, user: { select: { name: true, avatarUrl: true } } } },
  month: { select: { id: true, status: true, year: true, month: true } },
} satisfies Prisma.BazarScheduleInclude;

type DutyRow = Prisma.BazarScheduleGetPayload<{ include: typeof dutyInclude }>;

const toDutyDto = (d: DutyRow) => ({
  id: d.id,
  date: fromDbDate(d.date),
  isDone: d.isDone,
  member: { id: d.member.id, name: d.member.user.name, avatarUrl: d.member.user.avatarUrl },
});

const sortDuties = (a: DutyRow, b: DutyRow) =>
  a.date.getTime() - b.date.getTime() || a.member.user.name.localeCompare(b.member.user.name);

async function resolveMonth(messId: string, monthId: string | undefined) {
  if (!monthId) return monthForDate(prisma, messId, await ensureCurrentMonth(prisma, messId));
  const month = await prisma.messMonth.findFirst({ where: { id: monthId, messId } });
  if (!month) throw ApiError.notFound("Month not found");
  return month;
}

async function findDuty(db: DbClient, messId: string, dutyId: string) {
  const duty = await db.bazarSchedule.findFirst({ where: { id: dutyId, messId }, include: dutyInclude });
  if (!duty) throw ApiError.notFound("Bazar duty not found");
  return duty;
}

/** An active member who belongs to the mess on that day. */
async function assignableMember(db: DbClient, messId: string, memberId: string, date: DateString) {
  const member = await db.messMember.findFirst({
    where: { id: memberId, messId, status: MemberStatus.ACTIVE },
    select: { id: true, userId: true, joinedAt: true, leftAt: true },
  });
  if (!member) throw ApiError.notFound("Member not found");
  if (!wasMemberOn(member, toDbDate(date))) {
    throw ApiError.unprocessable(
      "That member isn't in the mess on that day",
      ERROR_CODES.MEMBER_NOT_ACTIVE_ON_DATE,
    );
  }
  return member;
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

const duplicate = () => ApiError.conflict("That member already has bazar duty on that day");

// ---------- reads ----------

export async function listDuties(membership: Membership, monthId: string | undefined) {
  const month = await resolveMonth(membership.messId, monthId);
  const duties = await prisma.bazarSchedule.findMany({ where: { monthId: month.id }, include: dutyInclude });
  return { monthId: month.id, duties: duties.sort(sortDuties).map(toDutyDto) };
}

// ---------- rotation ----------

/** Bazar days from `from` to the month's end, every `everyDays` days. */
function rotationDays(month: Pick<MessMonth, "endDate">, from: DateString, everyDays: number) {
  const days: DateString[] = [];
  for (let day = from; day <= fromDbDate(month.endDate); day = addDays(day, everyDays)) days.push(day);
  return days;
}

/**
 * Plans the month's bazar duty: a bazar day every `everyDays` days from `fromDate`, with `perDay`
 * members each, taking turns in the given order. Duties from `fromDate` on that aren't done yet are
 * replaced; done ones and earlier days stay. Everyone who got duty is told their days.
 */
export async function generateDuties(membership: Membership, input: GenerateDutiesInput) {
  const month = await resolveMonth(membership.messId, input.monthId);
  assertMonthEditable(month);
  const mess = await prisma.mess.findUniqueOrThrow({
    where: { id: membership.messId },
    select: { timezone: true },
  });
  const today = todayIn(mess.timezone);
  const monthStart = fromDbDate(month.startDate);
  const from = input.fromDate ?? (today > monthStart ? today : monthStart);
  if (from < monthStart || from > fromDbDate(month.endDate)) {
    throw ApiError.unprocessable("Start the plan on a day of this month", ERROR_CODES.DATE_OUTSIDE_MONTHS);
  }

  const memberIds = [...new Set(input.memberIds)];
  const members = await prisma.messMember.findMany({
    where: { id: { in: memberIds }, messId: membership.messId, status: MemberStatus.ACTIVE },
    select: { id: true, userId: true, joinedAt: true, leftAt: true },
  });
  if (members.length !== memberIds.length) throw ApiError.notFound("Member not found");
  const rotation = memberIds.map((id) => members.find((m) => m.id === id)!);

  // Hand out turns in order, skipping anyone who isn't in the mess that day.
  const plan: { date: DateString; memberId: string }[] = [];
  let turn = 0;
  for (const date of rotationDays(month, from, input.everyDays)) {
    const available = rotation.filter((m) => wasMemberOn(m, toDbDate(date)));
    const picked: string[] = [];
    while (picked.length < Math.min(input.perDay, available.length)) {
      const member = rotation[turn++ % rotation.length];
      if (wasMemberOn(member, toDbDate(date)) && !picked.includes(member.id)) picked.push(member.id);
    }
    plan.push(...picked.map((memberId) => ({ date, memberId })));
  }

  const duties = await prisma.$transaction(async (tx) => {
    await tx.bazarSchedule.deleteMany({
      where: { monthId: month.id, isDone: false, date: { gte: toDbDate(from) } },
    });
    // Done duties from `from` on are kept, so skip planned ones that would clash with them.
    await tx.bazarSchedule.createMany({
      data: plan.map((p) => ({
        messId: membership.messId,
        monthId: month.id,
        memberId: p.memberId,
        date: toDbDate(p.date),
      })),
      skipDuplicates: true,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "BAZAR_DUTIES_GENERATED",
      entity: "MessMonth",
      entityId: month.id,
      after: { from, everyDays: input.everyDays, perDay: input.perDay, memberIds, duties: plan.length },
    });
    for (const member of rotation) {
      const days = plan.filter((p) => p.memberId === member.id).map((p) => p.date);
      if (days.length === 0 || member.id === membership.id) continue;
      await notify(tx, {
        userIds: [member.userId],
        messId: membership.messId,
        type: NotificationType.BAZAR_DUTY_REMINDER,
        title: `Your bazar days for ${monthLabel(month)}`,
        body: days.join(", "),
        entity: "MessMonth",
        entityId: month.id,
      });
    }
    return tx.bazarSchedule.findMany({ where: { monthId: month.id }, include: dutyInclude });
  });
  return { monthId: month.id, duties: duties.sort(sortDuties).map(toDutyDto) };
}

// ---------- single duties ----------

export async function createDuty(membership: Membership, input: { date: DateString; memberId: string }) {
  const month = await monthForDate(prisma, membership.messId, input.date);
  assertMonthEditable(month);
  await assignableMember(prisma, membership.messId, input.memberId, input.date);
  try {
    const duty = await prisma.bazarSchedule.create({
      data: {
        messId: membership.messId,
        monthId: month.id,
        memberId: input.memberId,
        date: toDbDate(input.date),
      },
      include: dutyInclude,
    });
    return toDutyDto(duty);
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicate();
    throw err;
  }
}

/**
 * Managers move or reassign a duty; the assigned member (or a manager) marks it done. A member can
 * only tick their own duty.
 */
export async function updateDuty(membership: Membership, dutyId: string, input: UpdateDutyInput) {
  const duty = await findDuty(prisma, membership.messId, dutyId);
  assertMonthEditable(duty.month);
  const canManage = hasManagerAccess(membership);
  const reassigning = input.memberId !== undefined || input.date !== undefined;
  if (reassigning ? !canManage : !canManage && duty.memberId !== membership.id) {
    throw ApiError.forbidden(
      reassigning ? "Only a manager can change bazar duty" : "You can only tick off your own bazar duty",
      ERROR_CODES.INSUFFICIENT_ROLE,
    );
  }

  const date = input.date ?? fromDbDate(duty.date);
  const memberId = input.memberId ?? duty.memberId;
  const month = input.date ? await monthForDate(prisma, membership.messId, input.date) : duty.month;
  assertMonthEditable(month);
  const member = reassigning ? await assignableMember(prisma, membership.messId, memberId, date) : null;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.bazarSchedule.update({
        where: { id: duty.id },
        data: {
          ...(input.date && { date: toDbDate(input.date), monthId: month.id }),
          ...(input.memberId && { memberId: input.memberId }),
          ...(input.isDone !== undefined && { isDone: input.isDone }),
        },
        include: dutyInclude,
      });
      if (
        member &&
        member.id !== membership.id &&
        (member.id !== duty.memberId || date !== fromDbDate(duty.date))
      ) {
        await notify(tx, {
          userIds: [member.userId],
          messId: membership.messId,
          type: NotificationType.BAZAR_DUTY_REMINDER,
          title: "You have bazar duty",
          body: `On ${date}`,
          entity: "BazarSchedule",
          entityId: row.id,
        });
      }
      return row;
    });
    return toDutyDto(updated);
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicate();
    throw err;
  }
}

/** Two members trade their bazar days. */
export async function swapDuties(membership: Membership, dutyId: string, otherDutyId: string) {
  const [a, b] = await Promise.all([
    findDuty(prisma, membership.messId, dutyId),
    findDuty(prisma, membership.messId, otherDutyId),
  ]);
  assertMonthEditable(a.month);
  assertMonthEditable(b.month);
  if (a.isDone || b.isDone)
    throw ApiError.unprocessable("Done duties can't be swapped", ERROR_CODES.NOT_EDITABLE);
  if (a.memberId === b.memberId || a.date.getTime() === b.date.getTime()) {
    throw ApiError.unprocessable("Pick duties of two members on different days", ERROR_CODES.BAD_REQUEST);
  }
  await assignableMember(prisma, membership.messId, b.memberId, fromDbDate(a.date));
  await assignableMember(prisma, membership.messId, a.memberId, fromDbDate(b.date));

  try {
    const [newA, newB] = await prisma.$transaction(async (tx) => {
      const updatedA = await tx.bazarSchedule.update({
        where: { id: a.id },
        data: { memberId: b.memberId },
        include: dutyInclude,
      });
      const updatedB = await tx.bazarSchedule.update({
        where: { id: b.id },
        data: { memberId: a.memberId },
        include: dutyInclude,
      });
      await notify(tx, {
        userIds: [a.member.userId, b.member.userId].filter((id) => id !== membership.userId),
        messId: membership.messId,
        type: NotificationType.BAZAR_DUTY_REMINDER,
        title: "Bazar duty swapped",
        body: `${a.member.user.name} ↔ ${b.member.user.name}: ${fromDbDate(a.date)} and ${fromDbDate(b.date)}`,
        entity: "BazarSchedule",
        entityId: a.id,
      });
      return [updatedA, updatedB];
    });
    return [toDutyDto(newA), toDutyDto(newB)];
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicate();
    throw err;
  }
}

export async function deleteDuty(membership: Membership, dutyId: string) {
  const duty = await findDuty(prisma, membership.messId, dutyId);
  assertMonthEditable(duty.month);
  await prisma.bazarSchedule.delete({ where: { id: duty.id } });
}
