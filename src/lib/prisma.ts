import { PrismaClient, type Prisma } from "@prisma/client";
import { isProd } from "../config/env.js";

export const prisma = new PrismaClient({
  log: isProd ? ["error"] : ["warn", "error"],
});

/** The root client or a transaction client, for helpers that work both inside and outside `$transaction`. */
export type DbClient = PrismaClient | Prisma.TransactionClient;
