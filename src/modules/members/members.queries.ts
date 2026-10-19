import { MemberStatus, MessRole, MonthStatus } from "@prisma/client";
import type { DbClient } from "../../lib/prisma.js";

/** User ids of everyone with manager powers in a mess: ADMINs, MANAGERs and the OPEN month's manager. */
export async function managerUserIds(db: DbClient, messId: string) {
  const members = await db.messMember.findMany({
    where: {
      messId,
      status: MemberStatus.ACTIVE,
      OR: [
        { role: { in: [MessRole.ADMIN, MessRole.MANAGER] } },
        { managedMonths: { some: { status: MonthStatus.OPEN } } },
      ],
    },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}

/** Number of ACTIVE admins, for the "a mess always keeps an admin" rule (BUSINESS_RULES §2). */
export const activeAdminCount = (db: DbClient, messId: string) =>
  db.messMember.count({ where: { messId, role: MessRole.ADMIN, status: MemberStatus.ACTIVE } });
