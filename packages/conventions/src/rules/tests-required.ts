/**
 * The rule `tests-required`: no test runner passes when it finds no test (`passWithNoTests`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import { replaceLine, type Break, type Edit, type Rule, type RuleContext } from "../rule.ts";
import { hasTests } from "./tsconfig-test.ts";

/** The files that set the options of a test runner: its configs, and package.json for the scripts. */
const RUNNER_FILE = /(?:^|\/)(?:(?:vitest|vite|jest|playwright)(?:\.[\w-]+)*\.config\.[cm]?[jt]s|vitest\.workspace\.[cm]?[jt]s|package\.json)$/;
/** The option in a config (`passWithNoTests: true`) or on a command line (`--passWithNoTests`, `--pass-with-no-tests`). */
const PASS_WITH_NO_TESTS = /passWithNoTests\s*:\s*true|--passWithNoTests(?!=false)|--pass-with-no-tests(?!=false)/;

/** A line that holds only the option in a config. `conventions fix` removes such a line. */
const OPTION_LINE = /^\s*passWithNoTests\s*:\s*true\s*,?\s*$/;
/** The option in a line of a config with more keys. The first form has the comma after it, and the second form has the comma before it. */
const OPTION_IN_LINE = [/\bpassWithNoTests\s*:\s*true\s*,\s*/, /,?\s*\bpassWithNoTests\s*:\s*true\b/] as const;
/** The option on a command line, with the space before it. */
const FLAG = / --(?:passWithNoTests|pass-with-no-tests)(?:=true)?(?=\s|"|$)/g;

/** This function gives the folder of the package that holds `file`: the longest folder of a package that starts its path. */
function packageOf(context: RuleContext, file: string): string {
  let best = "";
  for (const info of context.packages) if (info.folder !== "" && file.startsWith(`${info.folder}/`) && info.folder.length > best.length) best = info.folder;
  return best;
}

/**
 * This function gives the edit that removes the option from one line, or no edit. The edit exists only when the package has
 * test files: then the test step still finds tests. A package with no tests needs a person, who removes its test script.
 */
function removeOption(context: RuleContext, files: readonly string[], file: string, text: string, index: number): Edit[] {
  if (!hasTests(files, packageOf(context, file))) return [];
  const line = text.split(/\r?\n/)[index] ?? "";
  if (OPTION_LINE.test(line)) return [{ file, before: text, after: replaceLine(text, index + 1, []) }];
  const form = OPTION_IN_LINE.find((pattern) => pattern.test(line));
  const without = file.endsWith("package.json") ? line.replace(FLAG, "") : form === undefined ? line : line.replace(form, "");
  return without === line ? [] : [{ file, before: text, after: replaceLine(text, index + 1, [without]) }];
}

export const testsRequired: Rule = {
  id: "tests-required",
  title: "No test runner passes when it finds no test: no `passWithNoTests: true` in a config, and no `--passWithNoTests` in a script.",
  reason:
    "With the option, a test step that finds 0 tests passes. A broken include pattern, a moved folder or a renamed file then turns the gate green with no test run. In an audit of 2026-10-30, vex had the option in all 9 vitest configs and client in 2 packages that have tests.",
  fix: "Remove the option. A package with no tests has no test script, so the shared CI skips it. A package whose tests a later change adds keeps no test script until then.",
  sources: [{ repo: "private", rule: "fail-closed", doc: "docs/STRATEGY.md (2026-10-30, gates and probes fail closed)" }],
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
      if (index >= 0) breaks.push({ file, line: index + 1, message: `${file} lets the tests pass when they find no test (passWithNoTests).`, edits: removeOption(context, files, file, text, index) });
    }
    return breaks;
  },
};
