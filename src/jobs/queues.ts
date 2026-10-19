import { Queue } from "bullmq";
import { env } from "../config/env.js";

/** BullMQ needs `maxRetriesPerRequest: null` so blocking commands wait for Redis instead of failing. */
export const connection = { url: env.REDIS_URL, maxRetriesPerRequest: null };

export const QUEUES = { meals: "meals" } as const;
export const JOBS = { generateMeals: "generate-meals" } as const;

export const mealsQueue = () => new Queue(QUEUES.meals, { connection });
