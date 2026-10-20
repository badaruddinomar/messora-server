import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./src/test/database-url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    setupFiles: ["src/test/setup.ts"],
    // Integration tests share one database, so test files run one at a time.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: TEST_DATABASE_URL,
      CLIENT_URL: "http://localhost:3000",
      JWT_ACCESS_SECRET: "test-secret-that-is-at-least-32-characters-long",
      MAIL_FROM_EMAIL: "test@messora.app",
      BREVO_API_KEY: "",
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_DIR: join(tmpdir(), "messora-test-uploads"),
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/test/**", "src/**/*.test.ts", "src/server.ts", "src/types/**"],
    },
  },
});
