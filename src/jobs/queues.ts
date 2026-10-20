import { Queue } from "bullmq";
import { env } from "../config/env.js";

/** BullMQ needs `maxRetriesPerRequest: null` so blocking commands wait for Redis instead of failing. */
export const connection = { url: env.REDIS_URL, maxRetriesPerRequest: null };

export const QUEUES = { meals: "meals", reminders: "reminders" } as const;
export const JOBS = {
  generateMeals: "generate-meals",
  bazarDutyReminders: "bazar-duty-reminders",
  dueReminders: "due-reminders",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const createQueue = (name: QueueName) => new Queue(name, { connection });
