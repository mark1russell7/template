/**
 * The rule `main-runs-finish`: a workflow that starts on `push` does not cancel a run in progress. Only the run of a pull
 * request is cancelled by a newer push.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import { replaceLine, type Break, type Rule } from "../rule.ts";
import { WORKFLOW, childKeys, indentOf, keyValue, workflowLines } from "../workflow.ts";

/** The value of `cancel-in-progress` that cancels only the run of a pull request. */
export const PULL_REQUEST_ONLY = "${{ github.event_name == 'pull_request' }}";

/** This function tells if the workflow starts on `push`: `on: push`, `on: [push, ...]` or a key `push` under `on`. */
export function startsOnPush(lines: readonly string[]): boolean {
  const on = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "on") !== undefined);
  if (on < 0) return false;
  const value = keyValue(lines[on] ?? "", "on") ?? "";
  if (value !== "") return /(^|[\s[,])push([\s\],]|$)/.test(value);
  return childKeys(lines, on).some((index) => {
    const key = (lines[index] ?? "").trim().replace(/^- /, "");
    return key === "push" || key.startsWith("push:");
  });
}

export const mainRunsFinish: Rule = {
  id: "main-runs-finish",
  title: "A workflow that starts on push does not cancel a run in progress. A newer push cancels only the run of a pull request.",
  reason:
    "On 2026-11-03 the next merge cancelled the CI run of a commit on main, so the main check of that commit had no result. A shared concurrency group also cancelled a bench run on main, and its claim had no measurement. The CI workflow of the template had `cancel-in-progress: true`, and each repository copied it.",
  fix: `Set \`cancel-in-progress: ${PULL_REQUEST_ONLY}\`. A newer run of main then waits for the older run, and GitHub keeps only the newest run that waits.`,
  sources: [
    { repo: "fleet", rule: "main-runs-finish", doc: "docs/STRATEGY.md (2026-11-03, a run of main ends)" },
    { repo: "algebra", rule: "main-check", doc: "the A2 and A5 results (2026-11-03): a cancelled main run, and a cancelled bench run" },
  ],
  options: {},
  check(context) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const workflows = files.filter((path) => WORKFLOW.test(path)).sort(byCode);
    const breaks: Break[] = [];
    let pushed = 0;
    for (const file of workflows) {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      const lines = workflowLines(text);
      if (!startsOnPush(lines)) continue;
      pushed += 1;
      lines.forEach((line, index) => {
        if (keyValue(line, "cancel-in-progress") !== "true") return;
        const original = text.split(/\r?\n/)[index] ?? line;
        const after = replaceLine(text, index + 1, [original.replace(/cancel-in-progress:\s*["']?true["']?/, () => `cancel-in-progress: ${PULL_REQUEST_ONLY}`)]);
        breaks.push({
          file,
          line: index + 1,
          message: `${file} starts on push and has \`cancel-in-progress: true\`. A newer push cancels the run of main in progress, and that commit gets no result.`,
          edits: [{ file, before: text, after }],
        });
      });
    }
    if (pushed === 0) return { skipped: "no workflow starts on push" };
    return breaks;
  },
};
