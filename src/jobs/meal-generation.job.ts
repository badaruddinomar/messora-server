import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { generateMealEntries } from "../modules/meals/meals.generation.js";
import { ensureCurrentMonth } from "../modules/months/months.service.js";
import { addDays, todayIn } from "../utils/date.js";

/**
 * For every live mess: open the current month (and tomorrow's, if it starts tomorrow) and create
 * today's and tomorrow's usual meals in the mess timezone. Runs hourly so each timezone is covered
 * soon after its midnight; generation is idempotent, so the extra runs change nothing.
 * Opening a day in the app does the same on demand, so a missed run never shows an empty day.
 */
export async function runMealGeneration() {
  const messes = await prisma.mess.findMany({
    where: { deletedAt: null, isActive: true },
    select: { id: true, timezone: true },
  });

  let created = 0;
  let failed = 0;
  for (const mess of messes) {
    try {
      const today = todayIn(mess.timezone);
      const tomorrow = addDays(today, 1);
      await ensureCurrentMonth(prisma, mess.id, tomorrow);
      created += await generateMealEntries(prisma, mess.id, today, tomorrow);
    } catch (err) {
      // One broken mess shouldn't stop the others; the next run retries it.
      failed += 1;
      logger.error({ err, messId: mess.id }, "Meal generation failed for a mess");
    }
  }
  return { messes: messes.length, created, failed };
}
