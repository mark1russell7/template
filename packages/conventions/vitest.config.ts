import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // The tests read no variable of the CI runner. The count of the process starts of each test file holds the git
    // starts of the file under its budget in src/test/git-starts.json.
    setupFiles: ["src/test/runner-env.setup.ts", "src/test/process-starts.setup.ts"],
    globalSetup: ["src/test/process-starts.global.ts"],
  },
});
