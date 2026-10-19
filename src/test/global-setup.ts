import { execSync } from "node:child_process";
import { TEST_DATABASE_URL } from "./database-url.js";

/** Brings the test database schema up to date once per test run. */
export default function setup() {
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
}
