import { MemberStatus, NotificationType, type Prisma } from "@prisma/client";
import { notify } from "../../lib/notify.js";
import { prisma } from "../../lib/prisma.js";
import type { Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { addDays, fromDbDate, todayIn, toDbDate, type DateString } from "../../utils/date.js";
import { assertMonthEditable, monthForDate } from "../months/months.service.js";
import type { UpsertMenuInput } from "./meals.schema.js";

const menuInclude = {
  slot: { select: { id: true, name: true, sortOrder: true } },
} satisfies Prisma.DailyMenuInclude;
type MenuRow = Prisma.DailyMenuGetPayload<{ include: typeof menuInclude }>;

const toMenuDto = (m: MenuRow) => ({
  id: m.id,
  date: fromDbDate(m.date),
  slot: { id: m.slot.id, name: m.slot.name },
  items: m.items,
  note: m.note,
  updatedAt: m.updatedAt,
});

export async function listMenu(messId: string, from: DateString, to: DateString) {
  const menus = await prisma.dailyMenu.findMany({
    where: { messId, date: { gte: toDbDate(from), lte: toDbDate(to) } },
    include: menuInclude,
  });
  return menus
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.slot.sortOrder - b.slot.sortOrder)
    .map(toMenuDto);
}

/**
 * Posts (or edits) what's cooking for a meal. A new menu for today or later is announced to
 * everyone; edits aren't, so fixing a typo doesn't ping the whole mess.
 */
export async function upsertMenu(membership: Membership, input: UpsertMenuInput) {
  assertMonthEditable(await monthForDate(prisma, membership.messId, input.date));
  const slot = await prisma.mealSlot.findFirst({
    where: { id: input.slotId, messId: membership.messId, isActive: true },
  });
  if (!slot) throw ApiError.notFound("Meal not found");

  const where = {
    messId_date_slotId: { messId: membership.messId, date: toDbDate(input.date), slotId: slot.id },
  };
  return prisma.$transaction(async (tx) => {
    const existing = await tx.dailyMenu.findUnique({ where, select: { id: true } });
    const menu = await tx.dailyMenu.upsert({
      where,
      create: {
        messId: membership.messId,
        slotId: slot.id,
        date: toDbDate(input.date),
        items: input.items,
        note: input.note ?? null,
        createdById: membership.userId,
      },
      update: { items: input.items, note: input.note ?? null },
      include: menuInclude,
    });

    const mess = await tx.mess.findUniqueOrThrow({
      where: { id: membership.messId },
      select: { timezone: true },
    });
    if (!existing && input.date >= todayIn(mess.timezone)) {
      const members = await tx.messMember.findMany({
        where: { messId: membership.messId, status: MemberStatus.ACTIVE, userId: { not: membership.userId } },
        select: { userId: true },
      });
      const today = todayIn(mess.timezone);
      const day = input.date === today ? "today" : input.date === addDays(today, 1) ? "tomorrow" : input.date;
      await notify(tx, {
        userIds: members.map((m) => m.userId),
        messId: membership.messId,
        type: NotificationType.MENU_POSTED,
        title: `${slot.name} menu for ${day}`,
        body: input.items,
        entity: "DailyMenu",
        entityId: menu.id,
      });
    }
    return toMenuDto(menu);
  });
}

export async function deleteMenu(membership: Membership, menuId: string) {
  const menu = await prisma.dailyMenu.findFirst({ where: { id: menuId, messId: membership.messId } });
  if (!menu) throw ApiError.notFound("Menu not found");
  assertMonthEditable(await monthForDate(prisma, membership.messId, fromDbDate(menu.date)));
  await prisma.dailyMenu.delete({ where: { id: menu.id } });
}
