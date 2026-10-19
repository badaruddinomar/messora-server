import {
  InvitationStatus,
  MemberStatus,
  MessRole,
  NotificationType,
  type MessInvitation,
  type Prisma,
} from "@prisma/client";
import { env } from "../../config/env.js";
import { ERROR_CODES } from "../../constants/error-codes.js";
import { audit } from "../../lib/audit.js";
import { invitationTemplate, sendMail } from "../../lib/mail/index.js";
import { logger } from "../../lib/logger.js";
import { notify } from "../../lib/notify.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import type { Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { generateToken, hashToken } from "../../utils/crypto.js";
import { todayIn, toDbDate } from "../../utils/date.js";
import { addToGroupChat } from "../chat/chat.membership.js";
import { toMessDto } from "../messes/messes.service.js";
import type { CreateInvitationInput } from "./invitations.schema.js";

const INVITATION_TTL_DAYS = 7;

const invitationInclude = {
  mess: { select: { id: true, name: true, address: true, isActive: true, deletedAt: true } },
  invitedBy: { select: { name: true } },
} satisfies Prisma.MessInvitationInclude;

type InvitationRow = Prisma.MessInvitationGetPayload<{ include: typeof invitationInclude }>;

/** Pending invitations past their expiry are reported as EXPIRED without a background job. */
const effectiveStatus = (inv: MessInvitation) =>
  inv.status === InvitationStatus.PENDING && inv.expiresAt < new Date()
    ? InvitationStatus.EXPIRED
    : inv.status;

const toInvitationDto = (inv: InvitationRow) => ({
  id: inv.id,
  email: inv.email,
  phone: inv.phone,
  role: inv.role,
  status: effectiveStatus(inv),
  expiresAt: inv.expiresAt,
  createdAt: inv.createdAt,
  invitedBy: inv.invitedBy.name,
  mess: { id: inv.mess.id, name: inv.mess.name, address: inv.mess.address },
});

export const inviteUrl = (token: string) => `${env.CLIENT_URL}/invite/${token}`;

// ---------- managing invitations (mess side) ----------

export async function createInvitation(membership: Membership, input: CreateInvitationInput) {
  if (input.role === MessRole.MANAGER && membership.role !== MessRole.ADMIN) {
    throw ApiError.forbidden("Only admins can invite managers", ERROR_CODES.INSUFFICIENT_ROLE);
  }

  // Don't invite someone who's already in the mess.
  const existingMember = await prisma.messMember.findFirst({
    where: {
      messId: membership.messId,
      status: { in: [MemberStatus.ACTIVE, MemberStatus.SUSPENDED] },
      user: {
        OR: [
          ...(input.phone ? [{ phone: input.phone }] : []),
          ...(input.email ? [{ email: input.email }] : []),
        ],
      },
    },
    select: { id: true },
  });
  if (existingMember) throw ApiError.conflict("This person is already a member", ERROR_CODES.ALREADY_MEMBER);

  const token = generateToken();
  const invitation = await prisma.$transaction(async (tx) => {
    // Re-inviting the same person replaces their previous invitation.
    await tx.messInvitation.updateMany({
      where: {
        messId: membership.messId,
        status: InvitationStatus.PENDING,
        OR: [
          ...(input.phone ? [{ phone: input.phone }] : []),
          ...(input.email ? [{ email: input.email }] : []),
        ],
      },
      data: { status: InvitationStatus.REVOKED, respondedAt: new Date() },
    });
    const created = await tx.messInvitation.create({
      data: {
        messId: membership.messId,
        invitedById: membership.userId,
        email: input.email ?? null,
        phone: input.phone ?? null,
        role: input.role,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
      include: invitationInclude,
    });

    // If the person already has an account, they also see the invitation in the app.
    const invitee = await tx.user.findFirst({
      where: {
        OR: [
          ...(input.phone ? [{ phone: input.phone }] : []),
          ...(input.email ? [{ email: input.email }] : []),
        ],
      },
      select: { id: true },
    });
    if (invitee) {
      await notify(tx, {
        userIds: [invitee.id],
        messId: membership.messId,
        type: NotificationType.INVITATION_RECEIVED,
        title: "You're invited",
        body: `${created.invitedBy.name} invited you to join ${created.mess.name}`,
        entity: "MessInvitation",
        entityId: created.id,
      });
    }
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "INVITATION_CREATED",
      entity: "MessInvitation",
      entityId: created.id,
      after: { email: input.email ?? null, phone: input.phone ?? null, role: input.role },
    });
    return created;
  });

  let emailSent = false;
  if (invitation.email) {
    try {
      await sendMail({
        to: { email: invitation.email },
        subject: `${invitation.invitedBy.name} invited you to ${invitation.mess.name} on Messora`,
        html: invitationTemplate(
          invitation.invitedBy.name,
          invitation.mess.name,
          inviteUrl(token),
          INVITATION_TTL_DAYS,
        ),
      });
      emailSent = true;
    } catch (err) {
      // The invitation still works: the manager can share the link themselves.
      logger.error({ err }, "Failed to send invitation email");
    }
  }

  // The link is only ever returned here (only its hash is stored), so the manager can share it directly.
  return { invitation: toInvitationDto(invitation), inviteUrl: inviteUrl(token), emailSent };
}

export async function listInvitations(membership: Membership) {
  const invitations = await prisma.messInvitation.findMany({
    where: { messId: membership.messId, status: InvitationStatus.PENDING },
    include: invitationInclude,
    orderBy: { createdAt: "desc" },
  });
  return invitations.map(toInvitationDto);
}

export async function revokeInvitation(membership: Membership, invitationId: string) {
  const { count } = await prisma.messInvitation.updateMany({
    where: { id: invitationId, messId: membership.messId, status: InvitationStatus.PENDING },
    data: { status: InvitationStatus.REVOKED, respondedAt: new Date() },
  });
  if (count === 0) throw ApiError.notFound("Invitation not found");
  await audit(prisma, {
    messId: membership.messId,
    actorId: membership.userId,
    action: "INVITATION_REVOKED",
    entity: "MessInvitation",
    entityId: invitationId,
  });
}

// ---------- responding (invitee side) ----------

function assertUsable(inv: InvitationRow) {
  if (effectiveStatus(inv) !== InvitationStatus.PENDING || !inv.mess.isActive || inv.mess.deletedAt) {
    throw ApiError.unprocessable("This invitation is no longer valid", ERROR_CODES.INVITATION_INVALID);
  }
}

async function findByToken(db: DbClient, token: string) {
  const inv = await db.messInvitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: invitationInclude,
  });
  if (!inv) throw ApiError.notFound("Invitation not found", ERROR_CODES.INVITATION_INVALID);
  return inv;
}

/** Public preview of an invitation link, shown before the person logs in or signs up. */
export async function previewInvitation(token: string) {
  const inv = await findByToken(prisma, token);
  const activeMembers = await prisma.messMember.count({
    where: { messId: inv.messId, status: MemberStatus.ACTIVE },
  });
  return {
    messName: inv.mess.name,
    messAddress: inv.mess.address,
    activeMemberCount: activeMembers,
    invitedBy: inv.invitedBy.name,
    role: inv.role,
    status: inv.mess.isActive && !inv.mess.deletedAt ? effectiveStatus(inv) : InvitationStatus.REVOKED,
    expiresAt: inv.expiresAt,
  };
}

/** Invitations sent to the user's phone number or email that they haven't answered yet. */
export async function listReceivedInvitations(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { phone: true, email: true },
  });
  const invitations = await prisma.messInvitation.findMany({
    where: {
      status: InvitationStatus.PENDING,
      expiresAt: { gt: new Date() },
      mess: { isActive: true, deletedAt: null, members: { none: { userId, status: MemberStatus.ACTIVE } } },
      OR: [{ phone: user.phone }, ...(user.email ? [{ email: user.email }] : [])],
    },
    include: invitationInclude,
    orderBy: { createdAt: "desc" },
  });
  return invitations.map(toInvitationDto);
}

/**
 * Accepting an invitation makes the user an ACTIVE member straight away (no approval step).
 * An invitation link works for whoever holds it, once; invitations listed in the app
 * (`byId`) must match the user's phone or email.
 */
async function accept(userId: string, find: (tx: DbClient) => Promise<InvitationRow>) {
  return prisma.$transaction(async (tx) => {
    const inv = await find(tx);
    assertUsable(inv);

    const existing = await tx.messMember.findUnique({
      where: { messId_userId: { messId: inv.messId, userId } },
    });
    if (existing?.status === MemberStatus.ACTIVE) {
      throw ApiError.conflict("You're already a member of this mess", ERROR_CODES.ALREADY_MEMBER);
    }
    if (existing?.status === MemberStatus.SUSPENDED) {
      throw ApiError.forbidden("Your membership in this mess is suspended", ERROR_CODES.MEMBERSHIP_SUSPENDED);
    }

    const mess = await tx.mess.findUniqueOrThrow({
      where: { id: inv.messId },
      include: { _count: { select: { members: { where: { status: MemberStatus.ACTIVE } } } } },
    });
    const joinedAt = toDbDate(todayIn(mess.timezone));
    const data = { status: MemberStatus.ACTIVE, role: inv.role, joinedAt, leftAt: null, leaveReason: null };
    const member = existing
      ? await tx.messMember.update({ where: { id: existing.id }, data })
      : await tx.messMember.create({ data: { ...data, messId: inv.messId, userId } });

    await tx.messInvitation.update({
      where: { id: inv.id },
      data: { status: InvitationStatus.ACCEPTED, acceptedById: userId, respondedAt: new Date() },
    });
    await addToGroupChat(tx, inv.messId, userId);

    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
    await notify(tx, {
      userIds: [inv.invitedById],
      messId: inv.messId,
      type: NotificationType.SYSTEM,
      title: "Invitation accepted",
      body: `${user.name} joined ${mess.name}`,
      entity: "MessMember",
      entityId: member.id,
    });
    await audit(tx, {
      messId: inv.messId,
      actorId: userId,
      action: "INVITATION_ACCEPTED",
      entity: "MessInvitation",
      entityId: inv.id,
    });
    return toMessDto(mess, member);
  });
}

export const acceptByToken = (userId: string, token: string) =>
  accept(userId, (tx) => findByToken(tx, token));

export const acceptById = (userId: string, invitationId: string) =>
  accept(userId, (tx) => findReceived(tx, userId, invitationId));

async function findReceived(db: DbClient, userId: string, invitationId: string) {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { phone: true, email: true },
  });
  const inv = await db.messInvitation.findFirst({
    where: { id: invitationId, OR: [{ phone: user.phone }, ...(user.email ? [{ email: user.email }] : [])] },
    include: invitationInclude,
  });
  if (!inv) throw ApiError.notFound("Invitation not found", ERROR_CODES.INVITATION_INVALID);
  return inv;
}

async function decline(find: (tx: DbClient) => Promise<InvitationRow>) {
  await prisma.$transaction(async (tx) => {
    const inv = await find(tx);
    assertUsable(inv);
    await tx.messInvitation.update({
      where: { id: inv.id },
      data: { status: InvitationStatus.DECLINED, respondedAt: new Date() },
    });
  });
}

export const declineByToken = (token: string) => decline((tx) => findByToken(tx, token));
export const declineById = (userId: string, invitationId: string) =>
  decline((tx) => findReceived(tx, userId, invitationId));
