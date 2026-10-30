/**
 * The rule `tests-required`: no test runner passes when it finds no test (`passWithNoTests`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";

/** The files that set the options of a test runner: its configs, and package.json for the scripts. */
const RUNNER_FILE = /(?:^|\/)(?:(?:vitest|vite|jest|playwright)(?:\.[\w-]+)*\.config\.[cm]?[jt]s|vitest\.workspace\.[cm]?[jt]s|package\.json)$/;
/** The option in a config (`passWithNoTests: true`) or on a command line (`--passWithNoTests`, `--pass-with-no-tests`). */
const PASS_WITH_NO_TESTS = /passWithNoTests\s*:\s*true|--passWithNoTests(?!=false)|--pass-with-no-tests(?!=false)/;

export const testsRequired: Rule = {
  id: "tests-required",
  title: "No test runner passes when it finds no test: no `passWithNoTests: true` in a config, and no `--passWithNoTests` in a script.",
  reason:
    "With the option, a test step that finds 0 tests passes. A broken include pattern, a moved folder or a renamed file then turns the gate green with no test run. In the fleet audit of 2026-10-30, vex had the option in all 9 vitest configs and client in 2 packages that have tests.",
  fix: "Remove the option. A package with no tests has no test script, so the shared CI skips it. A package whose tests a later change adds keeps no test script until then.",
  sources: [{ repo: "fleet", rule: "fail-closed", doc: "docs/STRATEGY.md (2026-10-30, gates and probes fail closed)" }],
  options: {},
  check(context) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const breaks: Break[] = [];
    for (const file of files.filter((path) => RUNNER_FILE.test(path)).sort(byCode)) {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      const index = lines.findIndex((line) => PASS_WITH_NO_TESTS.test(line));
      if (index >= 0) breaks.push({ file, line: index + 1, message: `${file} lets the tests pass when they find no test (passWithNoTests).` });
    }
    return breaks;
  },
};
