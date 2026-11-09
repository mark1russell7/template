// The audit of the time limits. `limit-audit.ts` has the rules, and its test does not start this file.
//
//   node scripts/limit-audit/main.ts [--repos a,b] [--hours 24] [--ci-runs 3] [--out <folder>] [--strict]
//
// For each public repository of the owner that is not archived (or each one of --repos), the script reads the runs of
// the default branch that started in the last --hours hours. It reads the jobs of each run that did not pass and each run with a second
// attempt, if the run took a minute or more, and the newest --ci-runs runs of ci.yml. Then it reads the annotations of each cancelled job of a
// minute or more and of each job coverage. It writes limit-audit.json and the summary into --out, and an annotation for each finding.
// With --strict, exit code 1 tells that a job stopped at a limit, or that the script could not read a repository: a
// no-read is never a pass. Without --strict, the audit is a report, and only a wrong command line fails (exit code 2).
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import {
  type Finding,
  type Job,
  type Run,
  annotation,
  fails,
  jobFindings,
  newestCiRuns,
  readsJob,
  readsRun,
  render,
} from "./limit-audit.ts";

const run = promisify(execFile);

/** This function gives one JSON value for each line that `gh api --paginate` writes with a `tojson` filter. */
async function lines<T>(path: string, jq: string): Promise<T[]> {
  const { stdout } = await run("gh", ["api", "--paginate", path, "--jq", jq], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/** This function starts `work` on each item, with at most `width` at the same time, and keeps the order. */
async function pool<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
  return out;
}

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: process.env["GITHUB_REPOSITORY_OWNER"] ?? "mark1russell7" },
    repos: { type: "string", default: "" },
    hours: { type: "string", default: "24" },
    "ci-runs": { type: "string", default: "3" },
    out: { type: "string", default: "limit-audit" },
    strict: { type: "boolean", default: false },
  },
});
const hours = Number(values.hours);
const ciCount = Number(values["ci-runs"]);
if (!Number.isInteger(hours) || hours < 1 || !Number.isInteger(ciCount) || ciCount < 0) {
  console.error("Usage: --hours is a whole number of 1 or more, and --ci-runs a whole number of 0 or more.");
  process.exit(2);
}
const owner = values.owner;
const since = new Date(Date.now() - hours * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");

type Repo = { name: string; default_branch: string };
const all = await lines<Repo>(
  `users/${owner}/repos?per_page=100`,
  ".[] | select((.private | not) and (.archived | not)) | {name, default_branch} | tojson",
);
const wanted = values.repos
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const repos = wanted.length > 0 ? all.filter((repo) => wanted.includes(repo.name)) : all;
const notRead: string[] = wanted.filter((name) => !repos.some((repo) => repo.name === name)).map((name) => `${name} (no public repository)`);

const findings: Finding[] = [];
let calls = 0;
const results = await pool(repos, 4, async (repo) => {
  const full = `${owner}/${repo.name}`;
  try {
    const runs = await lines<Run>(
      `repos/${full}/actions/runs?branch=${encodeURIComponent(repo.default_branch)}&created=%3E%3D${since}&per_page=100&exclude_pull_requests=true`,
      ".workflow_runs[] | select(.event != \"pull_request\") | {id, name, path, event, status, conclusion, html_url, created_at, run_attempt, run_started_at, updated_at} | tojson",
    );
    calls++;
    const ci = newestCiRuns(runs, ciCount);
    const found: Finding[] = [];
    for (const r of runs.filter((r) => readsRun(r, ci))) {
      const jobs = await lines<Job>(
        `repos/${full}/actions/runs/${r.id}/jobs?filter=all&per_page=100`,
        ".jobs[] | {id, name, conclusion, run_attempt, started_at, completed_at} | tojson",
      );
      calls++;
      for (const job of jobs.filter(readsJob)) {
        const messages = await lines<string>(`repos/${full}/check-runs/${job.id}/annotations?per_page=100`, ".[] | .message | tojson");
        calls++;
        found.push(...jobFindings(repo.name, r, job, messages));
      }
    }
    return { repo: repo.name, found, error: undefined };
  } catch (error) {
    const text = error instanceof Error ? error.message.split("\n").find((line) => line.trim() !== "") ?? error.message : String(error);
    return { repo: repo.name, found: [] as Finding[], error: text };
  }
});
for (const result of results) {
  findings.push(...result.found);
  if (result.error !== undefined) notRead.push(`${result.repo} (${result.error.slice(0, 120)})`);
}

const out = resolve(values.out);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "limit-audit.json"), `${JSON.stringify({ date: new Date().toISOString(), since, hours, repos: repos.length, calls, notRead, findings }, null, 2)}\n`);
const summary = render(findings, repos.length, notRead, hours);
writeFileSync(join(out, "summary.md"), `${summary.join("\n")}\n`);
if (process.env["GITHUB_STEP_SUMMARY"]) appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `${summary.join("\n")}\n`);
for (const finding of findings) console.log(annotation(finding));
for (const repo of notRead) console.log(`::error title=Time limit audit%3A no read::The audit could not read ${repo}.`);
console.log(summary.join("\n"));
console.log(`${calls} API reads.`);
process.exit(values.strict && (findings.some(fails) || notRead.length > 0) ? 1 : 0);
