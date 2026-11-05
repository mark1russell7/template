/**
 * The rule `pages-after-release`: a repository that publishes a package and deploys a site starts its Pages workflow
 * after each release, and each day. Without this, the Releases page is behind npm until the next push.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cronLines } from "@mark1russell7/site-pages";
import { byCode } from "../workspace.ts";
import type { Break, Rule, RuleContext } from "../rule.ts";
import { WORKFLOW, applySplices, blockEnd, childIndent, childKeys, indentOf, keyValue, workflowLines, type Splice } from "../workflow.ts";
import { listItems } from "./gate-trigger.ts";
import { PAGES_WORKFLOWS, pagesCalls } from "./pages-site.ts";
import { defaultBranch } from "./push-main-only.ts";
import { repositoryOfRemote, scheduleMinute } from "./runner-budget.ts";

/** The file of the release flow. */
const RELEASE_FILE = ".github/workflows/release.yml";

/** The hour (UTC) of a daily build that the fix adds. */
const DAILY_HOUR = 5;

/** A job that deploys a site with its own steps, and not with the Pages workflow of the template. */
const OWN_DEPLOY = /^\s*(?:-\s*)?uses:\s*["']?actions\/deploy-pages@/m;

/** This function tells if a line is the key `on` at the top of a workflow. */
const onKey = (line: string): boolean => indentOf(line) === 0 && /^["']?on["']?\s*:/.test(line);

/** This function gives the name of a workflow: its key `name` at the top of the file. */
function workflowName(text: string): string | undefined {
  for (const line of workflowLines(text)) {
    if (indentOf(line) !== 0) continue;
    const name = keyValue(line, "name");
    if (name !== undefined && name !== "") return name;
  }
  return undefined;
}

/** This function tells if a cron line starts on each day of each month. */
export function isDaily(cron: string): boolean {
  const fields = cron.split(" ").filter((field) => field !== "");
  return fields.length === 5 && fields.slice(2).every((field) => field === "*");
}

/** The two triggers that the rule needs, as the rule reads them from a workflow. */
export interface PagesTriggers {
  /** The value `true` tells that the file starts after a run of the release workflow. */
  readonly afterRelease: boolean;
  /** The value `true` tells that the file has a schedule with a start on each day. */
  readonly daily: boolean;
}

/** This function gives the index of the key `name` under the key `on`, or undefined. */
function triggerKey(lines: readonly string[], on: number, name: string): number | undefined {
  return childKeys(lines, on).find((index) => keyValue(lines[index] ?? "", name) !== undefined);
}

/** This function gives the workflows that the trigger `workflow_run` names, or undefined when the rule cannot read them. */
function runWorkflows(lines: readonly string[], on: number): { at: number; items: readonly string[] } | undefined {
  const run = triggerKey(lines, on, "workflow_run");
  if (run === undefined) return undefined;
  const at = childKeys(lines, run).find((index) => keyValue(lines[index] ?? "", "workflows") !== undefined);
  if (at === undefined) return undefined;
  const list = listItems(lines, at, keyValue(lines[at] ?? "", "workflows") ?? "");
  return list === undefined ? undefined : { at, items: list.items };
}

/** This function reads the two triggers of the text of a workflow. A form of `on` on one line has neither. */
export function pagesTriggers(text: string, release: string = "Release"): PagesTriggers {
  const lines = workflowLines(text);
  const on = lines.findIndex(onKey);
  const daily = cronLines(text).some(({ cron }) => isDaily(cron));
  if (on < 0) return { afterRelease: false, daily };
  return { afterRelease: runWorkflows(lines, on)?.items.includes(release) === true, daily };
}

/** The facts of a repository that the fix writes. */
interface FixFacts {
  readonly release: string;
  readonly branch: string;
  /** The minute of the schedules of this file, or undefined when the rule cannot find the repository. */
  readonly minute: number | undefined;
}

/** This function gives the index after the last line with text of the block of the key at `index`. */
function blockTextEnd(lines: readonly string[], index: number): number {
  let end = blockEnd(lines, index);
  while (end > index + 1 && (lines[end - 1] ?? "").trim() === "") end -= 1;
  return end;
}

/** This function gives the text with the missing triggers, or undefined when the fix cannot write them. */
export function addPagesTriggers(text: string, facts: FixFacts): string | undefined {
  const lines = workflowLines(text);
  const on = lines.findIndex(onKey);
  if (on < 0 || (keyValue(lines[on] ?? "", "on") ?? "") !== "") return undefined;
  const keys = childKeys(lines, on);
  const first = keys[0];
  if (first === undefined) return undefined;
  const pad = " ".repeat(indentOf(lines[first] ?? ""));
  const inner = `${pad}  `;
  const splices: Splice[] = [];
  const found = pagesTriggers(text, facts.release);
  if (!found.afterRelease) {
    const run = triggerKey(lines, on, "workflow_run");
    if (run === undefined) {
      const after = triggerKey(lines, on, "push") ?? keys.at(-1) ?? first;
      splices.push({
        at: blockTextEnd(lines, after),
        remove: 0,
        insert: [`${pad}# After a release, so that the Releases page has the new version`, `${pad}workflow_run:`, `${inner}workflows: [${facts.release}]`, `${inner}types: [completed]`, `${inner}branches: [${facts.branch}]`],
      });
    } else {
      const named = runWorkflows(lines, on);
      if (named === undefined) return undefined;
      const value = keyValue(lines[named.at] ?? "", "workflows") ?? "";
      if (value === "") {
        const end = blockTextEnd(lines, named.at);
        splices.push({ at: end, remove: 0, insert: [`${" ".repeat(indentOf(lines[end - 1] ?? ""))}- ${facts.release}`] });
      } else {
        const original = text.split(/\r?\n/)[named.at] ?? "";
        // The first bracket closes the list. A later one is in a comment.
        const close = original.indexOf("]");
        if (close < 0) return undefined;
        splices.push({ at: named.at, remove: 1, insert: [`${original.slice(0, close)}, ${facts.release}${original.slice(close)}`] });
      }
    }
  }
  if (!found.daily) {
    if (facts.minute === undefined) return undefined;
    const cron = `"${String(facts.minute)} ${String(DAILY_HOUR)} * * *"`;
    const schedule = triggerKey(lines, on, "schedule");
    if (schedule === undefined) {
      const at = blockTextEnd(lines, keys.at(-1) ?? first);
      splices.push({ at, remove: 0, insert: [`${pad}# Each day, in case a release fails after it publishes`, `${pad}schedule:`, `${inner}- cron: ${cron}`] });
    } else {
      const end = blockTextEnd(lines, schedule);
      const indent = childIndent(lines, schedule) ?? indentOf(lines[schedule] ?? "") + 2;
      splices.push({ at: end, remove: 0, insert: [`${" ".repeat(indent)}- cron: ${cron}`] });
    }
  }
  return applySplices(text, splices);
}

/** This function tells if the repository has a package that it publishes. */
function publishes(context: RuleContext): boolean {
  return [context.rootPackage, ...context.packages].some((info) => info.manifest["private"] !== true);
}

export const pagesAfterRelease: Rule = {
  id: "pages-after-release",
  title: "A repository with a public package and a release workflow starts its Pages workflow after a release and on each day.",
  reason:
    "A release starts no Pages run, so a Releases page is behind npm until the next push. On 2026-11-04 four sites showed an older version than npm for this reason. A release can also fail after it publishes, and then only a daily build shows the version.",
  fix: 'Add `workflow_run` with `workflows: [Release]`, `types: [completed]` and `branches: [<default branch>]` under `on`, and a daily `schedule` (CI.md, "Pages"). A workflow that deploys with its own steps also needs a condition that stops a run after a failed release.',
  sources: [
    { repo: "template", rule: "pages-after-release", doc: ".github/workflows/pages.yml (workflow_run of Release, and a schedule)" },
    { repo: "packing", rule: "pages-after-release", doc: ".github/workflows/pages.yml (workflow_run of Release, and a schedule)" },
    { repo: "ireko", rule: "pages-after-release", doc: ".github/workflows/pages.yml (workflow_run of CI and Release, and a schedule)" },
  ],
  options: {
    workflows: { type: "strings", default: PAGES_WORKFLOWS, description: "The workflows that deploy a site, without the ref after `@`." },
  },
  check(context, options) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    if (!files.includes(RELEASE_FILE) || !publishes(context)) return [];
    const read = (file: string): string => readFileSync(join(context.root, file), "utf8");
    const release = workflowName(read(RELEASE_FILE)) ?? "Release";
    const remote = context.git(["remote", "get-url", "origin"]);
    const repository = context.env["GITHUB_REPOSITORY"] ?? (remote === undefined ? undefined : repositoryOfRemote(remote));
    const breaks: Break[] = [];
    for (const file of files.filter((path) => WORKFLOW.test(path)).sort(byCode)) {
      const text = read(file);
      const calls = pagesCalls(text, options["workflows"] as readonly string[]).filter((call) => call.deploys);
      const own = calls.length === 0 && OWN_DEPLOY.test(workflowLines(text).join("\n")) && !/^\s*workflow_call\s*:/m.test(workflowLines(text).join("\n"));
      if (calls.length === 0 && !own) continue;
      const found = pagesTriggers(text, release);
      if (found.afterRelease && found.daily) continue;
      const parts = [...(found.afterRelease ? [] : [`it does not start after the workflow ${release}`]), ...(found.daily ? [] : ["it has no schedule with a start on each day"])];
      const message = `${file} deploys a site, and ${parts.join(", and ")}.`;
      const after = own ? undefined : addPagesTriggers(text, { release, branch: defaultBranch(context), minute: repository === undefined ? undefined : scheduleMinute(repository, file) });
      const ok = after !== undefined && after !== text && pagesTriggers(after, release).afterRelease && pagesTriggers(after, release).daily;
      breaks.push({
        file,
        line: 1,
        message,
        ...(ok ? { edits: [{ file, before: text, after }] } : own ? { fix: "A person must change it, because this workflow has its own steps. Add the triggers, and stop a run after a failed release with a condition on `github.event.workflow_run.conclusion`." } : {}),
      });
    }
    return breaks;
  },
};
