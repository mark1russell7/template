// The rules of the audit of the time limits (.github/workflows/limit-audit.yml). `main.ts` reads the runs of the
// default branch of each repository, and this file decides what each job of those runs tells. It uses no network.
//
// A job that reaches its `timeout-minutes` gets the result "cancelled" and the annotation "The job has exceeded the
// maximum execution time of 15m0s". The job coverage of reusable-ci.yml stops its steps at a deadline before its
// limit, and it gives a warning when it takes more than 80 % of its limit. The audit finds the three cases.

/** The kind of a finding: the job reached its limit, the coverage stopped at its deadline, or the coverage is near its limit. */
export type Kind = "limit" | "deadline" | "near";

/** A finding of the audit: one job of one run, and what its annotation tells. */
export interface Finding {
  repo: string;
  workflow: string;
  job: string;
  run: number;
  attempt: number;
  url: string;
  date: string;
  kind: Kind;
  detail: string;
}

/** A run of the default branch, with the fields of the REST API that the audit uses. */
export interface Run {
  id: number;
  name: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  run_attempt: number;
  run_started_at?: string | null;
  updated_at?: string | null;
}

/** A job of a run. Its id is also the id of its check run, and the annotations are on the check run. */
export interface Job {
  id: number;
  name: string;
  conclusion: string | null;
  run_attempt: number;
  started_at?: string | null;
  completed_at?: string | null;
}

const LIMIT = /exceeded the maximum execution time of ([^\s.]+(?: minutes)?)/;
const DEADLINE = /(stopped at|did not start:) the deadline of the coverage job/;
const NEAR = /The job coverage took (\d+) min (\d+) s of its limit of (\d+) min \((\d+) %\)/;

/** This function gives the finding of one annotation, or `undefined` when the annotation is not about a time limit. */
export function classify(message: string): { kind: Kind; detail: string } | undefined {
  const limit = LIMIT.exec(message);
  if (limit) return { kind: "limit", detail: `reached its limit of ${limit[1]}` };
  if (DEADLINE.test(message)) return { kind: "deadline", detail: "stopped at the deadline of the coverage job" };
  const near = NEAR.exec(message);
  if (near) return { kind: "near", detail: `took ${near[1]} min ${near[2]} s of its limit of ${near[3]} min (${near[4]} %)` };
  return undefined;
}

/** This function tells if a job is the job coverage of reusable-ci.yml, with or without the prefix of its caller. */
export function isCoverage(name: string): boolean {
  return name === "coverage" || name.endsWith(" / coverage");
}

/**
 * The shortest time that a job can take to its limit, in milliseconds. A time limit is a whole number of minutes,
 * so a run or a job that took less than one minute did not reach a limit. Most runs that a newer push cancels are
 * shorter, so the audit does not read them.
 */
export const SHORTEST_LIMIT_MS = 60_000;

/** This function gives the time from `start` to `end` in milliseconds, or infinity when a time is not known. */
export function took(start: string | null | undefined, end: string | null | undefined): number {
  const ms = start && end ? Date.parse(end) - Date.parse(start) : Number.NaN;
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/** This function tells if the audit reads the jobs of a run. */
export function readsRun(run: Run, ciRuns: ReadonlySet<number>): boolean {
  if (run.status !== "completed") return false;
  // The job coverage passes also near its limit, so the audit reads a sample of the newest CI runs.
  if (ciRuns.has(run.id)) return true;
  // A job that reached its limit is cancelled, so its run does not pass. A run that passed at a later attempt can
  // have an attempt that reached the limit.
  return (run.conclusion !== "success" || run.run_attempt > 1) && took(run.run_started_at, run.updated_at) >= SHORTEST_LIMIT_MS;
}

/**
 * This function tells if the audit reads the annotations of a job. A job that reached its limit is always cancelled, so
 * the audit does not read a failed job. Thus a run with many failed checks costs one read of its jobs only.
 */
export function readsJob(job: Job): boolean {
  if (isCoverage(job.name)) return true;
  return job.conclusion === "cancelled" && took(job.started_at, job.completed_at) >= SHORTEST_LIMIT_MS;
}

/** This function gives the ids of the newest `count` runs of the CI workflow (`ci.yml`) in a list of runs. */
export function newestCiRuns(runs: readonly Run[], count: number): Set<number> {
  const ci = runs.filter((run) => run.path.endsWith("/ci.yml") && run.status === "completed");
  ci.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  return new Set(ci.slice(0, count).map((run) => run.id));
}

/** This function gives the findings of one job, from the messages of its annotations. A kind occurs once for each job. */
export function jobFindings(repo: string, run: Run, job: Job, messages: readonly string[]): Finding[] {
  const out: Finding[] = [];
  for (const message of messages) {
    const found = classify(message);
    if (!found || out.some((f) => f.kind === found.kind)) continue;
    out.push({
      repo,
      workflow: run.name,
      job: job.name,
      run: run.id,
      attempt: job.run_attempt,
      url: run.html_url,
      date: run.created_at,
      ...found,
    });
  }
  return out;
}

/** This function tells if a finding fails the audit: a job that stopped before its work ended. */
export function fails(finding: Finding): boolean {
  return finding.kind !== "near";
}

const cell = (text: string): string =>
  text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, " ");

/** This function gives the Markdown summary of the audit: a headline, then a table of the findings. */
export function render(findings: readonly Finding[], repos: number, notRead: readonly string[], hours: number): string[] {
  const stopped = findings.filter(fails);
  const repoCount = new Set(stopped.map((f) => f.repo)).size;
  const lines = [
    `## Time limits: ${stopped.length} jobs stopped at a limit in ${repoCount} of ${repos} repositories, ${findings.length - stopped.length} near a limit (last ${hours} hours)`,
    "",
  ];
  if (notRead.length > 0) lines.push(`**Not read:** ${notRead.map(cell).join(", ")}`, "");
  if (findings.length === 0) return [...lines, "No job of a run of a default branch reached its limit or came near it."];
  const sorted = [...findings].sort(
    (a, b) => Number(fails(b)) - Number(fails(a)) || a.repo.localeCompare(b.repo) || b.date.localeCompare(a.date),
  );
  return [
    ...lines,
    "| Repository | Workflow | Job | Finding | Run | Date |",
    "| --- | --- | --- | --- | --- | --- |",
    ...sorted.map(
      (f) =>
        `| ${cell(f.repo)} | ${cell(f.workflow)} | ${cell(f.job)} | ${fails(f) ? "**" : ""}${cell(f.detail)}${fails(f) ? "**" : ""} | [${f.run}${f.attempt > 1 ? ` (attempt ${f.attempt})` : ""}](${f.url}) | ${f.date.slice(0, 10)} |`,
    ),
  ];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** This function tells if a stop fails the audit on the day `today` (YYYY-MM-DD). An empty `failsFrom` fails at once. */
export function failsOn(failsFrom: string, today: string): boolean {
  if (failsFrom === "") return true;
  if (!DATE.test(failsFrom)) throw new Error(`"${failsFrom}" is not a date: use YYYY-MM-DD, or "" to fail at once.`);
  return today >= failsFrom;
}

/**
 * This function gives the GitHub annotation of a finding. A stop is an error from the day `failsFrom`, and a warning
 * before it. A job near its limit is always a warning.
 */
export function annotation(finding: Finding, failsFrom = "", today = ""): string {
  const failing = fails(finding) && failsOn(failsFrom, today);
  const level = failing ? "error" : "warning";
  const title = `Time limit%3A ${finding.repo}`;
  const after = fails(finding) && !failing ? ` From ${failsFrom}, a stop fails the audit.` : "";
  return `::${level} title=${title}::${finding.workflow} / ${finding.job} ${finding.detail} in run ${finding.url}.${after}`;
}

/**
 * This function gives the exit code of a strict audit. A no-read always fails it, because a no-read is never a pass.
 * A stop fails it only from the day `failsFrom`. A report (not strict) always gives 0.
 */
export function exitCode(findings: readonly Finding[], notRead: readonly string[], strict: boolean, failsFrom: string, today: string): number {
  if (!strict) return 0;
  if (notRead.length > 0) return 1;
  return findings.some(fails) && failsOn(failsFrom, today) ? 1 : 0;
}
