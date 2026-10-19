import { MonthStatus, Prisma, type MealOffPeriod } from "@prisma/client";
import { ERROR_CODES } from "../../constants/error-codes.js";
import { audit } from "../../lib/audit.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import { hasManagerAccess, type Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { addDays, fromDbDate, todayIn, toDbDate, type DateString } from "../../utils/date.js";
import { assertMonthEditable, monthForDate, PLANNING_DAYS } from "../months/months.service.js";
import { isPastCutoff } from "./meals.rules.js";
import type { CreateOffPeriodInput } from "./meals.schema.js";

/** Members manage their own plans; managers can manage anyone's. Returns the target member. */
async function targetMember(membership: Membership, memberId: string | undefined) {
  const id = memberId ?? membership.id;
  if (id !== membership.id && !hasManagerAccess(membership)) {
    throw ApiError.forbidden("You can only change your own meals", ERROR_CODES.INSUFFICIENT_ROLE);
  }
  const member = await prisma.messMember.findFirst({
    where: { id, messId: membership.messId },
    select: { id: true, userId: true, defaultMealOn: true, user: { select: { name: true } } },
  });
  if (!member) throw ApiError.notFound("Member not found");
  return member;
}

const messTimezone = async (db: DbClient, messId: string) =>
  (await db.mess.findUniqueOrThrow({ where: { id: messId }, select: { timezone: true } })).timezone;

/**
 * A member's entries in `from..to` that can still change without rewriting history: in OPEN months,
 * and not past their slot's cutoff. Plan changes (meal-off, usual meals) only ever touch these.
 */
async function upcomingEntries(
  db: DbClient,
  messId: string,
  memberId: string,
  from: DateString,
  to: DateString,
  timezone: string,
) {
  const today = todayIn(timezone);
  if (to < today) return [];
  const entries = await db.mealEntry.findMany({
    where: {
      memberId,
      date: { gte: toDbDate(from < today ? today : from), lte: toDbDate(to) },
      month: { status: MonthStatus.OPEN },
    },
    select: { id: true, date: true, quantity: true, slot: { select: { cutoffTime: true } } },
  });
  return entries.filter((e) => !isPastCutoff(fromDbDate(e.date), e.slot.cutoffTime, timezone));
}

// ---------- usual meals ----------

/**
 * Turns a member's usual meals on or off. Upcoming days still at the old usual amount follow the new
 * one (days inside a meal-off period stay off); days already eaten and any custom amounts don't change.
 */
export async function setDefaultMeal(
  membership: Membership,
  input: { defaultMealOn: boolean; memberId?: string },
) {
  const member = await targetMember(membership, input.memberId);
  if (member.defaultMealOn === input.defaultMealOn)
    return { defaultMealOn: input.defaultMealOn, updatedDays: 0 };

  return prisma.$transaction(async (tx) => {
    await tx.messMember.update({ where: { id: member.id }, data: { defaultMealOn: input.defaultMealOn } });

    const timezone = await messTimezone(tx, membership.messId);
    const today = todayIn(timezone);
    const last = addDays(today, PLANNING_DAYS);
    const [entries, offPeriods] = await Promise.all([
      upcomingEntries(tx, membership.messId, member.id, today, last, timezone),
      tx.mealOffPeriod.findMany({
        where: { memberId: member.id, toDate: { gte: toDbDate(today) }, fromDate: { lte: toDbDate(last) } },
      }),
    ]);
    const oldUsual = input.defaultMealOn ? 0 : 1;
    const changed = entries.filter(
      (e) =>
        e.quantity.equals(oldUsual) && !offPeriods.some((p) => p.fromDate <= e.date && e.date <= p.toDate),
    );
    await tx.mealEntry.updateMany({
      where: { id: { in: changed.map((e) => e.id) } },
      data: { quantity: input.defaultMealOn ? 1 : 0, updatedById: membership.userId },
    });

    const updatedDays = new Set(changed.map((e) => e.date.getTime())).size;
    return { defaultMealOn: input.defaultMealOn, updatedDays };
  });
}

// ---------- meal-off periods ----------

const offPeriodInclude = {
  member: { select: { id: true, user: { select: { name: true, avatarUrl: true } } } },
};

const toOffPeriodDto = (
  p: MealOffPeriod & { member: { id: string; user: { name: string; avatarUrl: string | null } } },
) => ({
  id: p.id,
  fromDate: fromDbDate(p.fromDate),
  toDate: fromDbDate(p.toDate),
  reason: p.reason,
  createdAt: p.createdAt,
  member: { id: p.member.id, name: p.member.user.name, avatarUrl: p.member.user.avatarUrl },
});

export async function listOffPeriods(
  membership: Membership,
  query: { memberId?: string; when: "upcoming" | "past" },
) {
  const canManage = hasManagerAccess(membership);
  const memberId = canManage ? query.memberId : membership.id;
  const today = toDbDate(todayIn(await messTimezone(prisma, membership.messId)));
  const periods = await prisma.mealOffPeriod.findMany({
    where: {
      messId: membership.messId,
      ...(memberId && { memberId }),
      toDate: query.when === "upcoming" ? { gte: today } : { lt: today },
    },
    include: offPeriodInclude,
    orderBy: [{ fromDate: query.when === "upcoming" ? "asc" : "desc" }, { id: "asc" }],
    take: 100,
  });
  return periods.map(toOffPeriodDto);
}

/**
 * Turns a member's meals off for a date range (BUSINESS_RULES §4). Members plan from today on and
 * only change meals still before their cutoff; managers can cover any days of open months. Meals in
 * the range drop to 0, and days generated later start at 0.
 */
export async function createOffPeriod(membership: Membership, input: CreateOffPeriodInput) {
  const member = await targetMember(membership, input.memberId);
  const canManage = hasManagerAccess(membership);
  const timezone = await messTimezone(prisma, membership.messId);
  const today = todayIn(timezone);

  if (input.fromDate < today) {
    if (!canManage) {
      throw ApiError.unprocessable("A meal-off can't start in the past", ERROR_CODES.BAD_REQUEST);
    }
    assertMonthEditable(await monthForDate(prisma, membership.messId, input.fromDate));
  }

  const overlap = await prisma.mealOffPeriod.findFirst({
    where: {
      memberId: member.id,
      fromDate: { lte: toDbDate(input.toDate) },
      toDate: { gte: toDbDate(input.fromDate) },
    },
  });
  if (overlap) {
    throw ApiError.conflict(
      `${member.id === membership.id ? "You already have" : `${member.user.name} already has`} a meal-off from ${fromDbDate(overlap.fromDate)} to ${fromDbDate(overlap.toDate)}`,
    );
  }

  return prisma.$transaction(async (tx) => {
    const period = await tx.mealOffPeriod.create({
      data: {
        messId: membership.messId,
        memberId: member.id,
        fromDate: toDbDate(input.fromDate),
        toDate: toDbDate(input.toDate),
        reason: input.reason ?? null,
      },
      include: offPeriodInclude,
    });

    // Managers can change any day of an open month; members only what hasn't passed its cutoff.
    const where: Prisma.MealEntryWhereInput = canManage
      ? {
          memberId: member.id,
          date: { gte: toDbDate(input.fromDate), lte: toDbDate(input.toDate) },
          month: { status: MonthStatus.OPEN },
        }
      : {
          id: {
            in: (
              await upcomingEntries(tx, membership.messId, member.id, input.fromDate, input.toDate, timezone)
            ).map((e) => e.id),
          },
        };
    await tx.mealEntry.updateMany({
      where,
      data: { quantity: 0, updatedById: membership.userId },
    });

    if (member.id !== membership.id) {
      await audit(tx, {
        messId: membership.messId,
        actorId: membership.userId,
        action: "MEAL_OFF_CREATED",
        entity: "MealOffPeriod",
        entityId: period.id,
        after: { memberId: member.id, fromDate: input.fromDate, toDate: input.toDate },
      });
    }
    return toOffPeriodDto(period);
  });
}

/**
 * Cancels a meal-off. One that has already started is ended instead (the days already off stay
 * off); upcoming days go back to the member's usual meals.
 */
export async function deleteOffPeriod(membership: Membership, periodId: string) {
  const period = await prisma.mealOffPeriod.findFirst({ where: { id: periodId, messId: membership.messId } });
  if (!period) throw ApiError.notFound("Meal-off not found");
  const member = await targetMember(membership, period.memberId);

  const timezone = await messTimezone(prisma, membership.messId);
  const today = todayIn(timezone);
  const fromDate = fromDbDate(period.fromDate);
  const toDate = fromDbDate(period.toDate);
  if (toDate < today) throw ApiError.unprocessable("This meal-off is already over", ERROR_CODES.BAD_REQUEST);

  return prisma.$transaction(async (tx) => {
    const ended = fromDate < today;
    if (ended) {
      await tx.mealOffPeriod.update({
        where: { id: period.id },
        data: { toDate: toDbDate(addDays(today, -1)) },
      });
    } else {
      await tx.mealOffPeriod.delete({ where: { id: period.id } });
    }

    if (member.defaultMealOn) {
      const upcoming = await upcomingEntries(tx, membership.messId, member.id, today, toDate, timezone);
      await tx.mealEntry.updateMany({
        where: { id: { in: upcoming.filter((e) => e.quantity.equals(0)).map((e) => e.id) } },
        data: { quantity: new Prisma.Decimal(1), updatedById: membership.userId },
      });
    }
    return { ended };
  });
}
