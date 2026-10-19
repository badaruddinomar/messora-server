import { MemberStatus, MonthStatus, type Prisma } from "@prisma/client";
import type { DbClient } from "../../lib/prisma.js";
import { addDays, toDbDate, type DateString } from "../../utils/date.js";
import { wasMemberOn } from "./meals.rules.js";

/**
 * Creates each active member's usual meals for every day in `from..to` (BUSINESS_RULES §4):
 * 1 per slot if they usually eat, 0 if they don't or are inside a meal-off period.
 *
 * Idempotent: existing entries are never touched (unique member+slot+date, `skipDuplicates`), so it
 * can run from the daily job, when a day is opened, and before a month is closed, in any order.
 * Days outside OPEN months are skipped, so closed months never change.
 */
export async function generateMealEntries(db: DbClient, messId: string, from: DateString, to: DateString) {
  const settings = await db.messSetting.findUnique({
    where: { messId },
    select: { autoGenerateMeals: true },
  });
  if (settings && !settings.autoGenerateMeals) return 0;

  const fromDb = toDbDate(from);
  const toDb = toDbDate(to);

  const [months, slots, members, offPeriods] = await Promise.all([
    db.messMonth.findMany({
      where: { messId, status: MonthStatus.OPEN, startDate: { lte: toDb }, endDate: { gte: fromDb } },
      select: { id: true, startDate: true, endDate: true },
    }),
    db.mealSlot.findMany({ where: { messId, isActive: true }, select: { id: true } }),
    db.messMember.findMany({
      where: {
        messId,
        status: MemberStatus.ACTIVE,
        joinedAt: { not: null, lte: toDb },
        OR: [{ leftAt: null }, { leftAt: { gte: fromDb } }],
      },
      select: { id: true, joinedAt: true, leftAt: true, defaultMealOn: true },
    }),
    db.mealOffPeriod.findMany({
      where: { messId, fromDate: { lte: toDb }, toDate: { gte: fromDb } },
      select: { memberId: true, fromDate: true, toDate: true },
    }),
  ]);
  if (months.length === 0 || slots.length === 0 || members.length === 0) return 0;

  const rows: Prisma.MealEntryCreateManyInput[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const date = toDbDate(day);
    const month = months.find((m) => m.startDate <= date && date <= m.endDate);
    if (!month) continue;

    for (const member of members) {
      if (!wasMemberOn(member, date)) continue;
      const isOff = offPeriods.some(
        (p) => p.memberId === member.id && p.fromDate <= date && date <= p.toDate,
      );
      const quantity = member.defaultMealOn && !isOff ? 1 : 0;
      for (const slot of slots) {
        rows.push({ messId, monthId: month.id, memberId: member.id, slotId: slot.id, date, quantity });
      }
    }
  }
  if (rows.length === 0) return 0;

  const { count } = await db.mealEntry.createMany({ data: rows, skipDuplicates: true });
  return count;
}

/** All dates from `from` to `to`, inclusive. */
export function datesBetween(from: DateString, to: DateString) {
  const dates: DateString[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) dates.push(day);
  return dates;
}
