import { MemberStatus, type MessMonth } from "@prisma/client";
import type { DbClient } from "../../lib/prisma.js";
import { Decimal, sumMoney } from "../../utils/money.js";
import { weightedMeals } from "../meals/meals.rules.js";

/**
 * Who takes part in a month and how much they ate: the basis for splitting meal costs and shared
 * expenses (BUSINESS_RULES §7). A member takes part if they were in the mess on at least one day of it.
 */
export async function loadMonthBasis(
  db: DbClient,
  month: Pick<MessMonth, "id" | "messId" | "startDate" | "endDate">,
) {
  const [members, entries] = await Promise.all([
    db.messMember.findMany({
      where: {
        messId: month.messId,
        status: { not: MemberStatus.PENDING },
        joinedAt: { not: null, lte: month.endDate },
        OR: [{ leftAt: null }, { leftAt: { gte: month.startDate } }],
      },
      select: {
        id: true,
        joinedAt: true,
        leftAt: true,
        seat: { select: { label: true, monthlyRent: true } },
        user: { select: { name: true, avatarUrl: true } },
      },
    }),
    db.mealEntry.findMany({
      where: { monthId: month.id },
      select: { memberId: true, quantity: true, guestQuantity: true, slot: { select: { weight: true } } },
    }),
  ]);

  // Sorted ids give the largest-remainder method its stable tie-break (§7: lower memberId first).
  const memberIds = [...new Set([...members.map((m) => m.id), ...entries.map((e) => e.memberId)])].sort();
  const meals = new Map(memberIds.map((id) => [id, new Decimal(0)]));
  for (const e of entries)
    meals.set(e.memberId, meals.get(e.memberId)!.plus(weightedMeals(e, e.slot.weight)));

  return { members, memberIds, meals, totalMeals: sumMoney(meals.values()) };
}

export type MonthBasis = Awaited<ReturnType<typeof loadMonthBasis>>;
