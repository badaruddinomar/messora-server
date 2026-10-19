import type { NotificationType, Prisma } from "@prisma/client";
import type { DbClient } from "./prisma.js";

export interface NotifyInput {
  userIds: readonly string[];
  messId?: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Deep-link target, e.g. entity "Bazar" + its id. */
  entity?: string;
  entityId?: string;
  data?: Prisma.InputJsonValue;
}

/**
 * Creates in-app notifications for each recipient. Delivery over push/email/realtime is added in
 * Phase 10 by a worker that picks these up, so callers don't change when channels are added.
 */
export async function notify(db: DbClient, { userIds, ...notification }: NotifyInput) {
  const recipients = [...new Set(userIds)];
  if (recipients.length === 0) return;
  await db.notification.createMany({
    data: recipients.map((userId) => ({ userId, ...notification })),
  });
}
