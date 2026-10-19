import { MemberStatus, MessRole, NotificationType, type Prisma } from "@prisma/client";
import { ERROR_CODES } from "../../constants/error-codes.js";
import { audit } from "../../lib/audit.js";
import { notify } from "../../lib/notify.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import { hasManagerAccess, type Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { fromDbDate, todayIn, toDbDate } from "../../utils/date.js";
import { addToGroupChat, removeFromGroupChat } from "../chat/chat.membership.js";
import { toMessDto } from "../messes/messes.service.js";
import { activeAdminCount, managerUserIds } from "./members.queries.js";

// ---------- DTO ----------

const memberInclude = {
  user: { select: { id: true, name: true, phone: true, email: true, avatarUrl: true } },
} satisfies Prisma.MessMemberInclude;

type MemberRow = Prisma.MessMemberGetPayload<{ include: typeof memberInclude }>;

/** Email addresses are only shown to managers; phone numbers are shared within the mess. */
function toMemberDto(member: MemberRow, viewerCanManage: boolean) {
  return {
    id: member.id,
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt ? fromDbDate(member.joinedAt) : null,
    leftAt: member.leftAt ? fromDbDate(member.leftAt) : null,
    leaveReason: viewerCanManage ? member.leaveReason : null,
    requestedAt: member.createdAt,
    user: { ...member.user, email: viewerCanManage ? member.user.email : null },
  };
}

// ---------- helpers ----------

async function findMember(db: DbClient, messId: string, memberId: string) {
  const member = await db.messMember.findFirst({ where: { id: memberId, messId }, include: memberInclude });
  if (!member) throw ApiError.notFound("Member not found");
  return member;
}

const messTimezone = async (db: DbClient, messId: string) =>
  (await db.mess.findUniqueOrThrow({ where: { id: messId }, select: { timezone: true } })).timezone;

/** BUSINESS_RULES §2: a mess must always keep at least one ACTIVE admin. */
async function assertNotLastAdmin(
  db: DbClient,
  member: { messId: string; role: MessRole; status: MemberStatus },
) {
  if (member.role !== MessRole.ADMIN || member.status !== MemberStatus.ACTIVE) return;
  if ((await activeAdminCount(db, member.messId)) <= 1) {
    throw ApiError.unprocessable(
      "A mess needs at least one admin. Make someone else an admin first.",
      ERROR_CODES.LAST_ADMIN,
    );
  }
}

const messNameOf = async (db: DbClient, messId: string) =>
  (await db.mess.findUniqueOrThrow({ where: { id: messId }, select: { name: true } })).name;

// ---------- use cases ----------

export async function listMembers(membership: Membership, status: MemberStatus) {
  const canManage = hasManagerAccess(membership);
  // Pending requests are for managers only; everyone can see who's in the mess (and who left).
  if (status === MemberStatus.PENDING && !canManage) {
    throw ApiError.forbidden("Only managers can see join requests", ERROR_CODES.INSUFFICIENT_ROLE);
  }
  const members = await prisma.messMember.findMany({
    where: { messId: membership.messId, status },
    include: memberInclude,
    orderBy:
      status === MemberStatus.PENDING ? { createdAt: "asc" } : [{ role: "asc" }, { user: { name: "asc" } }],
  });
  return members.map((m) => toMemberDto(m, canManage));
}

/** Requests to join a mess with its join code. A manager must approve (Phase 2 rules). */
export async function requestToJoin(userId: string, joinCode: string) {
  const mess = await prisma.mess.findFirst({
    where: { joinCode, isActive: true, deletedAt: null },
    include: { _count: { select: { members: { where: { status: MemberStatus.ACTIVE } } } } },
  });
  if (!mess) throw ApiError.notFound("No mess found with this join code", ERROR_CODES.INVALID_JOIN_CODE);

  const existing = await prisma.messMember.findUnique({
    where: { messId_userId: { messId: mess.id, userId } },
  });
  if (existing?.status === MemberStatus.ACTIVE) {
    throw ApiError.conflict("You're already a member of this mess", ERROR_CODES.ALREADY_MEMBER);
  }
  if (existing?.status === MemberStatus.PENDING) {
    throw ApiError.conflict(
      "You've already asked to join. A manager will review it soon.",
      ERROR_CODES.ALREADY_REQUESTED,
    );
  }
  if (existing?.status === MemberStatus.SUSPENDED) {
    throw ApiError.forbidden("Your membership in this mess is suspended", ERROR_CODES.MEMBERSHIP_SUSPENDED);
  }

  const member = await prisma.$transaction(async (tx) => {
    // People who left can ask to come back; their old membership row is reused so history stays linked.
    const row = existing
      ? await tx.messMember.update({
          where: { id: existing.id },
          data: { status: MemberStatus.PENDING, role: MessRole.MEMBER },
        })
      : await tx.messMember.create({ data: { messId: mess.id, userId, status: MemberStatus.PENDING } });

    const requester = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
    await notify(tx, {
      userIds: await managerUserIds(tx, mess.id),
      messId: mess.id,
      type: NotificationType.JOIN_REQUEST,
      title: "New join request",
      body: `${requester.name} wants to join ${mess.name}`,
      entity: "MessMember",
      entityId: row.id,
    });
    return row;
  });

  return toMessDto(mess, member);
}

export async function approveMember(membership: Membership, memberId: string) {
  return prisma.$transaction(async (tx) => {
    const member = await findMember(tx, membership.messId, memberId);
    if (member.status !== MemberStatus.PENDING) throw ApiError.conflict("This request was already handled");

    const today = todayIn(await messTimezone(tx, membership.messId));
    const updated = await tx.messMember.update({
      where: { id: member.id },
      data: { status: MemberStatus.ACTIVE, joinedAt: toDbDate(today), leftAt: null, leaveReason: null },
      include: memberInclude,
    });
    await addToGroupChat(tx, membership.messId, member.userId);
    await notify(tx, {
      userIds: [member.userId],
      messId: membership.messId,
      type: NotificationType.JOIN_APPROVED,
      title: "You're in!",
      body: `Your request to join ${await messNameOf(tx, membership.messId)} was approved`,
      entity: "Mess",
      entityId: membership.messId,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "MEMBER_APPROVED",
      entity: "MessMember",
      entityId: member.id,
    });
    return toMemberDto(updated, true);
  });
}

/** Rejecting removes the request, so the person can ask again later. */
export async function rejectMember(membership: Membership, memberId: string) {
  await prisma.$transaction(async (tx) => {
    const member = await findMember(tx, membership.messId, memberId);
    if (member.status !== MemberStatus.PENDING) throw ApiError.conflict("This request was already handled");

    // A returning member's row carries their history, so it goes back to LEFT instead of being deleted.
    if (member.joinedAt) {
      await tx.messMember.update({ where: { id: member.id }, data: { status: MemberStatus.LEFT } });
    } else {
      await tx.messMember.delete({ where: { id: member.id } });
    }
    await notify(tx, {
      userIds: [member.userId],
      messId: membership.messId,
      type: NotificationType.JOIN_REJECTED,
      title: "Join request declined",
      body: `Your request to join ${await messNameOf(tx, membership.messId)} was declined`,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "MEMBER_REJECTED",
      entity: "MessMember",
      entityId: member.id,
    });
  });
}

export async function changeRole(membership: Membership, memberId: string, role: MessRole) {
  return prisma.$transaction(async (tx) => {
    const member = await findMember(tx, membership.messId, memberId);
    if (member.status !== MemberStatus.ACTIVE) {
      throw ApiError.unprocessable(
        "Only active members can have their role changed",
        ERROR_CODES.MEMBERSHIP_INACTIVE,
      );
    }
    if (member.role === role) return toMemberDto(member, true);
    if (role !== MessRole.ADMIN) await assertNotLastAdmin(tx, member);

    const updated = await tx.messMember.update({
      where: { id: member.id },
      data: { role },
      include: memberInclude,
    });
    await notify(tx, {
      userIds: [member.userId],
      messId: membership.messId,
      type: NotificationType.ROLE_CHANGED,
      title: "Your role changed",
      body: `You're now ${role === MessRole.ADMIN ? "an admin" : role === MessRole.MANAGER ? "a manager" : "a member"} of ${await messNameOf(tx, membership.messId)}`,
      entity: "Mess",
      entityId: membership.messId,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "MEMBER_ROLE_CHANGED",
      entity: "MessMember",
      entityId: member.id,
      before: { role: member.role },
      after: { role },
    });
    return toMemberDto(updated, true);
  });
}

export async function setSuspended(membership: Membership, memberId: string, suspended: boolean) {
  return prisma.$transaction(async (tx) => {
    const member = await findMember(tx, membership.messId, memberId);
    if (member.id === membership.id)
      throw ApiError.unprocessable("You can't suspend yourself", ERROR_CODES.BAD_REQUEST);

    const from = suspended ? MemberStatus.ACTIVE : MemberStatus.SUSPENDED;
    if (member.status !== from) {
      throw ApiError.conflict(
        suspended ? "Only active members can be suspended" : "This member isn't suspended",
      );
    }
    if (suspended) await assertNotLastAdmin(tx, member);

    const updated = await tx.messMember.update({
      where: { id: member.id },
      data: { status: suspended ? MemberStatus.SUSPENDED : MemberStatus.ACTIVE },
      include: memberInclude,
    });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: suspended ? "MEMBER_SUSPENDED" : "MEMBER_REACTIVATED",
      entity: "MessMember",
      entityId: member.id,
    });
    return toMemberDto(updated, true);
  });
}

/** Marks a member as LEFT. Their records stay, so past months and balances remain correct. */
async function endMembership(
  tx: DbClient,
  member: { id: string; messId: string; userId: string; role: MessRole; status: MemberStatus },
  reason: string | undefined,
) {
  await assertNotLastAdmin(tx, member);
  const today = todayIn(await messTimezone(tx, member.messId));
  await tx.messMember.update({
    where: { id: member.id },
    data: {
      status: MemberStatus.LEFT,
      leftAt: toDbDate(today),
      leaveReason: reason ?? null,
      role: MessRole.MEMBER,
    },
  });
  await removeFromGroupChat(tx, member.messId, member.userId);
}

export async function removeMember(membership: Membership, memberId: string, reason?: string) {
  await prisma.$transaction(async (tx) => {
    const member = await findMember(tx, membership.messId, memberId);
    if (member.id === membership.id) {
      throw ApiError.unprocessable("Use “Leave mess” to remove yourself", ERROR_CODES.BAD_REQUEST);
    }
    if (member.status !== MemberStatus.ACTIVE && member.status !== MemberStatus.SUSPENDED) {
      throw ApiError.conflict("This person isn't a member");
    }
    await endMembership(tx, member, reason);
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "MEMBER_REMOVED",
      entity: "MessMember",
      entityId: member.id,
      after: { reason: reason ?? null },
    });
  });
}

export async function leaveMess(membership: Membership, reason?: string) {
  await prisma.$transaction(async (tx) => {
    await endMembership(tx, membership, reason);
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "MEMBER_LEFT",
      entity: "MessMember",
      entityId: membership.id,
    });
  });
}

/** Cancels the caller's own pending join request. */
export async function cancelJoinRequest(userId: string, messId: string) {
  const member = await prisma.messMember.findUnique({ where: { messId_userId: { messId, userId } } });
  if (!member || member.status !== MemberStatus.PENDING) throw ApiError.notFound("No pending request");
  if (member.joinedAt) {
    await prisma.messMember.update({ where: { id: member.id }, data: { status: MemberStatus.LEFT } });
  } else {
    await prisma.messMember.delete({ where: { id: member.id } });
  }
}
