/**
 * The rule `push-runs-main`: a workflow that starts on `pull_request` and on `push` starts on `push` only for main.
 * A push to the branch of a pull request starts both events, so the same work runs two times.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import { replaceLine, type Break, type Rule } from "../rule.ts";
import { WORKFLOW, childKeys, indentOf, keyValue, workflowLines } from "../workflow.ts";
import { startsOn } from "./main-runs-finish.ts";

/** The filter that limits `push` to main. */
export const MAIN_ONLY = "branches: [main]";

/** This function gives the events of a line `on: [a, b]`, or undefined for another form of `on`. */
function listedEvents(value: string): string[] | undefined {
  const list = /^\[(.*)\]$/.exec(value.trim());
  return list === null ? undefined : (list[1] ?? "").split(",").map((event) => event.trim()).filter((event) => event !== "");
}

/** This function adds `branches: [main]` under `push`. It returns undefined when `push` already has a filter of branches or tags. */
function withMainOnly(text: string, lines: readonly string[]): { readonly line: number; readonly after: string } | undefined {
  const on = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "on") !== undefined);
  if (on < 0) return undefined;
  const events = listedEvents(keyValue(lines[on] ?? "", "on") ?? "");
  if (events !== undefined) {
    const block = ["on:", ...events.flatMap((event) => (event === "push" ? ["  push:", `    ${MAIN_ONLY}`] : [`  ${event}:`]))];
    return { line: on + 1, after: replaceLine(text, on + 1, block) };
  }
  const push = childKeys(lines, on).find((index) => /^push:/.test((lines[index] ?? "").trim()));
  if (push === undefined) return undefined;
  const filters = childKeys(lines, push).map((index) => (lines[index] ?? "").trim());
  if (filters.some((filter) => /^(branches|branches-ignore|tags|tags-ignore):/.test(filter))) return undefined;
  const original = text.split(/\r?\n/)[push] ?? "";
  const pad = " ".repeat(indentOf(original) + 2);
  return { line: push + 1, after: replaceLine(text, push + 1, [original, `${pad}${MAIN_ONLY}`]) };
}

export const pushRunsMain: Rule = {
  id: "push-runs-main",
  title: "A workflow that starts on pull_request and on push starts on push only for main.",
  reason:
    "On 2026-11-04 the CI workflows of the template and of each repository had `push:` with no filter. Each push to the branch of a pull request started CI two times: in vex, 20 runs of `push` beside 19 runs of `pull_request`, at 17 and 20 runner-minutes for one commit. All repositories share the runners, so one branch took two places in the queue, and the queue held more than 340 jobs. The run of the pull request tests the merge with main, so the run of the push gives no more information.",
  fix: `Add \`${MAIN_ONLY}\` under \`push\`. For CI on a branch, open a pull request. A draft is sufficient.`,
  sources: [{ repo: "vex", rule: "ci", doc: "the runs of 2026-11-04: each branch push had a second CI run" }],
  options: {},
  check(context) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const breaks: Break[] = [];
    let both = 0;
    for (const file of files.filter((path) => WORKFLOW.test(path)).sort(byCode)) {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      const lines = workflowLines(text);
      if (!startsOn(lines, "push") || !startsOn(lines, "pull_request")) continue;
      both += 1;
      const fixed = withMainOnly(text, lines);
      if (fixed === undefined) continue;
      breaks.push({
        file,
        line: fixed.line,
        message: `${file} starts on pull_request and on each push, so a push to the branch of a pull request runs it two times.`,
        edits: [{ file, before: text, after: fixed.after }],
      });
    }
    if (both === 0) return { skipped: "no workflow starts on pull_request and on push" };
    return breaks;
  },
};
