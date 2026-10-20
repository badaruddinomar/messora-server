import { NotificationType } from "@prisma/client";
import { logger } from "../lib/logger.js";
import { notify } from "../lib/notify.js";
import { prisma } from "../lib/prisma.js";
import { todayIn, toDbDate, zonedDateTime } from "../utils/date.js";

/** Local time in each mess when members with bazar duty today get a reminder. */
export const REMINDER_TIME = "08:00";

/**
 * Reminds members with bazar duty today that isn't done yet, once per duty, from 08:00 in the mess
 * timezone. Runs hourly; a duty that already has a reminder is skipped, so extra runs send nothing.
 */
export async function runBazarDutyReminders(now = new Date()) {
  const messes = await prisma.mess.findMany({
    where: { deletedAt: null, isActive: true },
    select: { id: true, timezone: true },
  });

  let sent = 0;
  for (const mess of messes) {
    const today = todayIn(mess.timezone, now);
    if (now < zonedDateTime(today, REMINDER_TIME, mess.timezone)) continue;
    try {
      const duties = await prisma.bazarSchedule.findMany({
        where: { messId: mess.id, date: toDbDate(today), isDone: false, member: { status: "ACTIVE" } },
        select: { id: true, member: { select: { userId: true } } },
      });
      if (duties.length === 0) continue;
      const reminded = await prisma.notification.findMany({
        where: {
          entity: "BazarSchedule",
          entityId: { in: duties.map((d) => d.id) },
          type: NotificationType.BAZAR_DUTY_REMINDER,
          title: "Bazar duty today",
        },
        select: { entityId: true },
      });
      for (const duty of duties.filter((d) => !reminded.some((r) => r.entityId === d.id))) {
        await notify(prisma, {
          userIds: [duty.member.userId],
          messId: mess.id,
          type: NotificationType.BAZAR_DUTY_REMINDER,
          title: "Bazar duty today",
          body: "It's your turn to do the bazar. Add it in Messora with the receipt when you're back.",
          entity: "BazarSchedule",
          entityId: duty.id,
        });
        sent += 1;
      }
    } catch (err) {
      logger.error({ err, messId: mess.id }, "Bazar duty reminders failed for a mess");
    }
  }
  return { messes: messes.length, sent };
}
