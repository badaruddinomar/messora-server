import { Worker, type Queue } from "bullmq";
import { runBazarDutyReminders } from "./jobs/bazar-duty-reminder.job.js";
import { runDueReminders } from "./jobs/due-reminder.job.js";
import { runMealGeneration } from "./jobs/meal-generation.job.js";
import { connection, createQueue, JOBS, QUEUES, type QueueName } from "./jobs/queues.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";

/** Background worker: runs scheduled jobs. Start it next to the API with `npm run worker`. */

interface ScheduledJob {
  queue: QueueName;
  name: string;
  /** Cron pattern (UTC). Hourly jobs cover each mess's local time within the hour. */
  pattern: string;
  run: () => Promise<unknown>;
}

const SCHEDULE: ScheduledJob[] = [
  { queue: QUEUES.meals, name: JOBS.generateMeals, pattern: "5 * * * *", run: runMealGeneration },
  {
    queue: QUEUES.reminders,
    name: JOBS.bazarDutyReminders,
    pattern: "10 * * * *",
    run: () => runBazarDutyReminders(),
  },
  { queue: QUEUES.reminders, name: JOBS.dueReminders, pattern: "15 * * * *", run: () => runDueReminders() },
];

const jobOpts = { removeOnComplete: 48, removeOnFail: 100 };
const queues = new Map<QueueName, Queue>();
const workers: Worker[] = [];

for (const name of new Set(SCHEDULE.map((j) => j.queue))) {
  queues.set(name, createQueue(name));
  const worker = new Worker(
    name,
    async (job) => {
      const scheduled = SCHEDULE.find((j) => j.queue === name && j.name === job.name);
      if (!scheduled) throw new Error(`Unknown job: ${job.name}`);
      return scheduled.run();
    },
    { connection, concurrency: 1 },
  );
  worker.on("completed", (job, result) => logger.info({ job: job.name, result }, "Job completed"));
  worker.on("failed", (job, err) => logger.error({ job: job?.name, err }, "Job failed"));
  worker.on("error", (err) => logger.error({ err }, "Worker error"));
  workers.push(worker);
}

for (const job of SCHEDULE) {
  const queue = queues.get(job.queue)!;
  // Upserting the scheduler keeps exactly one schedule however many times the worker restarts.
  await queue.upsertJobScheduler(job.name, { pattern: job.pattern }, { name: job.name, opts: jobOpts });
  // Catch up straight away instead of waiting for the next run (every job is idempotent).
  await queue.add(job.name, {}, jobOpts);
}
logger.info("Messora worker started");

async function shutdown(signal: string) {
  logger.info(`${signal} received, stopping worker`);
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all([...queues.values()].map((q) => q.close()));
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
