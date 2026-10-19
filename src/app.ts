import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env, isProd } from "./config/env.js";
import { API_PREFIX } from "./constants/index.js";
import { errorHandler, notFoundHandler } from "./middlewares/error-handler.js";
import routes from "./routes/index.js";

export const app = express();

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: env.CLIENT_URL, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(morgan(isProd ? "combined" : "dev"));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(API_PREFIX, routes);

app.use(notFoundHandler);
app.use(errorHandler);
