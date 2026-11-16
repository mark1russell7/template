// The read of the CI minutes. `ci-minutes.ts` has the rules, and its test does not start this file.
//
//   node scripts/ci-minutes/main.ts [--owner o] [--repos a,b] [--days 7] [--sample 10] [--out <folder>] [--strict]
//
// For each public repository of the owner that is not archived (or each one of --repos), the script reads the
// pull-request runs that started in the last --days days (1 to 30). It reads the jobs, with their steps, of --sample
// completed runs spread over the window, and the changed files of the pull requests of those runs. For each job with a
// step that starts the input scripts of the shared CI, it reads the log of the job, and it splits that step into one
// part for each script. It writes ci-minutes.json (each record, the reads of each repository and the summary) and
// summary.md into --out. Each read of the API tries again after a transient error (scripts/lib/gh.ts).
// Before each repository it reads the rate limit of the token, and that read does not count against the limit. When
// the reads that are left are too few for one repository, the script waits for the reset if the reset comes in 65
// minutes or less, so a read of more than 1000 calls waits for the next hour of the token. Else it stops, and it names each repository that it did not read. With --strict, a repository with
// no read gives exit code 1: a no-read is never a pass. A wrong command line gives exit code 2.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { errorText, lines, page, pool, rateLimit, text } from "../lib/gh.ts";
import {
  type Group,
  type Job,
  type JobRecord,
  type PrRecord,
  type QueueRecord,
  type RepoRead,
  type Run,
  PAGE,
  changeOf,
  hasScripts,
  jobRecord,
  logGroups,
  queueRecord,
  queuedOut,
  ran,
  render,
  sampleable,
  spread,
  summarize,
} from "./ci-minutes.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: process.env["GITHUB_REPOSITORY_OWNER"] ?? "mark1russell7" },
    repos: { type: "string", default: "" },
    days: { type: "string", default: "7" },
    sample: { type: "string", default: "10" },
    out: { type: "string", default: "ci-minutes" },
    strict: { type: "boolean", default: false },
  },
});
const days = Number(values.days);
const sample = Number(values.sample);
if (!Number.isInteger(days) || days < 1 || days > 30 || !Number.isInteger(sample) || sample < 0) {
  console.error("Usage: --days is a whole number from 1 to 30, and --sample a whole number of 0 or more.");
  process.exit(2);
}
const owner = values.owner;
const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/** The reads that stay free for the other work of the token. */
const RESERVE = 100;
/** The longest wait for the reset of the rate limit. */
const WAIT_MAX_MS = 65 * 60_000;
/**
 * The log reads of each run of the sample. On 2026-11-16 the 415 runs of one read had 171 jobs with a step of the input
 * scripts, at most 9 in one run and at most 27 in one repository. A repository that reads more uses the reserve.
 */
const LOGS_PER_RUN = 3;
/**
 * The reads of one repository: 10 pages of runs, the packages, and the jobs, the files and the logs of each run of the
 * sample.
 */
const PER_REPO = 11 + (2 + LOGS_PER_RUN) * sample;

/** The read stops: the rate limit has too few reads, and its reset is not near. */
class Stop extends Error {}

let calls = 0;
let stopped: string | undefined;

/** This function waits until the token has the reads for one repository, or it throws Stop. */
async function budget(): Promise<void> {
  const limit = await rateLimit();
  if (limit.remaining >= RESERVE + PER_REPO) return;
  const wait = limit.resetMs + 5_000 - Date.now();
  if (wait > WAIT_MAX_MS) throw new Stop(`${limit.remaining} reads left, and the reset comes in ${Math.round(wait / 60_000)} minutes`);
  console.log(`${limit.remaining} reads left: the read waits ${Math.round(wait / 1000)} s for the reset.`);
  // The wait is awaited, so it keeps the process alive.
  await new Promise((done) => setTimeout(done, Math.max(0, wait)));
}

/** This function gives the first line of an error that tells the cause. */
const firstLine = (error: unknown): string => {
  const all = errorText(error);
  return all.split("\n").find((line) => line.trim() !== "" && !line.startsWith("Command failed")) ?? all;
};

/** The logs that the read could not read: the job, and the cause. The step of such a job keeps its time as one part. */
const noLog: string[] = [];

/** This function gives the groups of the log of a job, or none when the log is gone, for example after 90 days. */
async function groupsOf(full: string, job: Job): Promise<Group[]> {
  calls++;
  try {
    return logGroups(await text(`repos/${full}/actions/jobs/${job.id}/logs`));
  } catch (error) {
    noLog.push(`${full} job ${job.id} (${firstLine(error).slice(0, 120)})`);
    return [];
  }
}

type Repo = { name: string; default_branch: string };

/** This function reads one repository: its pull-request runs, its packages, and the jobs and changes of its sample. */
async function readRepo(repo: Repo): Promise<{ read: RepoRead; jobs: JobRecord[]; prs: PrRecord[]; queued: QueueRecord[] }> {
  await budget();
  const full = `${owner}/${repo.name}`;
  // Each page of the list has the count of all runs of the query, also of the runs after the 1000 runs of the list.
  const runs = await lines<Run>(
    `repos/${full}/actions/runs?event=pull_request&created=%3E%3D${since}&per_page=100`,
    ".total_count as $n | .workflow_runs[] | {id, name, event, status, conclusion, created_at, pull_requests: [.pull_requests[] | {number}], total_count: $n} | tojson",
  );
  calls += Math.max(1, Math.ceil(runs.length / 100));
  const chosen = spread(sampleable(runs), sample);
  // Only the gain of a sampled run uses the count of packages, so a repository with no sampled run costs one read.
  let packages = 0;
  if (chosen.length > 0) {
    calls++;
    try {
      packages = (
        await page<string>(
          `repos/${full}/contents/packages?ref=${encodeURIComponent(repo.default_branch)}`,
          'if type == "array" then .[] | select(.type == "dir") | .name | tojson else empty end',
        )
      ).length;
    } catch (error) {
      // A repository with one package has no folder packages.
      if (!/HTTP 404|Not Found/.test(errorText(error))) throw error;
    }
  }
  const jobs: JobRecord[] = [];
  const queued: QueueRecord[] = [];
  for (const run of chosen) {
    const list = await lines<Job>(
      `repos/${full}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
      ".jobs[] | {id, name, runner_name, conclusion, created_at, started_at, completed_at, steps: [(.steps // [])[] | {name, conclusion, started_at, completed_at}]} | tojson",
    );
    calls++;
    const pr = run.pull_requests[0]?.number ?? 0;
    for (const job of list) {
      if (ran(job)) jobs.push(jobRecord(repo.name, run.name, run.id, pr, job, hasScripts(job) ? await groupsOf(full, job) : []));
      else if (queuedOut(job)) queued.push(queueRecord(repo.name, run.name, run.id, job));
    }
  }
  const prs: PrRecord[] = [];
  for (const pr of [...new Set(chosen.map((run) => run.pull_requests[0]?.number ?? 0))].filter((n) => n > 0)) {
    const paths = await page<string>(`repos/${full}/pulls/${pr}/files?per_page=${PAGE}`, ".[] | .filename | tojson");
    calls++;
    prs.push({ repo: repo.name, pr, change: changeOf(paths) });
  }
  const pullRequests = new Set(runs.flatMap((run) => run.pull_requests.map((p) => p.number))).size;
  const count = Math.max(runs.length, runs[0]?.total_count ?? 0);
  return { read: { repo: repo.name, packages, runs: count, listed: runs.length, pullRequests, sampled: chosen.length }, jobs, prs, queued };
}

const all = await lines<Repo>(
  `users/${owner}/repos?per_page=100`,
  ".[] | select((.private | not) and (.archived | not)) | {name, default_branch} | tojson",
);
calls++;
const wanted = values.repos
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const repos = wanted.length > 0 ? all.filter((repo) => wanted.includes(repo.name)) : all;
const notRead: string[] = wanted.filter((name) => !repos.some((repo) => repo.name === name)).map((name) => `${name} (no public repository)`);

const results = await pool(repos, 2, async (repo) => {
  if (stopped !== undefined) return { repo: repo.name, error: `the read stopped: ${stopped}` };
  try {
    return { repo: repo.name, ...(await readRepo(repo)) };
  } catch (error) {
    if (error instanceof Stop) stopped = error.message;
    return { repo: repo.name, error: firstLine(error).slice(0, 160) };
  }
});

const reads: RepoRead[] = [];
const jobs: JobRecord[] = [];
const prs: PrRecord[] = [];
const queued: QueueRecord[] = [];
for (const result of results) {
  if ("error" in result) {
    notRead.push(`${result.repo} (${result.error})`);
    continue;
  }
  reads.push(result.read);
  jobs.push(...result.jobs);
  prs.push(...result.prs);
  queued.push(...result.queued);
}

const summary = summarize(reads, jobs, prs, queued);
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, "ci-minutes.json"),
  `${JSON.stringify({ date: new Date().toISOString(), owner, since, days, sample, calls, notRead, noLog, repos: reads, summary, jobs, queued, prs }, null, 2)}\n`,
);
const summaryText = render(summary, days, notRead);
if (noLog.length > 0) summaryText.push("", `The read could not read ${noLog.length} logs, so their steps stay whole: ${noLog.slice(0, 5).join(", ")}.`);
writeFileSync(join(out, "summary.md"), `${summaryText.join("\n")}\n`);
if (process.env["GITHUB_STEP_SUMMARY"]) appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `${summaryText.join("\n")}\n`);
for (const repo of notRead) console.log(`::error title=CI minutes%3A no read::The read could not read ${repo}.`);
for (const log of noLog) console.log(`::warning title=CI minutes%3A no log::The read could not read the log of ${log}.`);
console.log(summaryText.join("\n"));
console.log(`${calls} API reads.`);
process.exit(values.strict && notRead.length > 0 ? 1 : 0);
