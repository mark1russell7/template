/**
 * The rule `main-runs-finish`: a workflow that starts on `push` or on `workflow_call` does not cancel a run in progress.
 * Only the run of a pull request is cancelled by a newer push. Each commit of main has its own concurrency group, because
 * GitHub keeps only the newest run that waits in a group.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import { replaceLine, type Break, type Rule } from "../rule.ts";
import { WORKFLOW, childKeys, indentOf, keyValue, workflowLines } from "../workflow.ts";

/** The value of `cancel-in-progress` that cancels only the run of a pull request. */
export const PULL_REQUEST_ONLY = "${{ github.event_name == 'pull_request' }}";

/** The end of a concurrency group: a pull request has one group, and each other run has the group of its commit. */
export const OWN_GROUP = "${{ github.event_name == 'pull_request' && github.ref || github.sha }}";

/** The end of a concurrency group that one run of main can share with the next run. */
const SHARED_GROUP = "${{ github.ref }}";

/** This function tells if the workflow starts on the event: `on: <event>`, `on: [<event>, ...]` or a key `<event>` under `on`. */
export function startsOn(lines: readonly string[], event: string): boolean {
  const on = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "on") !== undefined);
  if (on < 0) return false;
  const value = keyValue(lines[on] ?? "", "on") ?? "";
  if (value !== "") return new RegExp(`(^|[\\s[,])${event}([\\s\\],]|$)`).test(value);
  return childKeys(lines, on).some((index) => {
    const key = (lines[index] ?? "").trim().replace(/^- /, "");
    return key === event || key.startsWith(`${event}:`);
  });
}

/** This function tells if the workflow starts on `push`. */
export function startsOnPush(lines: readonly string[]): boolean {
  return startsOn(lines, "push");
}

/**
 * This function tells if a run of the workflow can be a run of main. A workflow that starts on `workflow_call` gets
 * the event of its caller, and a caller can start on `push`.
 */
export function runsOnMain(lines: readonly string[]): boolean {
  return startsOnPush(lines) || startsOn(lines, "workflow_call");
}

export const mainRunsFinish: Rule = {
  id: "main-runs-finish",
  title: "A workflow that starts on push or on workflow_call does not cancel a run in progress, and each commit of main has its own concurrency group. A newer push cancels only the run of a pull request.",
  reason:
    "On 2026-11-03 the next merge cancelled the CI run of a commit on main, so the main check of that commit had no result. A shared concurrency group also cancelled a bench run on main, and its claim had no measurement. The CI workflow of the template had `cancel-in-progress: true`, and each repository copied it. A called workflow gets the event of its caller, so a `true` in a workflow that starts on `workflow_call` cancels the run of main too (packing, time-gate.yml, 2026-11-03).",
  fix: `Set \`cancel-in-progress: ${PULL_REQUEST_ONLY}\`, and end the concurrency group with \`${OWN_GROUP}\`. In one group, GitHub cancels a run that waits when a newer run comes, whatever \`cancel-in-progress\` says.`,
  sources: [
    { repo: "private", rule: "main-runs-finish", doc: "docs/STRATEGY.md (2026-11-03, a run of main ends)" },
    { repo: "client", rule: "release", doc: "the release of 0.47.0 (2026-11-03): four waiting CI runs of main were cancelled, so the version commit had no result" },
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
      if (!runsOnMain(lines)) continue;
      pushed += 1;
      lines.forEach((line, index) => {
        if (keyValue(line, "group")?.includes(SHARED_GROUP) === true) {
          const original = text.split(/\r?\n/)[index] ?? line;
          breaks.push({
            file,
            line: index + 1,
            message: `${file} starts on push or on workflow_call, and its concurrency group ends with the ref. Runs of main share the group, so a newer push cancels a run that waits, and that commit gets no result.`,
            edits: [{ file, before: text, after: replaceLine(text, index + 1, [original.replace(SHARED_GROUP, () => OWN_GROUP)]) }],
          });
          return;
        }
        if (keyValue(line, "cancel-in-progress") !== "true") return;
        const original = text.split(/\r?\n/)[index] ?? line;
        const after = replaceLine(text, index + 1, [original.replace(/cancel-in-progress:\s*["']?true["']?/, () => `cancel-in-progress: ${PULL_REQUEST_ONLY}`)]);
        breaks.push({
          file,
          line: index + 1,
          message: `${file} starts on push or on workflow_call and has \`cancel-in-progress: true\`. A newer push cancels the run of main in progress, and that commit gets no result.`,
          edits: [{ file, before: text, after }],
        });
      });
    }
    if (pushed === 0) return { skipped: "no workflow starts on push or on workflow_call" };
    return breaks;
  },
};
