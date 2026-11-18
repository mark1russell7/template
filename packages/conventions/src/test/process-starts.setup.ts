// A setup file of vitest: it counts the process starts of each test file, by command, writes the count for the report
// of `process-starts.global.ts`, and holds the count of git under the budget of the file in `git-starts.json`. When each
// test of the file passed, a budget well above the count also fails, so each gain stays held.
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, inject } from "vitest";
import { countProcessStarts, type FileStarts, parseStartBudgets, ranInFull, startBudgetBreak } from "@mark1russell7/rigor-testkit/process-starts";

/** The root of the package, so that a key of `git-starts.json` is the same from each working folder. */
const ROOT = join(import.meta.dirname, "..", "..");
const SOURCE = "src/test/git-starts.json";
const BUDGETS = parseStartBudgets(readFileSync(join(import.meta.dirname, "git-starts.json"), "utf8"), SOURCE);
const ADVICE =
  "Share the fixture repositories of @mark1russell7/rigor-testkit/git-fixture: stageAll, commitAll and shared. " +
  "Raise the budget only for the git starts of the code under test.";

const counts = countProcessStarts();

beforeAll(() => {
  counts.clear();
});

// Vitest gives the fixtures first, and the suite of the test file second.
// eslint-disable-next-line no-empty-pattern
afterAll(({}, suite) => {
  const file = relative(ROOT, suite.file.filepath).replace(/\\/g, "/");
  const dir = inject("processStartsDir");
  const row: FileStarts = { file, counts: Object.fromEntries(counts) };
  if (dir !== undefined) writeFileSync(join(dir, `${file.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify(row));
  const message = startBudgetBreak(file, counts, BUDGETS, { source: SOURCE, advice: ADVICE, inFull: ranInFull(suite.tasks) });
  if (message !== undefined) throw new Error(message);
});
