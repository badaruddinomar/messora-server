import { MonthStatus, NotificationType } from "@prisma/client";
import { logger } from "../lib/logger.js";
import { notify } from "../lib/notify.js";
import { prisma } from "../lib/prisma.js";
import { monthLabel } from "../modules/months/months.service.js";
import { todayIn, zonedDateTime } from "../utils/date.js";

/** Local time in each mess when members with a due get their reminder. */
export const DUE_REMINDER_TIME = "09:00";
/** A summary isn't reminded twice within this many days. */
const REMIND_EVERY_DAYS = 20;

/**
 * On each mess's `dueReminderDay` (from 09:00 mess time), reminds members who still owe money from the
 * latest closed month, while it can still be settled (the month after it is open). Runs hourly; each
 * unpaid bill gets one reminder per month.
 */
export async function runDueReminders(now = new Date()) {
  const messes = await prisma.mess.findMany({
    where: { deletedAt: null, isActive: true, settings: { dueReminderDay: { not: null } } },
    select: { id: true, timezone: true, settings: { select: { dueReminderDay: true } } },
  });

  let sent = 0;
  for (const mess of messes) {
    const today = todayIn(mess.timezone, now);
    if (Number(today.slice(8)) !== mess.settings!.dueReminderDay) continue;
    if (now < zonedDateTime(today, DUE_REMINDER_TIME, mess.timezone)) continue;
    try {
      const latest = await prisma.messMonth.findFirst({
        where: { messId: mess.id, status: MonthStatus.CLOSED },
        orderBy: { startDate: "desc" },
      });
      if (!latest) continue;
      const next = await prisma.messMonth.findFirst({
        where: { messId: mess.id, startDate: { gt: latest.endDate } },
        orderBy: { startDate: "asc" },
      });
      if (next?.status === MonthStatus.CLOSED) continue;

      const dues = await prisma.memberMonthSummary.findMany({
        where: { monthId: latest.id, isSettled: false, closingBalance: { lt: 0 } },
        select: { id: true, closingBalance: true, settledAmount: true, member: { select: { userId: true } } },
      });
      const since = new Date(now.getTime() - REMIND_EVERY_DAYS * 86_400_000);
      const reminded = await prisma.notification.findMany({
        where: {
          type: NotificationType.DUE_REMINDER,
          entityId: { in: dues.map((d) => d.id) },
          createdAt: { gte: since },
        },
        select: { entityId: true },
      });
      for (const due of dues.filter((d) => !reminded.some((r) => r.entityId === d.id))) {
        const left = due.closingBalance.abs().minus(due.settledAmount);
        await notify(prisma, {
          userIds: [due.member.userId],
          messId: mess.id,
          type: NotificationType.DUE_REMINDER,
          title: `You owe the mess ৳${left.toFixed(2)}`,
          body: `Your ${monthLabel(latest)} bill isn't settled yet. Pay the manager and they'll record it.`,
          entity: "MemberMonthSummary",
          entityId: due.id,
        });
        sent += 1;
      }
    } catch (err) {
      logger.error({ err, messId: mess.id }, "Due reminders failed for a mess");
    }
  }
  return { messes: messes.length, sent };
}
