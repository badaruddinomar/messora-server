import { randomUUID } from "node:crypto";
import { MemberStatus, MessRole, Prisma, type Mess } from "@prisma/client";
import { ERROR_CODES } from "../../constants/error-codes.js";
import { audit } from "../../lib/audit.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import { hasManagerAccess, type Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { generateCode } from "../../utils/crypto.js";
import { todayIn, toDbDate } from "../../utils/date.js";
import { createGroupConversation } from "../chat/chat.membership.js";
import { periodContaining } from "../months/month-period.js";
import type { CreateMessInput, UpdateMessInput, UpdateSettingsInput } from "./messes.schema.js";

// ---------- DTOs ----------

type MessWithCounts = Mess & { _count?: { members: number } };

/** Public shape of a mess for a given member. The join code is only shown to managers. */
export function toMessDto(
  mess: MessWithCounts,
  membership: Pick<Membership, "id" | "role" | "status"> & { isMonthManager?: boolean },
) {
  const canManage = hasManagerAccess({ isMonthManager: false, ...membership });
  return {
    id: mess.id,
    name: mess.name,
    slug: mess.slug,
    address: mess.address,
    logoUrl: mess.logoUrl,
    gender: mess.gender,
    currency: mess.currency,
    timezone: mess.timezone,
    monthStartDay: mess.monthStartDay,
    createdAt: mess.createdAt,
    joinCode: canManage ? mess.joinCode : null,
    activeMemberCount: mess._count?.members,
    membership: { id: membership.id, role: membership.role, status: membership.status },
  };
}

const activeMemberCount = { _count: { select: { members: { where: { status: MemberStatus.ACTIVE } } } } };

// ---------- helpers ----------

/** "Green House Mess" → "green-house-mess". Non-Latin names fall back to "mess". */
export function slugify(name: string) {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // drop accents: "é" → "e"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "mess";
}

async function uniqueSlug(db: DbClient, name: string) {
  const base = slugify(name);
  if (!(await db.mess.findUnique({ where: { slug: base }, select: { id: true } }))) return base;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${base}-${generateCode(4).toLowerCase()}`;
    if (!(await db.mess.findUnique({ where: { slug: candidate }, select: { id: true } }))) return candidate;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
}

async function uniqueJoinCode(db: DbClient) {
  for (;;) {
    const code = generateCode(8);
    if (!(await db.mess.findUnique({ where: { joinCode: code }, select: { id: true } }))) return code;
  }
}

// ---------- use cases ----------

/**
 * Creates a mess with everything it needs to be usable right away, in one transaction:
 * settings, the creator as ADMIN, meal slots, the group chat and the current billing month.
 */
export async function createMess(userId: string, input: CreateMessInput) {
  const today = todayIn(input.timezone);
  const period = periodContaining(today, input.monthStartDay);

  const mess = await prisma.$transaction(async (tx) => {
    const created = await tx.mess.create({
      data: {
        name: input.name,
        slug: await uniqueSlug(tx, input.name),
        joinCode: await uniqueJoinCode(tx),
        address: input.address ?? null,
        gender: input.gender,
        monthStartDay: input.monthStartDay,
        timezone: input.timezone,
        createdById: userId,
        settings: { create: {} },
        members: {
          create: { userId, role: MessRole.ADMIN, status: MemberStatus.ACTIVE, joinedAt: toDbDate(today) },
        },
        mealSlots: {
          create: input.mealSlots.map((slot, sortOrder) => ({
            name: slot.name,
            weight: new Prisma.Decimal(slot.weight),
            cutoffTime: slot.cutoffTime ?? null,
            sortOrder,
          })),
        },
        months: {
          create: {
            year: period.year,
            month: period.month,
            startDate: toDbDate(period.startDate),
            endDate: toDbDate(period.endDate),
          },
        },
      },
      include: { members: true, ...activeMemberCount },
    });
    await createGroupConversation(tx, created.id, created.name, userId);
    await audit(tx, {
      messId: created.id,
      actorId: userId,
      action: "MESS_CREATED",
      entity: "Mess",
      entityId: created.id,
      after: { name: created.name },
    });
    return created;
  });

  return toMessDto(mess, mess.members[0]);
}

/** Messes the user belongs to or has asked to join (left messes are excluded). */
export async function listMyMesses(userId: string) {
  const memberships = await prisma.messMember.findMany({
    where: {
      userId,
      status: { in: [MemberStatus.ACTIVE, MemberStatus.PENDING, MemberStatus.SUSPENDED] },
      mess: { isActive: true, deletedAt: null },
    },
    include: { mess: { include: activeMemberCount } },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map(({ mess, ...membership }) => toMessDto(mess, membership));
}

export async function getMess(membership: Membership) {
  const mess = await prisma.mess.findUniqueOrThrow({
    where: { id: membership.messId },
    include: activeMemberCount,
  });
  return toMessDto(mess, membership);
}

export async function updateMess(membership: Membership, input: UpdateMessInput) {
  const before = await prisma.mess.findUniqueOrThrow({ where: { id: membership.messId } });
  const mess = await prisma.$transaction(async (tx) => {
    const updated = await tx.mess.update({
      where: { id: membership.messId },
      data: input,
      include: activeMemberCount,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "MESS_UPDATED",
      entity: "Mess",
      entityId: membership.messId,
      before: pick(before, Object.keys(input)),
      after: pick(updated, Object.keys(input)),
    });
    return updated;
  });
  return toMessDto(mess, membership);
}

/** Soft-deletes the mess. The admin must type the mess name to confirm. */
export async function deleteMess(membership: Membership, confirmName: string) {
  const mess = await prisma.mess.findUniqueOrThrow({ where: { id: membership.messId } });
  if (confirmName.trim().toLowerCase() !== mess.name.trim().toLowerCase()) {
    throw ApiError.unprocessable("Type the mess name exactly to confirm", ERROR_CODES.CONFIRMATION_MISMATCH);
  }
  await prisma.$transaction(async (tx) => {
    await tx.mess.update({ where: { id: mess.id }, data: { isActive: false, deletedAt: new Date() } });
    await audit(tx, {
      messId: mess.id,
      actorId: membership.userId,
      action: "MESS_DELETED",
      entity: "Mess",
      entityId: mess.id,
    });
  });
}

export async function regenerateJoinCode(membership: Membership) {
  const mess = await prisma.mess.update({
    where: { id: membership.messId },
    data: { joinCode: await uniqueJoinCode(prisma) },
    include: activeMemberCount,
  });
  await audit(prisma, {
    messId: mess.id,
    actorId: membership.userId,
    action: "JOIN_CODE_REGENERATED",
    entity: "Mess",
    entityId: mess.id,
  });
  return toMessDto(mess, membership);
}

const settingsSelect = {
  autoGenerateMeals: true,
  allowMemberMealEdit: true,
  allowGuestMeal: true,
  requireBazarApproval: true,
  requireDepositApproval: true,
  prorateSeatRent: true,
  mealRateDecimals: true,
  dueReminderDay: true,
  updatedAt: true,
} satisfies Prisma.MessSettingSelect;

export const getSettings = (messId: string) =>
  prisma.messSetting.upsert({ where: { messId }, create: { messId }, update: {}, select: settingsSelect });

export async function updateSettings(membership: Membership, input: UpdateSettingsInput) {
  const before = await getSettings(membership.messId);
  const settings = await prisma.messSetting.update({
    where: { messId: membership.messId },
    data: input,
    select: settingsSelect,
  });
  await audit(prisma, {
    messId: membership.messId,
    actorId: membership.userId,
    action: "SETTINGS_UPDATED",
    entity: "MessSetting",
    entityId: membership.messId,
    before: pick(before, Object.keys(input)),
    after: pick(settings, Object.keys(input)),
  });
  return settings;
}

function pick<T extends object>(obj: T, keys: string[]): Prisma.InputJsonObject {
  return Object.fromEntries(
    keys.map((k) => [k, (obj as Record<string, unknown>)[k] ?? null]),
  ) as Prisma.InputJsonObject;
}
