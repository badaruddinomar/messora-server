import { MonthStatus, Prisma, type MealSlot } from "@prisma/client";
import { ERROR_CODES } from "../../constants/error-codes.js";
import { audit } from "../../lib/audit.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import type { Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { todayIn, toDbDate } from "../../utils/date.js";

export const toSlotDto = (slot: MealSlot) => ({
  id: slot.id,
  name: slot.name,
  weight: slot.weight.toString(),
  cutoffTime: slot.cutoffTime,
  sortOrder: slot.sortOrder,
  isActive: slot.isActive,
});

export type SlotDto = ReturnType<typeof toSlotDto>;

export async function listSlots(messId: string) {
  const slots = await prisma.mealSlot.findMany({
    where: { messId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return slots.map(toSlotDto);
}

async function findSlot(db: DbClient, messId: string, slotId: string) {
  const slot = await db.mealSlot.findFirst({ where: { id: slotId, messId } });
  if (!slot) throw ApiError.notFound("Meal not found");
  return slot;
}

/** Meals not served any more: drop their not-yet-eaten entries so they stop counting. */
async function removeUpcomingEntries(db: DbClient, messId: string, slotId: string) {
  const mess = await db.mess.findUniqueOrThrow({ where: { id: messId }, select: { timezone: true } });
  await db.mealEntry.deleteMany({
    where: {
      slotId,
      date: { gt: toDbDate(todayIn(mess.timezone)) },
      month: { status: MonthStatus.OPEN },
    },
  });
}

export async function createSlot(
  membership: Membership,
  input: { name: string; weight: number; cutoffTime?: string | null },
) {
  const last = await prisma.mealSlot.findFirst({
    where: { messId: membership.messId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  try {
    const slot = await prisma.mealSlot.create({
      data: {
        messId: membership.messId,
        name: input.name,
        weight: new Prisma.Decimal(input.weight),
        cutoffTime: input.cutoffTime ?? null,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
    });
    await audit(prisma, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "MEAL_SLOT_CREATED",
      entity: "MealSlot",
      entityId: slot.id,
      after: toSlotDto(slot),
    });
    return toSlotDto(slot);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ApiError.conflict(`There's already a meal called “${input.name}”`);
    }
    throw err;
  }
}

export async function updateSlot(
  membership: Membership,
  slotId: string,
  input: Partial<{
    name: string;
    weight: number;
    cutoffTime: string | null;
    sortOrder: number;
    isActive: boolean;
  }>,
) {
  return prisma.$transaction(async (tx) => {
    const slot = await findSlot(tx, membership.messId, slotId);
    if (input.isActive === false && slot.isActive) await assertNotLastActive(tx, membership.messId);

    const updated = await tx.mealSlot.update({
      where: { id: slot.id },
      data: {
        ...input,
        ...(input.weight !== undefined && { weight: new Prisma.Decimal(input.weight) }),
      },
    });
    if (input.isActive === false && slot.isActive)
      await removeUpcomingEntries(tx, membership.messId, slot.id);

    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "MEAL_SLOT_UPDATED",
      entity: "MealSlot",
      entityId: slot.id,
      before: toSlotDto(slot),
      after: toSlotDto(updated),
    });
    return toSlotDto(updated);
  });
}

/**
 * Removes a meal. One that already has meals recorded is archived instead (so past months keep their
 * numbers), and its upcoming entries are dropped.
 */
export async function deleteSlot(membership: Membership, slotId: string) {
  return prisma.$transaction(async (tx) => {
    const slot = await findSlot(tx, membership.messId, slotId);
    if (slot.isActive) await assertNotLastActive(tx, membership.messId);

    await removeUpcomingEntries(tx, membership.messId, slot.id);
    const used = await tx.mealEntry.count({ where: { slotId: slot.id } });
    if (used > 0) {
      await tx.mealSlot.update({ where: { id: slot.id }, data: { isActive: false } });
    } else {
      await tx.mealSlot.delete({ where: { id: slot.id } });
    }
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: used > 0 ? "MEAL_SLOT_ARCHIVED" : "MEAL_SLOT_DELETED",
      entity: "MealSlot",
      entityId: slot.id,
      before: toSlotDto(slot),
    });
    return { archived: used > 0 };
  });
}

async function assertNotLastActive(db: DbClient, messId: string) {
  const active = await db.mealSlot.count({ where: { messId, isActive: true } });
  if (active <= 1) {
    throw ApiError.unprocessable("A mess needs at least one meal", ERROR_CODES.BAD_REQUEST);
  }
}
