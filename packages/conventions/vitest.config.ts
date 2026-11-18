import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // It counts the process starts of each test file, and holds the git starts under a limit.
    setupFiles: ["src/test/process-starts.setup.ts"],
    globalSetup: ["src/test/process-starts.global.ts"],
  },
});
