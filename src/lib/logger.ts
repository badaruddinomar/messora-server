import { pino } from "pino";
import { env, isProd } from "../config/env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  // Never let credentials reach the logs, even if a request is logged with its body.
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      "*.password",
      "*.refreshToken",
      "*.accessToken",
    ],
    censor: "[redacted]",
  },
  ...(!isProd &&
    env.NODE_ENV !== "test" && { transport: { target: "pino-pretty", options: { singleLine: true } } }),
});
