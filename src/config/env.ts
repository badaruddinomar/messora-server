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

  /**
   * Where uploaded files (receipts) go. "local" keeps them on disk under LOCAL_STORAGE_DIR, for
   * development and tests; "s3" uses any S3-compatible bucket (Cloudflare R2, AWS S3, MinIO).
   */
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  LOCAL_STORAGE_DIR: z.string().default("./uploads"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  /** Needed for R2 and MinIO, e.g. https://<account>.r2.cloudflarestorage.com */
  S3_ENDPOINT: z.url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  BREVO_API_KEY: z.string().optional(),
  MAIL_FROM_EMAIL: z.email(),
  MAIL_FROM_NAME: z.string().default("Messora"),
});

const parsed = envSchema
  .superRefine((v, ctx) => {
    if (v.STORAGE_DRIVER !== "s3") return;
    for (const key of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
      if (!v[key]) ctx.addIssue({ code: "custom", path: [key], message: "Required when STORAGE_DRIVER=s3" });
    }
  })
  .safeParse(process.env);

if (!parsed.success) {
  // The logger depends on env, so this is the one place that writes to the console directly.
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables:\n", z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
