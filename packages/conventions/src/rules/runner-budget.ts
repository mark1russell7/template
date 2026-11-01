/**
 * The rule `runner-budget`: the workflows share the runners of the account. Each matrix has a `max-parallel`, each
 * workflow has a concurrency group, and each schedule starts at the minute of its repository and file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";

/** A workflow file. */
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** This function removes a comment at the end of a value, and the quotes around it. */
function valueOf(raw: string): string {
  const comment = raw.indexOf(" #");
  let value = (comment >= 0 ? raw.slice(0, comment) : raw).trim();
  const quote = value.charAt(0);
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1).trim();
  return value;
}

/** This function gives the value of the key `key` on a line, or undefined when the line has another key. */
function keyValue(line: string, key: string): string | undefined {
  let text = line.trimStart();
  if (text.startsWith("- ")) text = text.slice(2).trimStart();
  if (!text.startsWith(`${key}:`)) return undefined;
  return valueOf(text.slice(key.length + 1));
}

/** This function gives the lines of the block under the line `index`: the next lines with a larger indent. */
function blockEnd(lines: readonly string[], index: number): number {
  const indent = indentOf(lines[index] ?? "");
  let end = index + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (line.trim() !== "" && indentOf(line) <= indent) break;
    end += 1;
  }
  return end;
}

/** This function gives the indent of the first key of the block under the line `index`, or undefined for an empty block. */
function childIndent(lines: readonly string[], index: number): number | undefined {
  const end = blockEnd(lines, index);
  for (let i = index + 1; i < end; i++) if ((lines[i] ?? "").trim() !== "") return indentOf(lines[i] ?? "");
  return undefined;
}

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

/** This function gives `owner/name` from a git remote URL, or undefined for a URL that is not of GitHub. */
export function repositoryOfRemote(url: string): string | undefined {
  const text = url.trim();
  for (const prefix of ["git@github.com:", "ssh://git@github.com/", "https://github.com/", "http://github.com/", "git+https://github.com/"]) {
    if (!text.startsWith(prefix)) continue;
    let rest = text.slice(prefix.length);
    if (rest.endsWith("/")) rest = rest.slice(0, -1);
    if (rest.endsWith(".git")) rest = rest.slice(0, -4);
    const parts = rest.split("/");
    return parts.length === 2 && parts.every((part) => part !== "") ? rest : undefined;
  }
  return undefined;
}

/** This function tells if a workflow is a shared workflow (`on: workflow_call`). Its caller gives the concurrency group. */
function isShared(lines: readonly string[]): boolean {
  return lines.some((line) => {
    const text = line.trimStart();
    return text.startsWith("workflow_call:") || text === "workflow_call" || text === "- workflow_call" || (text.startsWith("on:") && text.includes("workflow_call"));
  });
}

/** A job of a workflow: its name, its line (from 1), its keys with their values, and its concurrency group. */
interface Job {
  readonly name: string;
  readonly line: number;
  readonly grouped: boolean;
  /** The file name of the shared workflow that the job calls (`uses: .../.github/workflows/<name>`), if any. */
  readonly calls?: string;
}

/** This function gives the jobs of a workflow. */
function jobsOf(lines: readonly string[]): Job[] {
  const jobs = lines.findIndex((line) => indentOf(line) === 0 && line.startsWith("jobs:"));
  if (jobs < 0) return [];
  const jobIndent = childIndent(lines, jobs);
  const end = blockEnd(lines, jobs);
  const found: Job[] = [];
  for (let i = jobs + 1; i < end; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || indentOf(line) !== jobIndent) continue;
    const keyIndent = childIndent(lines, i);
    const keys = lines.slice(i + 1, blockEnd(lines, i)).filter((text) => indentOf(text) === keyIndent);
    const uses = keys.map((text) => keyValue(text, "uses")).find((value) => value !== undefined);
    const marker = ".github/workflows/";
    const at = uses === undefined ? -1 : uses.indexOf(marker);
    const calls = uses === undefined || at < 0 ? undefined : (uses.slice(at + marker.length).split("@")[0] ?? "");
    found.push({ name: line.trim().replace(/:$/, ""), line: i + 1, grouped: keys.some((text) => keyValue(text, "concurrency") !== undefined), ...(calls === undefined ? {} : { calls }) });
  }
  return found;
}

const hasTopGroup = (lines: readonly string[]): boolean => lines.some((line) => indentOf(line) === 0 && line.startsWith("concurrency:"));

/**
 * This function gives the breaks of the concurrency groups. A workflow with no group at the top needs one in each job.
 * A job that calls a shared workflow of `grouped` gets its group from the jobs of that workflow. A shared workflow gets
 * its group from its caller, but a shared workflow of `grouped` has a group in each job.
 */
function concurrencyBreaks(file: string, lines: readonly string[], grouped: readonly string[]): Break[] {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const jobs = jobsOf(lines);
  if (isShared(lines)) {
    if (!grouped.includes(name)) return [];
    return jobs.filter((job) => !job.grouped).map((job) => ({ file, line: job.line, message: `${file}: the job ${job.name} has no concurrency group, and its callers rely on it (the option grouped).` }));
  }
  if (hasTopGroup(lines)) return [];
  return jobs
    .filter((job) => !job.grouped && !(job.calls !== undefined && grouped.includes(job.calls)))
    .map((job) => ({ file, line: job.line, message: `${file}: the job ${job.name} has no concurrency group, and the workflow has none.` }));
}

/** This function gives the breaks of the matrices: each `strategy` with a `matrix` has a `max-parallel` of `limit` or less. */
function matrixBreaks(file: string, lines: readonly string[], limit: number): Break[] {
  const breaks: Break[] = [];
  lines.forEach((line, index) => {
    if (keyValue(line, "strategy") === undefined) return;
    const keyIndent = childIndent(lines, index);
    const keys = lines.slice(index + 1, blockEnd(lines, index)).filter((text) => indentOf(text) === keyIndent);
    if (!keys.some((text) => keyValue(text, "matrix") !== undefined)) return;
    const raw = keys.map((text) => keyValue(text, "max-parallel")).find((value) => value !== undefined);
    const value = raw === undefined ? Number.NaN : Number(raw);
    if (raw === undefined) breaks.push({ file, line: index + 1, message: `${file}: a matrix has no max-parallel.` });
    else if (!Number.isInteger(value) || value < 1 || value > limit) breaks.push({ file, line: index + 1, message: `${file}: a matrix has max-parallel ${raw}, and the most is ${String(limit)}.` });
  });
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
function cronBreaks(file: string, lines: readonly string[], minute: number): Break[] {
  const breaks: Break[] = [];
  lines.forEach((line, index) => {
    const value = keyValue(line, "cron");
    if (value === undefined) return;
    const fields = value.split(" ").filter((field) => field !== "");
    const wanted = minuteField(minute, startsPerHour(fields[0] ?? ""));
    if (fields[0] === wanted) return;
    const expected = [wanted, ...fields.slice(1)].join(" ");
    breaks.push({ file, line: index + 1, message: `${file}: the schedule "${value}" starts at minute ${fields[0] ?? "?"}, and the minute of this repository and file is ${String(minute)}.`, fix: `cron: "${expected}"` });
  });
  return breaks;
}

export const runnerBudget: Rule = {
  id: "runner-budget",
  title: "Each matrix has a max-parallel of 3 or less, each workflow has a concurrency group, and each schedule starts at the minute that the repository and the file give.",
  reason:
    "All repositories of the account share 40 runners, and heavy work keeps at most 28 of them. On 2026-10-30, a matrix with no max-parallel and the sync pull requests of about 20 repositories filled 39 of the 40 runners, with 88 jobs in the queue. Each repository copied the weekly scan at `23 5 * * 1`, so all scans started at the same minute. A workflow with no concurrency group starts a new run on each push, and the old runs keep their runners.",
  fix: 'Add `max-parallel: 3` (or less) under `strategy`. Add a concurrency group at the top of the workflow (`concurrency: { group: <name>-${{ github.ref }}, cancel-in-progress: true }`), or in each job. Change the minute of each `cron` to the minute that the message gives; the hour and the days stay.',
  sources: [{ repo: "fleet", rule: "runner-slots", doc: "docs/STRATEGY.md (2026-10-30, the runner slots: a cap of 40, heavy work at most 28)" }],
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
      const lines = text.split(/\r?\n/).map((line) => (line.trimStart().startsWith("#") ? "" : line));
      breaks.push(...matrixBreaks(file, lines, limit), ...concurrencyBreaks(file, lines, grouped));
      if (options["minute"] !== false) {
        const schedules = lines.some((line) => keyValue(line, "cron") !== undefined);
        if (schedules && repository === undefined) breaks.push({ file, message: `${file} has a schedule, and the rule cannot find the repository (GITHUB_REPOSITORY, or a GitHub URL of the remote origin).` });
        else if (repository !== undefined) breaks.push(...cronBreaks(file, lines, scheduleMinute(repository, file)));
      }
    }
    return breaks;
  },
};
