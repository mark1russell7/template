/**
 * The rule `runner-budget`: the workflows share the runners of the account. Each matrix has a `max-parallel`, each
 * workflow has a concurrency group, and each schedule starts at the minute of its repository and file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cronLines } from "@mark1russell7/site-pages";
import { byCode } from "../workspace.ts";
import { repositoryOfRemote, replaceLine, type Break, type Edit, type Rule } from "../rule.ts";
import { WORKFLOW, indentOf, parseWorkflow, type ParsedJob, type ParsedWorkflow } from "../workflow.ts";

/**
 * This function gives the minute (1 to 59) of the schedules of a workflow: the FNV-1a hash of the repository and the
 * file. Two repositories with the same workflow thus start at different minutes, and no schedule starts at minute 0,
 * where GitHub has the most load.
 */
export function scheduleMinute(repository: string, file: string): number {
  let hash = 0x811c9dc5;
  for (const char of `${repository.toLowerCase()}/${file}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 59) + 1;
}

/** This function tells if a workflow is a shared workflow (`on: workflow_call`). Its caller gives the concurrency group. */
const isShared = (workflow: ParsedWorkflow): boolean => workflow.triggers.includes("workflow_call");

/** This function gives the file name of the shared workflow that a job calls (`uses: .../.github/workflows/<name>`), if any. */
function callOf(job: ParsedJob): string | undefined {
  const marker = ".github/workflows/";
  const at = job.uses.indexOf(marker);
  return at < 0 ? undefined : job.uses.slice(at + marker.length);
}

/**
 * This function gives the edit that adds a concurrency group at the top of a workflow, before `jobs:`. A new run of a pull
 * request stops the old run. A run of another event has the group of its commit, so that no release or scheduled run stops.
 */
function groupEdits(file: string, text: string, workflow: ParsedWorkflow): Edit[] {
  const jobs = workflow.lines["jobs"];
  if (jobs === undefined) return [];
  const originals = text.split(/\r?\n/);
  const first = workflow.jobs[0];
  const pad = " ".repeat(first === undefined ? 2 : indentOf(originals[first.line - 1] ?? "  ") || 2);
  const original = originals[jobs - 1] ?? "jobs:";
  const group = ["concurrency:", pad + "group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}", pad + "cancel-in-progress: ${{ github.event_name == 'pull_request' }}", "", original];
  return [{ file, before: text, after: replaceLine(text, jobs, group) }];
}

/**
 * This function gives the breaks of the concurrency groups. A workflow with no group at the top needs one in each job.
 * A job that calls a shared workflow of `grouped` gets its group from the jobs of that workflow. A shared workflow gets
 * its group from its caller, but a shared workflow of `grouped` has a group in each job.
 */
function concurrencyBreaks(file: string, text: string, workflow: ParsedWorkflow, grouped: readonly string[]): Break[] {
  const name = file.slice(file.lastIndexOf("/") + 1);
  if (isShared(workflow)) {
    if (!grouped.includes(name)) return [];
    return workflow.jobs.filter((job) => job.concurrency === null).map((job) => ({ file, line: job.line, message: `${file}: the job ${job.id} has no concurrency group, and its callers rely on it (the option grouped).` }));
  }
  if (workflow.concurrency !== null) return [];
  const missing = workflow.jobs.filter((job) => {
    const calls = callOf(job);
    return job.concurrency === null && !(calls !== undefined && grouped.includes(calls));
  });
  const edits = missing.length === 0 ? [] : groupEdits(file, text, workflow);
  return missing.map((job) => ({ file, line: job.line, message: `${file}: the job ${job.id} has no concurrency group, and the workflow has none.`, edits }));
}

/** This function gives the breaks of the matrices: each `strategy` with a `matrix` has a `max-parallel` of `limit` or less. */
function matrixBreaks(file: string, text: string, workflow: ParsedWorkflow, limit: number): Break[] {
  const breaks: Break[] = [];
  const originals = text.split(/\r?\n/);
  for (const job of workflow.jobs) {
    const strategy = job.lines["strategy"];
    const matrix = job.lines["strategy.matrix"];
    if (strategy === undefined || matrix === undefined) continue;
    const at = job.lines["strategy.max-parallel"];
    // An edit changes only a strategy in the block form, where each key has its own line.
    const block = (line: number, key: string): boolean => (originals[line - 1] ?? "").trimStart().startsWith(`${key}:`);
    const wanted = (line: number): string => `${" ".repeat(indentOf(originals[line - 1] ?? ""))}max-parallel: ${String(limit)}`;
    if (at === undefined) {
      const edits = block(matrix, "matrix") ? [{ file, before: text, after: replaceLine(text, strategy, [originals[strategy - 1] ?? "", wanted(matrix)]) }] : [];
      breaks.push({ file, line: strategy, message: `${file}: a matrix has no max-parallel.`, edits });
    } else if (job.maxParallel === null || job.maxParallel > limit) {
      const edits = block(at, "max-parallel") ? [{ file, before: text, after: replaceLine(text, at, [wanted(at)]) }] : [];
      const value = job.maxParallel === null ? "a max-parallel that is not a whole number of 1 or more" : `max-parallel ${String(job.maxParallel)}`;
      breaks.push({ file, line: strategy, message: `${file}: a matrix has ${value}, and the most is ${String(limit)}.`, edits });
    }
  }
  return breaks;
}

/**
 * This function gives the minute field of a schedule that starts `perHour` times in each hour, at equal steps. One start is at
 * `minute`: `"18"` for 1, `"18,48"` for 2. The list is in the order of the numbers.
 */
export function minuteField(minute: number, perHour: number): string {
  const step = 60 / perHour;
  return Array.from({ length: perHour }, (_, k) => (minute + k * step) % 60)
    .sort((a, b) => a - b)
    .join(",");
}

/** This function gives the number of starts in each hour of a minute field (`"*\/30"` or `"5,35"` give 2), or 1 when it cannot tell. */
function startsPerHour(field: string): number {
  const step = /^\*\/(\d+)$/.exec(field);
  const count = step ? 60 / Number(step[1]) : field.split(",").length;
  // Only a number of starts that divides the hour gives equal steps.
  return Number.isInteger(count) && count >= 1 && 60 % count === 0 ? count : 1;
}

/**
 * This function gives the breaks of the schedules: the minute of each `cron` is the minute of the repository and the file. A
 * schedule that starts more than once in each hour starts at equal steps from that minute (`18,48` for each 30 minutes).
 */
function cronBreaks(file: string, text: string, minute: number): Break[] {
  const breaks: Break[] = [];
  const originals = text.split(/\r?\n/);
  for (const { line, cron: value } of cronLines(text)) {
    const fields = value.split(" ").filter((field) => field !== "");
    const wanted = minuteField(minute, startsPerHour(fields[0] ?? ""));
    if (fields[0] === wanted) continue;
    const expected = [wanted, ...fields.slice(1)].join(" ");
    const original = originals[line - 1] ?? "";
    const edits: Edit[] = original.includes(value) ? [{ file, before: text, after: replaceLine(text, line, [original.replace(value, () => expected)]) }] : [];
    breaks.push({ file, line, message: `${file}: the schedule "${value}" starts at minute ${fields[0] ?? "?"}, and the minute of this repository and file is ${String(minute)}.`, fix: `cron: "${expected}"`, edits });
  }
  return breaks;
}

export const runnerBudget: Rule = {
  id: "runner-budget",
  title: "Each matrix has a max-parallel of 3 or less, each workflow has a concurrency group, and each schedule starts at the minute that the repository and the file give.",
  reason:
    "All repositories of the account share 40 runners, and heavy work keeps at most 28 of them. On 2026-10-30, a matrix with no max-parallel and the sync pull requests of about 20 repositories filled 39 of the 40 runners, with 88 jobs in the queue. Each repository copied the weekly scan at `23 5 * * 1`, so all scans started at the same minute. A workflow with no concurrency group starts a new run on each push, and the old runs keep their runners.",
  fix: "Add `max-parallel: 3` (or less) under `strategy`. Add a concurrency group at the top of the workflow (`concurrency: { group: <name>-${{ github.event_name == 'pull_request' && github.ref || github.sha }}, cancel-in-progress: ${{ github.event_name == 'pull_request' }} }`), or in each job. Change the minute of each `cron` to the minute that the message gives; the hour and the days stay.",
  sources: [{ repo: "private", rule: "runner-slots", doc: "a decision of 2026-10-30: the runner slots: a cap of 40, heavy work at most 28" }],
  options: {
    maxParallel: { type: "number", default: 3, description: "The largest max-parallel of a matrix." },
    minute: { type: "boolean", default: true, description: "When false, the rule does not examine the minute of the schedules." },
    grouped: {
      type: "strings",
      default: ["reusable-ai-review.yml", "reusable-codex-review.yml"],
      description: "The shared workflows that give a concurrency group in each of their jobs. A job that calls one needs no group of its own.",
    },
  },
  check(context, options) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const workflows = files.filter((path) => WORKFLOW.test(path)).sort(byCode);
    if (workflows.length === 0) return { skipped: "the repository has no workflow" };
    const remote = context.git(["remote", "get-url", "origin"]);
    const repository = context.env["GITHUB_REPOSITORY"] ?? (remote === undefined ? undefined : repositoryOfRemote(remote));
    const limit = Number(options["maxParallel"]);
    const grouped = Array.isArray(options["grouped"]) ? (options["grouped"] as readonly string[]) : [];
    const breaks: Break[] = [];
    for (const file of workflows) {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      const workflow = parseWorkflow(file.slice(file.lastIndexOf("/") + 1), text);
      breaks.push(...matrixBreaks(file, text, workflow, limit), ...concurrencyBreaks(file, text, workflow, grouped));
      if (options["minute"] !== false) {
        const schedules = cronLines(text).length > 0;
        if (schedules && repository === undefined) breaks.push({ file, message: `${file} has a schedule, and the rule cannot find the repository (GITHUB_REPOSITORY, or a GitHub URL of the remote origin).` });
        else if (repository !== undefined) breaks.push(...cronBreaks(file, text, scheduleMinute(repository, file)));
      }
    }
    return breaks;
  },
};
