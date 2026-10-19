import type { Prisma } from "@prisma/client";
import type { DbClient } from "./prisma.js";

export interface AuditEntry {
  messId: string;
  actorId: string;
  /** Upper snake case verb, e.g. "BAZAR_APPROVED", "MEMBER_ROLE_CHANGED". */
  action: string;
  entity: string;
  entityId: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ip?: string;
}

/**
 * Records who changed what in a mess. Pass the transaction client when called inside
 * `prisma.$transaction`, so the audit row commits (or rolls back) with the change itself.
 */
export async function audit(db: DbClient, entry: AuditEntry) {
  await db.auditLog.create({ data: entry });
}
