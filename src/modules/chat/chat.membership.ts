import { ConversationType, ParticipantRole } from "@prisma/client";
import type { DbClient } from "../../lib/prisma.js";

/** Unique key of a mess's group conversation (one per mess). */
export const groupConversationKey = (messId: string) => `group:${messId}`;

/** Creates the mess group conversation. Called once, when the mess is created. */
export function createGroupConversation(db: DbClient, messId: string, title: string, adminUserId: string) {
  return db.conversation.create({
    data: {
      messId,
      type: ConversationType.MESS_GROUP,
      uniqueKey: groupConversationKey(messId),
      title,
      participants: { create: { userId: adminUserId, role: ParticipantRole.ADMIN } },
    },
  });
}

/** Adds a member to the group chat, or restores them if they had left (history stays visible). */
export async function addToGroupChat(db: DbClient, messId: string, userId: string) {
  const conversation = await db.conversation.findUnique({
    where: { uniqueKey: groupConversationKey(messId) },
    select: { id: true },
  });
  if (!conversation) return;
  await db.conversationParticipant.upsert({
    where: { conversationId_userId: { conversationId: conversation.id, userId } },
    create: { conversationId: conversation.id, userId },
    update: { leftAt: null },
  });
}

/** Marks a member as having left the group chat; they keep read-only access to past messages. */
export async function removeFromGroupChat(db: DbClient, messId: string, userId: string) {
  const conversation = await db.conversation.findUnique({
    where: { uniqueKey: groupConversationKey(messId) },
    select: { id: true },
  });
  if (!conversation) return;
  await db.conversationParticipant.updateMany({
    where: { conversationId: conversation.id, userId, leftAt: null },
    data: { leftAt: new Date() },
  });
}
