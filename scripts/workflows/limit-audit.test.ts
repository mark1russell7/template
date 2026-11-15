// Tests of the rules of the audit of the time limits (scripts/limit-audit/limit-audit.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Job,
  type Run,
  annotation,
  classify,
  exitCode,
  fails,
  failsOn,
  isCoverage,
  jobFindings,
  newestCiRuns,
  readsJob,
  readsRun,
  render,
} from "../limit-audit/limit-audit.ts";

const run = (over: Partial<Run> = {}): Run => ({
  id: 1,
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "push",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/o/r/actions/runs/1",
  created_at: "2026-11-09T10:00:00Z",
  run_attempt: 1,
  run_started_at: "2026-11-09T10:00:00Z",
  updated_at: "2026-11-09T10:20:00Z",
  ...over,
});

const job = (over: Partial<Job> = {}): Job => ({
  id: 7,
  name: "ci / checks (ubuntu-latest, node 26)",
  conclusion: "cancelled",
  run_attempt: 1,
  started_at: "2026-11-09T10:00:00Z",
  completed_at: "2026-11-09T10:15:00Z",
  ...over,
});

test("the annotation of a job at its limit is a stop, in both forms of the message", () => {
  // The form of 2026-11 (packing run 42645132958), and the older form
  assert.deepEqual(classify("The job has exceeded the maximum execution time of 15m0s"), { kind: "limit", detail: "reached its limit of 15m0s" });
  assert.deepEqual(classify("The job running on runner GitHub Actions 3 has exceeded the maximum execution time of 360 minutes."), {
    kind: "limit",
    detail: "reached its limit of 360 minutes",
  });
});

test("the messages of the coverage deadline and of the 80 % warning are findings", () => {
  // The messages of .github/actions/coverage/deadline.ts and of the step summary of the job coverage
  assert.equal(classify("pnpm run test:coverage stopped at the deadline of the coverage job.")?.kind, "deadline");
  assert.equal(classify("pnpm install did not start: the deadline of the coverage job is past.")?.kind, "deadline");
  const near = classify("The job coverage took 26 min 3 s of its limit of 30 min (86 %). Raise the input coverage-timeout-minutes, or make the tests faster.");
  assert.deepEqual(near, { kind: "near", detail: "took 26 min 3 s of its limit of 30 min (86 %)" });
});

test("other annotations are not findings", () => {
  for (const message of ["The operation was canceled.", "Process completed with exit code 1.", 'Write "start", not "run".']) {
    assert.equal(classify(message), undefined, message);
  }
});

test("the job coverage is found with and without the prefix of its caller", () => {
  assert.equal(isCoverage("coverage"), true);
  assert.equal(isCoverage("ci / coverage"), true);
  assert.equal(isCoverage("CI / ci / coverage"), true);
  assert.equal(isCoverage("ci / coverage-gate"), false);
  assert.equal(isCoverage("arm (active, 2)"), false);
});

test("the audit reads the jobs of a run that did not pass, a second attempt and a sampled CI run", () => {
  const none = new Set<number>();
  assert.equal(readsRun(run(), none), false);
  assert.equal(readsRun(run({ conclusion: "cancelled" }), none), true);
  assert.equal(readsRun(run({ conclusion: "failure" }), none), true);
  assert.equal(readsRun(run({ run_attempt: 2 }), none), true);
  assert.equal(readsRun(run(), new Set([1])), true);
  assert.equal(readsRun(run({ status: "in_progress", conclusion: null }), new Set([1])), false);
});

test("a run or a job of less than one minute cannot have reached a limit", () => {
  const none = new Set<number>();
  // A newer push cancels most runs before a minute
  assert.equal(readsRun(run({ conclusion: "cancelled", updated_at: "2026-11-09T10:00:40Z" }), none), false);
  assert.equal(readsRun(run({ conclusion: "cancelled", updated_at: "2026-11-09T10:01:00Z" }), none), true);
  // A time that is not known is read: a no-read is never a pass
  assert.equal(readsRun(run({ conclusion: "cancelled", run_started_at: null }), none), true);
  assert.equal(readsJob(job({ completed_at: "2026-11-09T10:00:30Z" })), false);
  assert.equal(readsJob(job({ completed_at: null })), true);
  assert.equal(readsJob(job()), true);
});

test("the audit reads a cancelled job and each job coverage, not a failed job", () => {
  // A job at its limit is always cancelled: a failed job costs no read
  assert.equal(readsJob(job({ conclusion: "failure" })), false);
  assert.equal(readsJob(job({ conclusion: "success" })), false);
  assert.equal(readsJob(job({ name: "ci / coverage", conclusion: "success", completed_at: "2026-11-09T10:00:10Z" })), true);
});

test("the sample of CI runs is the newest completed runs of ci.yml", () => {
  const runs = [
    run({ id: 1, created_at: "2026-11-09T01:00:00Z" }),
    run({ id: 2, created_at: "2026-11-09T03:00:00Z" }),
    run({ id: 3, created_at: "2026-11-09T02:00:00Z" }),
    run({ id: 4, created_at: "2026-11-09T04:00:00Z", status: "in_progress" }),
    run({ id: 5, created_at: "2026-11-09T05:00:00Z", path: ".github/workflows/pages.yml" }),
  ];
  assert.deepEqual([...newestCiRuns(runs, 2)], [2, 3]);
  assert.deepEqual([...newestCiRuns(runs, 0)], []);
});

test("a job gives one finding of each kind, and a stop fails the audit but a near limit does not", () => {
  const messages = [
    "The job has exceeded the maximum execution time of 15m0s",
    "The job has exceeded the maximum execution time of 15m0s",
    "The operation was canceled.",
  ];
  const found = jobFindings("packing", run({ id: 9, conclusion: "cancelled" }), job(), messages);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.repo, "packing");
  assert.equal(found[0]?.run, 9);
  assert.equal(fails(found[0]!), true);
  const near = jobFindings("r", run(), job({ name: "ci / coverage" }), ["The job coverage took 25 min 0 s of its limit of 30 min (83 %)."]);
  assert.equal(fails(near[0]!), false);
  assert.match(annotation(found[0]!), /^::error title=Time limit%3A packing::CI \/ ci \/ checks .* reached its limit of 15m0s in run https:/);
  assert.match(annotation(near[0]!), /^::warning /);
});

test("before the day fails-from a stop is a warning and a strict audit passes, from that day it fails", () => {
  const stop = jobFindings("packing", run({ id: 9 }), job(), ["The job has exceeded the maximum execution time of 15m0s"]);
  const near = jobFindings("r", run(), job({ name: "ci / coverage" }), ["The job coverage took 25 min 0 s of its limit of 30 min (83 %)."]);
  assert.equal(failsOn("2026-11-23", "2026-11-22"), false);
  assert.equal(failsOn("2026-11-23", "2026-11-23"), true);
  assert.equal(failsOn("2026-11-23", "2026-12-01"), true);
  assert.equal(failsOn("", "2026-11-01"), true);
  assert.throws(() => failsOn("23.11.2026", "2026-11-01"), /not a date/);
  // Before the day: a warning that names the day, and exit code 0.
  assert.match(annotation(stop[0]!, "2026-11-23", "2026-11-22"), /^::warning title=Time limit%3A packing::CI \/ ci \/ checks .* in run https:.*\. From 2026-11-23, a stop fails the audit\.$/);
  assert.equal(exitCode(stop, [], true, "2026-11-23", "2026-11-22"), 0);
  // From the day: an error with no note, and exit code 1.
  assert.match(annotation(stop[0]!, "2026-11-23", "2026-11-23"), /^::error title=Time limit%3A packing::.*\.$/);
  assert.doesNotMatch(annotation(stop[0]!, "2026-11-23", "2026-11-23"), /From 2026/);
  assert.equal(exitCode(stop, [], true, "2026-11-23", "2026-11-23"), 1);
  // A near limit never fails, a no-read always fails a strict audit, and a report never fails.
  assert.match(annotation(near[0]!, "2026-11-23", "2026-11-23"), /^::warning /);
  assert.doesNotMatch(annotation(near[0]!, "2026-11-23", "2026-11-22"), /From 2026/);
  assert.equal(exitCode(near, [], true, "2026-11-23", "2026-11-23"), 0);
  assert.equal(exitCode([], ["x (HTTP 403)"], true, "2026-11-23", "2026-11-22"), 1);
  assert.equal(exitCode(stop, ["x (HTTP 403)"], false, "", "2026-11-23"), 0);
});

test("the summary puts the stops first, names the no-reads, and escapes the cells", () => {
  const stop = jobFindings("b", run({ id: 2 }), job({ name: "a | b" }), ["The job has exceeded the maximum execution time of 15m0s"]);
  const near = jobFindings("a", run({ id: 3 }), job({ name: "ci / coverage" }), ["The job coverage took 25 min 0 s of its limit of 30 min (83 %)."]);
  const lines = render([...near, ...stop], 5, ["x (HTTP 403)"], 24);
  assert.equal(lines[0], "## Time limits: 1 jobs stopped at a limit in 1 of 5 repositories, 1 near a limit (last 24 hours)");
  assert.ok(lines.includes("**Not read:** x (HTTP 403)"));
  const rows = lines.filter((line) => line.startsWith("| ") && !line.startsWith("| Repository") && !line.startsWith("| ---"));
  assert.match(rows[0] ?? "", /^\| b \| CI \| a \\\| b \| \*\*reached its limit of 15m0s\*\* \|/);
  assert.match(rows[1] ?? "", /^\| a \| CI \| ci \/ coverage \| took 25 min/);
  assert.match(render([], 3, [], 24).at(-1) ?? "", /^No job/);
});
