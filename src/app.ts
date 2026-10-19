import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { API_PREFIX } from "./constants/index.js";
import { logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middlewares/error-handler.js";
import routes from "./routes/index.js";

export const app = express();

app.set("trust proxy", 1);
app.use(
  pinoHttp({
    logger,
    // Reuse an incoming request id (from a proxy/load balancer) so logs can be correlated end to end.
    genReqId: (req, res) => {
      const id = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
      res.setHeader("x-request-id", id);
      return id;
    },
    autoLogging: { ignore: (req) => req.url === "/health" },
  }),
);
app.use(helmet());
app.use(cors({ origin: env.CLIENT_URL, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(API_PREFIX, routes);

app.use(notFoundHandler);
app.use(errorHandler);
