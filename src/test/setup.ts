import { afterAll, beforeEach } from "vitest";
import { prisma } from "../lib/prisma.js";

let tables: string[] | undefined;

/** Empties every table before each test so tests never depend on each other. */
beforeEach(async () => {
  tables ??= (
    await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
  ).map((t) => `"public"."${t.tablename}"`);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await prisma.$disconnect();
});
