import { MemberStatus, MonthStatus, NotificationType, Prisma, type MessMonth } from "@prisma/client";
import { ERROR_CODES } from "../../constants/error-codes.js";
import { audit } from "../../lib/audit.js";
import { notify } from "../../lib/notify.js";
import { prisma } from "../../lib/prisma.js";
import { hasManagerAccess, type Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { addDays, fromDbDate, toDbDate, todayIn, type DateString } from "../../utils/date.js";
import { sumMoney } from "../../utils/money.js";
import { assertMonthEditable, monthForDate, PLANNING_DAYS } from "../months/months.service.js";
import { toSlotDto } from "./meal-slots.service.js";
import { datesBetween, generateMealEntries } from "./meals.generation.js";
import { cutoffAt, isPastCutoff, wasMemberOn, weightedMeals } from "./meals.rules.js";
import type { UpsertEntriesInput } from "./meals.schema.js";

const memberSelect = {
  id: true,
  joinedAt: true,
  leftAt: true,
  user: { select: { id: true, name: true, avatarUrl: true } },
} satisfies Prisma.MessMemberSelect;

const entrySelect = {
  memberId: true,
  slotId: true,
  date: true,
  quantity: true,
  guestQuantity: true,
  note: true,
  updatedAt: true,
} satisfies Prisma.MealEntrySelect;

type EntryRow = Prisma.MealEntryGetPayload<{ select: typeof entrySelect }>;

const toEntryDto = (e: EntryRow) => ({
  quantity: e.quantity.toString(),
  guestQuantity: e.guestQuantity.toString(),
  note: e.note,
});

async function messContext(messId: string) {
  const mess = await prisma.mess.findUniqueOrThrow({
    where: { id: messId },
    select: { timezone: true, settings: { select: { allowMemberMealEdit: true, allowGuestMeal: true } } },
  });
  return {
    timezone: mess.timezone,
    today: todayIn(mess.timezone),
    allowMemberMealEdit: mess.settings?.allowMemberMealEdit ?? true,
    allowGuestMeal: mess.settings?.allowGuestMeal ?? true,
  };
}

/** Fills in usual meals up to the planning window (never for closed months). */
async function generateUpTo(messId: string, from: DateString, to: DateString, today: DateString) {
  const last = to < addDays(today, PLANNING_DAYS) ? to : addDays(today, PLANNING_DAYS);
  if (from <= last) await generateMealEntries(prisma, messId, from, last);
}

const monthDto = (m: Pick<MessMonth, "id" | "year" | "month" | "status">) => ({
  id: m.id,
  year: m.year,
  month: m.month,
  status: m.status,
});

// ---------- the day sheet ----------

/** Everyone's meals for one day: what the cook needs, and what managers edit. */
export async function getDay(membership: Membership, date: DateString) {
  const ctx = await messContext(membership.messId);
  const month = await monthForDate(prisma, membership.messId, date);
  if (month.status === MonthStatus.OPEN) await generateUpTo(membership.messId, date, date, ctx.today);

  const dbDate = toDbDate(date);
  const [entries, members] = await Promise.all([
    prisma.mealEntry.findMany({ where: { messId: membership.messId, date: dbDate }, select: entrySelect }),
    prisma.messMember.findMany({
      where: { messId: membership.messId, joinedAt: { not: null, lte: dbDate } },
      select: { ...memberSelect, status: true },
      orderBy: { user: { name: "asc" } },
    }),
  ]);

  // Slots served that day: the active ones, plus archived ones that still have meals recorded.
  const usedSlotIds = new Set(entries.map((e) => e.slotId));
  const slots = await prisma.mealSlot.findMany({
    where: { messId: membership.messId, OR: [{ isActive: true }, { id: { in: [...usedSlotIds] } }] },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  // Members who were in the mess that day (or have meals recorded on it).
  const rows = members
    .filter(
      (m) =>
        (m.status === MemberStatus.ACTIVE && wasMemberOn(m, dbDate)) ||
        entries.some((e) => e.memberId === m.id),
    )
    .map((m) => {
      const mine = entries.filter((e) => e.memberId === m.id);
      return {
        member: { id: m.id, name: m.user.name, avatarUrl: m.user.avatarUrl, isYou: m.id === membership.id },
        meals: Object.fromEntries(mine.map((e) => [e.slotId, toEntryDto(e)])),
        weightedMeals: sumMoney(
          mine.map((e) => weightedMeals(e, slots.find((s) => s.id === e.slotId)?.weight ?? 0)),
        ).toString(),
      };
    });

  const canManage = hasManagerAccess(membership);
  const editable = month.status === MonthStatus.OPEN;

  return {
    date,
    month: monthDto(month),
    editable,
    canEditOthers: editable && canManage,
    allowGuestMeal: ctx.allowGuestMeal,
    slots: slots.map((s) => {
      const locked = isPastCutoff(date, s.cutoffTime, ctx.timezone);
      return {
        ...toSlotDto(s),
        cutoffAt: cutoffAt(date, s.cutoffTime, ctx.timezone).toISOString(),
        isPastCutoff: locked,
        // Whether the caller can change their own meal for this slot right now.
        canEditOwn: editable && s.isActive && (canManage || (ctx.allowMemberMealEdit && !locked)),
      };
    }),
    rows,
    totals: Object.fromEntries(
      slots.map((s) => {
        const forSlot = entries.filter((e) => e.slotId === s.id);
        return [
          s.id,
          {
            meals: sumMoney(forSlot.map((e) => e.quantity)).toString(),
            guests: sumMoney(forSlot.map((e) => e.guestQuantity)).toString(),
          },
        ];
      }),
    ),
    weightedTotal: sumMoney(rows.map((r) => r.weightedMeals)).toString(),
  };
}

// ---------- one member over a range ----------

/** A member's meals day by day (for the calendar), plus totals for the range. */
export async function getMemberMeals(
  membership: Membership,
  memberId: string,
  from: DateString,
  to: DateString,
) {
  if (memberId !== membership.id && !hasManagerAccess(membership)) {
    throw ApiError.forbidden("You can only see your own meal calendar", ERROR_CODES.INSUFFICIENT_ROLE);
  }
  const member = await prisma.messMember.findFirst({ where: { id: memberId, messId: membership.messId } });
  if (!member) throw ApiError.notFound("Member not found");

  const ctx = await messContext(membership.messId);
  await generateUpTo(membership.messId, from, to, ctx.today);

  const [entries, slots] = await Promise.all([
    prisma.mealEntry.findMany({
      where: { memberId, date: { gte: toDbDate(from), lte: toDbDate(to) } },
      select: entrySelect,
    }),
    prisma.mealSlot.findMany({ where: { messId: membership.messId } }),
  ]);
  const weightOf = (slotId: string) => slots.find((s) => s.id === slotId)?.weight ?? new Prisma.Decimal(0);

  const days = datesBetween(from, to).map((date) => {
    const forDay = entries.filter((e) => fromDbDate(e.date) === date);
    return {
      date,
      meals: Object.fromEntries(forDay.map((e) => [e.slotId, toEntryDto(e)])),
      weightedMeals: sumMoney(forDay.map((e) => weightedMeals(e, weightOf(e.slotId)))).toString(),
    };
  });

  return {
    memberId,
    from,
    to,
    days,
    totals: {
      weightedMeals: sumMoney(days.map((d) => d.weightedMeals)).toString(),
      meals: sumMoney(entries.map((e) => e.quantity)).toString(),
      guestMeals: sumMoney(entries.map((e) => e.guestQuantity)).toString(),
    },
  };
}

// ---------- editing ----------

/**
 * Sets meals (BUSINESS_RULES §4). Members change their own meals until each slot's cutoff, if the
 * mess allows it; managers change anyone's meals in open months. Each change is all-or-nothing.
 * Members whose meals a manager changed get one notification each.
 */
export async function upsertEntries(membership: Membership, input: UpsertEntriesInput) {
  const ctx = await messContext(membership.messId);
  const canManage = hasManagerAccess(membership);

  const memberIds = [...new Set(input.entries.map((e) => e.memberId))];
  const slotIds = [...new Set(input.entries.map((e) => e.slotId))];
  const [members, slots] = await Promise.all([
    prisma.messMember.findMany({
      where: { id: { in: memberIds }, messId: membership.messId },
      select: { id: true, userId: true, status: true, joinedAt: true, leftAt: true },
    }),
    prisma.mealSlot.findMany({ where: { id: { in: slotIds }, messId: membership.messId } }),
  ]);

  // Validate everything before writing anything.
  const months = new Map<DateString, MessMonth>();
  for (const entry of input.entries) {
    const member = members.find((m) => m.id === entry.memberId);
    const slot = slots.find((s) => s.id === entry.slotId);
    if (!member) throw ApiError.notFound("Member not found");
    if (!slot || !slot.isActive) throw ApiError.notFound("Meal not found");

    if (!months.has(entry.date))
      months.set(entry.date, await monthForDate(prisma, membership.messId, entry.date));
    assertMonthEditable(months.get(entry.date)!);

    if (!wasMemberOn(member, toDbDate(entry.date))) {
      throw ApiError.unprocessable(
        "That member wasn't in the mess on that day",
        ERROR_CODES.MEMBER_NOT_ACTIVE_ON_DATE,
      );
    }
    if (entry.guestQuantity > 0 && !ctx.allowGuestMeal) {
      throw ApiError.unprocessable("This mess doesn't allow guest meals", ERROR_CODES.GUEST_MEALS_DISABLED);
    }
    if (!canManage) {
      if (entry.memberId !== membership.id) {
        throw ApiError.forbidden("You can only change your own meals", ERROR_CODES.INSUFFICIENT_ROLE);
      }
      if (!ctx.allowMemberMealEdit) {
        throw ApiError.forbidden(
          "Only managers can change meals in this mess",
          ERROR_CODES.MEAL_EDITING_DISABLED,
        );
      }
      if (isPastCutoff(entry.date, slot.cutoffTime, ctx.timezone)) {
        throw ApiError.unprocessable(
          `It's past the cutoff for ${slot.name.toLowerCase()} on that day. Ask a manager to change it.`,
          ERROR_CODES.MEAL_CUTOFF_PASSED,
        );
      }
    }
  }

  const saved = await prisma.$transaction(async (tx) => {
    const rows = [];
    for (const entry of input.entries) {
      const data = {
        quantity: new Prisma.Decimal(entry.quantity),
        guestQuantity: new Prisma.Decimal(entry.guestQuantity),
        ...(entry.note !== undefined && { note: entry.note }),
        updatedById: membership.userId,
      };
      rows.push(
        await tx.mealEntry.upsert({
          where: {
            memberId_slotId_date: {
              memberId: entry.memberId,
              slotId: entry.slotId,
              date: toDbDate(entry.date),
            },
          },
          create: {
            ...data,
            messId: membership.messId,
            monthId: months.get(entry.date)!.id,
            memberId: entry.memberId,
            slotId: entry.slotId,
            date: toDbDate(entry.date),
          },
          update: data,
          select: entrySelect,
        }),
      );
    }

    // Changes a manager made to other people's meals are audited and announced to them.
    const othersChanged = members.filter((m) => m.id !== membership.id);
    if (othersChanged.length > 0) {
      await audit(tx, {
        messId: membership.messId,
        actorId: membership.userId,
        action: "MEALS_UPDATED",
        entity: "MealEntry",
        entityId: input.entries[0].date,
        after: input.entries.map((e) => ({ ...e })) as Prisma.InputJsonValue,
      });
      const actor = await tx.user.findUniqueOrThrow({
        where: { id: membership.userId },
        select: { name: true },
      });
      const dates = [...new Set(input.entries.map((e) => e.date))].sort();
      await notify(tx, {
        userIds: othersChanged.map((m) => m.userId),
        messId: membership.messId,
        type: NotificationType.MEAL_UPDATED_BY_MANAGER,
        title: "Your meals were updated",
        body: `${actor.name} changed your meals for ${dates.length === 1 ? dates[0] : `${dates[0]} – ${dates.at(-1)}`}`,
        entity: "MealEntry",
        entityId: dates[0],
      });
    }
    return rows;
  });

  return saved.map((e) => ({
    memberId: e.memberId,
    slotId: e.slotId,
    date: fromDbDate(e.date),
    ...toEntryDto(e),
  }));
}
