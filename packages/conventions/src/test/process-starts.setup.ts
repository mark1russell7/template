// A setup file of vitest: it counts the process starts of each test file, by command, writes the count for the report
// of `process-starts.global.ts`, and holds the count of git under a limit.
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, inject } from "vitest";
import type { FileStarts } from "./process-starts.global.ts";
import { countProcessStarts, gitStartsIn } from "./process-starts.ts";

/**
 * The most git starts of one test file. Each case that needs a repository copies the fixture of its file, so a
 * file needs only some git starts for each case that commits.
 */
export const GIT_STARTS_LIMIT: number = Number.POSITIVE_INFINITY;

const counts = countProcessStarts();

beforeAll(() => {
  counts.clear();
});

// Vitest gives the fixtures first, and the suite of the test file second.
// eslint-disable-next-line no-empty-pattern
afterAll(({}, suite) => {
  const file = relative(process.cwd(), suite.file.filepath).replace(/\\/g, "/");
  const dir = inject("processStartsDir");
  const row: FileStarts = { file, counts: Object.fromEntries(counts) };
  if (dir !== undefined) writeFileSync(join(dir, `${file.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify(row));
  const git = gitStartsIn(counts);
  if (git > GIT_STARTS_LIMIT) {
    throw new Error(`${file} started git ${git} times, over the limit of ${GIT_STARTS_LIMIT}. Make one fixture repository for the file, and copy it for each case.`);
  }
});
