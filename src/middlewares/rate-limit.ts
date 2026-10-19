import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";
import { ApiError } from "../utils/api-error.js";

/**
 * Rate limiter that responds in the standard error shape.
 * Disabled in tests so suites can hit auth routes freely.
 */
export const createRateLimiter = ({ windowMs, limit }: { windowMs: number; limit: number }) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => env.NODE_ENV === "test",
    handler: (_req, _res, next) => next(ApiError.tooManyRequests()),
  });

/** For routes that send email/SMS or check credentials. */
export const strictLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: env.AUTH_RATE_LIMIT });
