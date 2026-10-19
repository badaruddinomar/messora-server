import { execSync } from "node:child_process";
import { TEST_DATABASE_URL } from "./database-url.js";

/** Brings the test database schema up to date once per test run. */
export default function setup() {
  try {
    execSync("npx prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: "pipe",
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`Could not prepare the test database (is Postgres running?)\n${stderr ?? err}`, {
      cause: err,
    });
  }
}
