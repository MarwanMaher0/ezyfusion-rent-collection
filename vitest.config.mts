import { config as loadDotenv } from "dotenv";
import { defineConfig } from "vitest/config";

// D21: the graders' env file is .env.local (copied from .env.example); .env is a fallback.
// Loaded here (main process) so globalSetup and every test worker inherit the same values.
loadDotenv({ path: [".env.local", ".env"], quiet: true });

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/setup/global.ts"],
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // One file at a time: every file builds its own random fixture org, but the HTTP/concurrency
    // files hammer one dev server and one Postgres; serial files keep timing-sensitive race tests
    // deterministic and keep us under GoTrue's /token rate limit burst.
    fileParallelism: false,
  },
});
