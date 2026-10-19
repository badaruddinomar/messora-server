import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CLIENT_URL: z.url(),

  DATABASE_URL: z.string().min(1),
  /** Redis for background jobs (BullMQ). Only the worker connects to it. */
  REDIS_URL: z.string().default("redis://localhost:6379"),

  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** Requests per 15 minutes per IP on sensitive auth routes. Raise it locally when running e2e tests. */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),

  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),

  BREVO_API_KEY: z.string().optional(),
  MAIL_FROM_EMAIL: z.email(),
  MAIL_FROM_NAME: z.string().default("Messora"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // The logger depends on env, so this is the one place that writes to the console directly.
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables:\n", z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
