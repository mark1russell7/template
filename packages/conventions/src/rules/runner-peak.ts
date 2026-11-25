/**
 * The rule `runner-peak`: the workflows of a repository hold at most its share of the runners in a busy minute. The peak
 * of a job is the jobs of one run (a matrix, capped by its `max-parallel`) times the runs that its concurrency group lets
 * run at one time. A burst of merges on `push` and a burst of pull requests give these runs. The peak of a workflow is
 * the sum over its jobs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import type { Rule } from "../rule.ts";
import { WORKFLOW, parseWorkflow, type ParsedConcurrency, type ParsedJob, type ParsedWorkflow } from "../workflow.ts";
import { groupParts, mayRun } from "../workflow-expression.ts";

/** The jobs of a matrix that the reader cannot count and that has no `max-parallel`: the most that the rule runner-budget lets run. */
export const UNKNOWN_MATRIX_JOBS = 3;

/** The kinds of events in a busy minute: a burst of merges (`push`), a burst of pull requests, and one run of each other event. */
export type EventClass = "push" | "pull" | "other";

const PUSH_EVENTS: ReadonlySet<string> = new Set(["push", "merge_group", "workflow_run"]);
const PULL_EVENTS: ReadonlySet<string> = new Set(["pull_request", "pull_request_target"]);

/** This function gives the class of an event, or undefined for `workflow_call`: the caller counts the jobs of a called workflow. */
export function eventClass(event: string): EventClass | undefined {
  if (event === "workflow_call") return undefined;
  return PUSH_EVENTS.has(event) ? "push" : PULL_EVENTS.has(event) ? "pull" : "other";
}

/** The facts that the peak needs. */
export interface PeakOptions {
  /** The runs of one class of `push` or of pull requests that start in a busy minute. */
  readonly burst: number;
  /** The jobs of each run of a called workflow of another repository, by its file name (`reusable-ci.yml`). */
  readonly called: Readonly<Record<string, number>>;
}

/** The peak of one job: the jobs of one run, and the runs at one time. */
export interface JobPeak {
  readonly id: string;
  readonly line: number;
  readonly jobs: number;
  readonly runs: number;
  /** False when the reader could not count the jobs: a call of an unknown workflow counts 1. */
  readonly known: boolean;
}

/** The peak of a workflow: the most jobs at one time over its events, and the event and the jobs that give it. */
export interface WorkflowPeak {
  readonly file: string;
  readonly peak: number;
  /** The peak of each class of events. The peak of the workflow is their sum. */
  readonly classes: Readonly<Partial<Record<EventClass, { readonly event: string; readonly peak: number; readonly jobs: readonly JobPeak[] }>>>;
}

/**
 * This function gives the runs of a concurrency group that run at one time on the event. A group that depends on the commit
 * or the run, or no group, gives a burst on `push` and on pull requests. A group of the branch gives one run on `push` (the
 * default branch) and a burst of pull requests. Each other event gives one run.
 */
export function runsAtOnce(concurrency: ParsedConcurrency | null, event: string, burst: number): number {
  const kind = eventClass(event);
  if (kind === undefined || kind === "other") return 1;
  if (concurrency === null) return burst;
  const parts = groupParts(concurrency.group, event);
  if (parts.has("commit") || parts.has("run")) return burst;
  return parts.has("ref") && kind === "pull" ? burst : 1;
}

/** The file name of the workflow that a job calls, and if it is a file of the same repository (`./.github/workflows/`). */
function callOf(job: ParsedJob): { readonly name: string; readonly local: boolean } | undefined {
  const marker = ".github/workflows/";
  const at = job.uses.indexOf(marker);
  if (at < 0) return undefined;
  return { name: job.uses.slice(at + marker.length), local: job.uses.startsWith("./") };
}

/** This function gives the jobs of one run of a job that calls no workflow: 1, or the jobs of its matrix that run together. */
export function matrixPeak(job: ParsedJob): number {
  if (job.lines["strategy.matrix"] === undefined) return 1;
  const limit = job.maxParallel;
  if (job.matrixJobs === null) return limit ?? UNKNOWN_MATRIX_JOBS;
  return Math.max(1, Math.min(job.matrixJobs, limit ?? job.matrixJobs));
}

/** This function gives the jobs of one run of a workflow on the event: the sum over the jobs that can run on it. */
function jobsOfRun(workflow: ParsedWorkflow, event: string, local: ReadonlyMap<string, ParsedWorkflow>, options: PeakOptions, seen: ReadonlySet<string>): { jobs: number; known: boolean } {
  let jobs = 0;
  let known = true;
  for (const job of workflow.jobs) {
    if (!mayRun(job.if, event)) continue;
    const one = jobOfRun(job, event, local, options, seen);
    jobs += one.jobs;
    known &&= one.known;
  }
  return { jobs, known };
}

/** This function gives the jobs of one run of a job: its matrix, or the jobs of the workflow that it calls. */
function jobOfRun(job: ParsedJob, event: string, local: ReadonlyMap<string, ParsedWorkflow>, options: PeakOptions, seen: ReadonlySet<string>): { jobs: number; known: boolean } {
  const call = callOf(job);
  if (call === undefined) return { jobs: matrixPeak(job), known: true };
  const file = call.local ? local.get(call.name) : undefined;
  // A called workflow gets the event of its caller. A loop of calls does not run on GitHub, and counts no job here.
  if (file !== undefined) return seen.has(call.name) ? { jobs: 0, known: true } : jobsOfRun(file, event, local, options, new Set([...seen, call.name]));
  const count = options.called[call.name];
  return count === undefined ? { jobs: 1, known: false } : { jobs: count, known: true };
}

/**
 * This function gives the peak of each workflow of a repository in a busy minute. In each class of events, it takes the
 * event with the most jobs. The peak of a job is its jobs of one run times the runs of its group (the group at the top of
 * the file, else the group of the job). The sum over the jobs is an upper bound: a job that `needs` another job does not
 * run at the same time as it.
 */
export function workflowPeaks(workflows: readonly ParsedWorkflow[], options: PeakOptions): WorkflowPeak[] {
  const local = new Map(workflows.map((workflow) => [workflow.file, workflow]));
  return workflows.flatMap((workflow) => {
    const classes: Partial<Record<EventClass, { event: string; peak: number; jobs: JobPeak[] }>> = {};
    for (const event of workflow.triggers) {
      const kind = eventClass(event);
      if (kind === undefined) continue;
      const jobs = workflow.jobs
        .filter((job) => mayRun(job.if, event))
        .map((job) => {
          const one = jobOfRun(job, event, local, options, new Set([workflow.file]));
          return { id: job.id, line: job.line, jobs: one.jobs, runs: runsAtOnce(workflow.concurrency ?? job.concurrency, event, options.burst), known: one.known };
        });
      const peak = jobs.reduce((sum, job) => sum + job.jobs * job.runs, 0);
      if (peak > (classes[kind]?.peak ?? -1)) classes[kind] = { event, peak, jobs };
    }
    const peak = Object.values(classes).reduce((sum, item) => sum + item.peak, 0);
    return Object.keys(classes).length === 0 ? [] : [{ file: workflow.file, peak, classes }];
  });
}

/** This function reads the option `called`: a list of `<file>=<jobs>`. A pair that does not parse is left out. */
export function calledJobs(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) {
    const match = /^\s*([^=\s]+)\s*=\s*(\d+)\s*$/.exec(value);
    if (match) out[match[1] ?? ""] = Number(match[2]);
  }
  return out;
}

/** This function gives the text of the peak of a workflow: `ci.yml 15 (push: 5 runs of 3 jobs)`. */
function peakText(item: WorkflowPeak): string {
  const parts = Object.entries(item.classes).map(([kind, value]) => {
    const runs = Math.max(...value.jobs.map((job) => job.runs), 0);
    const unknown = value.jobs.some((job) => !job.known) ? ", a call of an unknown workflow counts 1" : "";
    return `${kind} ${String(value.peak)} on ${value.event} (up to ${String(runs)} runs at one time${unknown})`;
  });
  return `${item.file.slice(item.file.lastIndexOf("/") + 1)} ${String(item.peak)}: ${parts.join("; ")}`;
}

/**
 * The jobs of each run of the shared workflows of the template, on the event with the most jobs. A test of the template
 * computes them from its files, so a change of a shared workflow changes this list.
 */
export const TEMPLATE_CALLED: readonly string[] = [
  "reusable-ai-review.yml=1",
  "reusable-ci.yml=7",
  "reusable-codex-review.yml=2",
  "reusable-lockfile.yml=1",
  "reusable-mutation.yml=5",
  "reusable-pages-check.yml=1",
  "reusable-pages.yml=4",
  "reusable-queue.yml=1",
  "reusable-release-build.yml=1",
  "reusable-release-tag.yml=1",
  "reusable-release-tree.yml=1",
  "reusable-security.yml=3",
];

export const runnerPeak: Rule = {
  id: "runner-peak",
  title: "The workflows of a repository hold at most its share of the runners in a busy minute.",
  reason:
    "The repositories of an account or an organization share its runners. The rule runner-budget caps each matrix and each workflow, but not the sum: a run of main has the group of its commit (the rule main-runs-finish), so a burst of merges starts a full run for each merge. On 2026-11-24, five push runs of one repository waited with 58 of the 60 jobs of its organization, and a bench of that repository waited 15.9 minutes for a runner.",
  fix: "Lower the `max-parallel` of the largest matrices, run heavy jobs only on `workflow_dispatch` or a schedule, or give a job that a run of `push` does not need an `if` that is false on `push`. Else the organization gives the repository a larger share (the option share).",
  sources: [{ repo: "private", rule: "runner-slots", doc: "a decision of 2026-10-30: the runner slots: a cap of 40, heavy work at most 28" }],
  failsFrom: "2026-12-09",
  options: {
    share: {
      type: "number",
      default: 0,
      description:
        "The most jobs that the workflows of the repository hold at one time in a busy minute. The organization gives each repository its share of the pool. 0 turns the rule off: the CI of the template alone can hold 145 jobs in a busy minute, so no one share fits each repository.",
    },
    burst: { type: "number", default: 5, description: "The runs of push, or of pull requests, that start in a busy minute when each run has its own group." },
    called: {
      type: "strings",
      default: TEMPLATE_CALLED,
      description: "The jobs of each run of a called workflow of another repository, as `<file>=<jobs>`. A call of a workflow that is not in the list counts 1.",
    },
  },
  check(context, options) {
    const share = Number(options["share"]);
    if (!(share > 0)) return { skipped: "the option share is 0" };
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const paths = files.filter((path) => WORKFLOW.test(path)).sort(byCode);
    if (paths.length === 0) return { skipped: "the repository has no workflow" };
    const workflows: ParsedWorkflow[] = [];
    for (const path of paths) {
      try {
        workflows.push(parseWorkflow(path.slice(path.lastIndexOf("/") + 1), readFileSync(join(context.root, path), "utf8")));
      } catch {
        continue;
      }
    }
    const called = calledJobs(Array.isArray(options["called"]) ? (options["called"] as readonly string[]) : []);
    const peaks = workflowPeaks(workflows, { burst: Math.max(1, Number(options["burst"])), called }).sort((a, b) => b.peak - a.peak);
    const total = peaks.reduce((sum, item) => sum + item.peak, 0);
    if (total <= share) return [];
    const top = peaks[0];
    const file = `.github/workflows/${top?.file ?? ""}`;
    return [{ file, message: `The workflows can hold ${String(total)} jobs at one time in a busy minute, and the share of the repository is ${String(share)}. ${peaks.map(peakText).join(". ")}.` }];
  },
};
