/** Tests always run against a separate database, never the development one. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/messora_test?schema=public";
