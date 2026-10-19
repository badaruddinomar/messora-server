import { Worker } from "bullmq";
import { runMealGeneration } from "./jobs/meal-generation.job.js";
import { connection, JOBS, mealsQueue, QUEUES } from "./jobs/queues.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";

/** Background worker: runs scheduled jobs. Start it next to the API with `npm run worker`. */
const queue = mealsQueue();

// Upserting the scheduler keeps exactly one schedule however many times the worker restarts.
await queue.upsertJobScheduler(
  JOBS.generateMeals,
  { pattern: "5 * * * *" }, // hourly, at :05
  { name: JOBS.generateMeals, opts: { removeOnComplete: 48, removeOnFail: 100 } },
);
// Catch up straight away instead of waiting for the next hour.
await queue.add(JOBS.generateMeals, {}, { removeOnComplete: 48, removeOnFail: 100 });

const worker = new Worker(
  QUEUES.meals,
  async (job) => {
    if (job.name === JOBS.generateMeals) return runMealGeneration();
    throw new Error(`Unknown job: ${job.name}`);
  },
  { connection, concurrency: 1 },
);

worker.on("completed", (job, result) => logger.info({ job: job.name, result }, "Job completed"));
worker.on("failed", (job, err) => logger.error({ job: job?.name, err }, "Job failed"));
worker.on("error", (err) => logger.error({ err }, "Worker error"));
logger.info("Messora worker started");

async function shutdown(signal: string) {
  logger.info(`${signal} received, stopping worker`);
  await worker.close();
  await queue.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
