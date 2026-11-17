// Tests of the rules of the read of the CI minutes (scripts/ci-minutes/ci-minutes.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Job,
  type JobRecord,
  type Run,
  PAGE,
  addStep,
  changeOf,
  hasScripts,
  isDocs,
  jobRecord,
  logGroups,
  packageOf,
  queueRecord,
  queuedOut,
  ran,
  render,
  sampleable,
  scriptOf,
  spread,
  stepClass,
  summarize,
  took,
} from "../ci-minutes/ci-minutes.ts";

const at = (minute: number, second = 0): string => new Date(Date.UTC(2026, 10, 16, 10, minute, second)).toISOString();

const job = (over: Partial<Job> = {}): Job => ({
  id: 11,
  name: "CI / test",
  runner_name: "GitHub Actions 1000001",
  conclusion: "success",
  created_at: at(0),
  started_at: at(1),
  completed_at: at(3),
  steps: [],
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  id: 1,
  name: "CI",
  event: "pull_request",
  status: "completed",
  conclusion: "success",
  created_at: at(0),
  pull_requests: [{ number: 7 }],
  ...over,
});

test("took gives 0 for a time that is not known or an end before the start", () => {
  assert.equal(took(null, at(1)), 0);
  assert.equal(took(at(1), undefined), 0);
  assert.equal(took(at(2), at(1)), 0);
  assert.equal(took(at(1), at(2, 30)), 90_000);
});

test("stepClass gives the class of the first rule that matches", () => {
  const cases: [string, string][] = [
    ["Set up job", "setup"],
    ["Complete job", "setup"],
    ["Post Run actions/checkout@3d3c42e5", "setup"],
    ["Run actions/checkout@3d3c42e5", "setup"],
    ["Run actions/setup-node@949feb24", "setup"],
    ["Run pnpm/action-setup@73e46992", "setup"],
    ["Run actions/upload-artifact@cf430e03", "setup"],
    ["Upload coverage", "setup"],
    ["Install pnpm", "install"],
    ["Run pnpm install --frozen-lockfile", "install"],
    ["Run ./.github/actions/setup-playwright", "install"],
    ["Run pnpm test", "test"],
    ["Run pnpm exec vitest run", "test"],
    ["Run ./.github/actions/coverage", "test"],
    ["Build and test", "test"],
    ["Run pnpm build", "build"],
    ["Run pnpm typecheck", "check"],
    ["Run pnpm lint:ste", "check"],
    ["Run pnpm run check:conventions", "check"],
    ["Run ./.github/actions/security-scan", "check"],
    ["Run ./.github/actions/gate-summary", "other"],
    ["Run ./.github/actions/changes", "other"],
  ];
  assert.deepEqual(
    cases.map(([name]) => [name, stepClass(name)]),
    cases,
  );
});

test("ran is false for a skipped job and for a job with no start or no end", () => {
  assert.equal(ran(job()), true);
  assert.equal(ran(job({ conclusion: "skipped" })), false);
  assert.equal(ran(job({ started_at: null })), false);
  assert.equal(ran(job({ completed_at: null })), false);
});

test("ran is false and queuedOut is true for a job that waited in the queue until its run was cancelled", () => {
  // The API gives such a job a start and an end, but no runner and no steps. On 2026-11-16 one read counted 46 of them.
  const waited = job({ conclusion: "cancelled", runner_name: null, steps: [], created_at: at(0), started_at: at(0, 1), completed_at: at(7) });
  assert.equal(ran(waited), false);
  assert.equal(queuedOut(waited), true);
  assert.deepEqual(queueRecord("r", "CI", 5, waited), { repo: "r", workflow: "CI", run: 5, job: "CI / test", waitMs: 7 * 60_000 });
  // A job that a runner took and that was cancelled ran.
  assert.equal(ran(job({ conclusion: "cancelled" })), true);
  assert.equal(queuedOut(job({ conclusion: "cancelled" })), false);
  // A job with steps ran, also when the API gives no name of its runner.
  const stepped = job({ runner_name: "", steps: [{ name: "Set up job", conclusion: "success", started_at: at(1), completed_at: at(1, 2) }] });
  assert.equal(ran(stepped), true);
  assert.equal(ran(job({ runner_name: null, steps: [] })), false);
});

/** A line of the log of a job at this time of the fixture day, as GitHub writes it, with a time in parts of a second. */
const logLine = (minute: number, second: number, text: string): string => `${at(minute, second).replace(/\.000Z$/, ".1234567Z")} ${text}`;

test("logGroups gives each group with an end, and a group in the output of a script takes the place of the group of the script", () => {
  const log = [
    `﻿${logLine(1, 0, "##[group]Run set +e")}`,
    logLine(1, 0, "set +e"),
    logLine(1, 0, "##[endgroup]"),
    logLine(1, 1, "##[group]pnpm run typecheck\r"),
    logLine(1, 2, "> tsc -b"),
    logLine(1, 31, "##[endgroup]"),
    logLine(1, 32, "##[group]pnpm run test"),
    logLine(2, 0, "##[group]a group of vitest"),
    logLine(3, 0, "##[endgroup]"),
    logLine(4, 0, "##[endgroup]"),
    "not a line of a group",
    logLine(4, 1, "##[group]pnpm run lint"),
  ].join("\n");
  assert.deepEqual(
    logGroups(log).map((g) => [g.title, g.endMs - g.startMs]),
    [
      ["Run set +e", 0],
      ["pnpm run typecheck", 30_000],
      ["a group of vitest", 60_000],
    ],
  );
  assert.deepEqual(logGroups(""), []);
});

test("scriptOf gives the script of a group of the shared CI, and nothing for each other group", () => {
  assert.equal(scriptOf("pnpm run test"), "test");
  assert.equal(scriptOf("pnpm run check:conventions"), "check:conventions");
  assert.equal(scriptOf("pnpm -r --if-present run build"), "build");
  assert.equal(scriptOf("Run set +e"), undefined);
  assert.equal(scriptOf("Run pnpm run test"), undefined);
  assert.equal(scriptOf("pnpm run test && rm -rf x"), undefined);
});

test("jobRecord splits a step of the input scripts into one part for each script in its time", () => {
  const scripts = job({
    started_at: at(1),
    completed_at: at(8),
    steps: [
      { name: "Run pnpm install --frozen-lockfile", conclusion: "success", started_at: at(1), completed_at: at(2) },
      { name: "Scripts", conclusion: "success", started_at: at(2), completed_at: at(8) },
    ],
  });
  assert.equal(hasScripts(scripts), true);
  assert.equal(hasScripts(job()), false);
  const log = [
    logLine(1, 10, "##[group]pnpm run build"),
    logLine(1, 50, "##[endgroup]"),
    logLine(2, 0, "##[group]pnpm run typecheck"),
    logLine(2, 30, "##[endgroup]"),
    logLine(2, 31, "##[group]pnpm run test"),
    logLine(7, 31, "##[endgroup]"),
    logLine(7, 32, "##[group]pnpm run lint:ste"),
    logLine(7, 50, "##[endgroup]"),
  ].join("\n");
  const record = jobRecord("r", "CI", 1, 7, scripts, logGroups(log));
  // The group of the build starts in the step of the install, so it is not a part of the step Scripts.
  assert.equal(record.steps[0]?.parts, undefined);
  assert.deepEqual(record.steps[1]?.parts, [
    { script: "typecheck", cls: "check", ms: 30_000 },
    { script: "test", cls: "test", ms: 300_000 },
    { script: "lint:ste", cls: "check", ms: 18_000 },
  ]);
  const summary = summarize([{ repo: "r", packages: 0, runs: 1, listed: 1, pullRequests: 1, sampled: 1 }], [record], []);
  // The 6 minutes of the step Scripts: 48 s of check, 5 minutes of test, and the rest (12 s) in its own class, other.
  assert.equal(summary.classMs.test, 300_000);
  assert.equal(summary.classMs.check, 48_000);
  assert.equal(summary.classMs.other, 12_000);
  assert.equal(summary.classMs.install, 60_000);
  assert.deepEqual(summary.scriptSteps, { steps: 1, split: 1 });
  assert.deepEqual(
    summary.byScript.map((s) => [s.script, s.cls, s.count, s.ms]),
    [
      ["test", "test", 1, 300_000],
      ["typecheck", "check", 1, 30_000],
      ["lint:ste", "check", 1, 18_000],
    ],
  );
  const text = render(summary, 7, []).join("\n");
  assert.match(text, /The log split 1 of 1 steps that start the input scripts/);
  assert.match(text, /\| `test` \| test \| 1 \| 5 \|/);
  // With no log, the step stays whole.
  assert.equal(jobRecord("r", "CI", 1, 7, scripts).steps[1]?.parts, undefined);
});

test("addStep gives the parts the time of the step in their ratio when they take more time than the step", () => {
  const into = { setup: 0, install: 0, build: 0, test: 0, check: 0, other: 0 };
  addStep(into, {
    name: "Scripts",
    cls: "other",
    ms: 60_000,
    parts: [
      { script: "test", cls: "test", ms: 60_000 },
      { script: "lint", cls: "check", ms: 20_000 },
    ],
  });
  assert.deepEqual(into, { setup: 0, install: 0, build: 0, test: 45_000, check: 15_000, other: 0 });
});

test("summarize counts the jobs that waited until their run was cancelled, and render tells their wait", () => {
  const waited = job({ conclusion: "cancelled", runner_name: null, steps: [], created_at: at(0), completed_at: at(12) });
  const summary = summarize([], [], [], [queueRecord("r", "CI", 1, waited), queueRecord("r", "CI", 2, waited)]);
  assert.deepEqual(summary.queuedOut, { jobs: 2, waitMs: 24 * 60_000 });
  assert.equal(summary.minutes, 0);
  assert.match(render(summary, 7, []).join("\n"), /2 more jobs waited 24 minutes in all, until their run was cancelled\./);
});

test("jobRecord rounds the minutes of a job up, with at least 1, and gives the class of each step", () => {
  const record = jobRecord(
    "r",
    "CI",
    1,
    7,
    job({
      started_at: at(1),
      completed_at: at(2, 1),
      steps: [
        { name: "Run pnpm install --frozen-lockfile", conclusion: "success", started_at: at(1), completed_at: at(1, 20) },
        { name: "Run pnpm test", conclusion: "success", started_at: at(1, 20), completed_at: at(2) },
      ],
    }),
  );
  assert.equal(record.minutes, 2);
  assert.equal(record.queueMs, 60_000);
  assert.deepEqual(
    record.steps.map((step) => [step.cls, step.ms]),
    [
      ["install", 20_000],
      ["test", 40_000],
    ],
  );
  assert.equal(jobRecord("r", "CI", 1, 7, job({ started_at: at(1), completed_at: at(1) })).minutes, 1);
});

test("isDocs and packageOf tell the documents and the package folders", () => {
  assert.equal(isDocs("README.md"), true);
  assert.equal(isDocs("docs/ROADMAP.md"), true);
  assert.equal(isDocs("packages/a/docs/x.svg"), true);
  assert.equal(isDocs(".changeset/x.md"), true);
  assert.equal(isDocs("packages/a/LICENSE"), true);
  assert.equal(isDocs("packages/a/test/fixtures/words.txt"), false);
  assert.equal(isDocs("test/api/public-api.txt"), false);
  assert.equal(packageOf("packages/a/src/x.ts"), "packages/a");
  assert.equal(packageOf("apps/web/index.html"), "apps/web");
  assert.equal(packageOf("scripts/x.ts"), undefined);
});

test("changeOf gives the first kind that applies", () => {
  assert.equal(changeOf(["README.md", "docs/x.md"]).kind, "docs-only");
  const pkg = changeOf(["packages/a/src/x.ts", "packages/b/README.md"]);
  assert.equal(pkg.kind, "packages");
  assert.deepEqual(pkg.packages, ["packages/a"]);
  const lock = changeOf(["pnpm-lock.yaml", "package.json"]);
  assert.equal(lock.kind, "lockfile");
  assert.equal(lock.root, true);
  assert.equal(changeOf([".github/workflows/ci.yml", "packages/a/x.ts"]).kind, "workflow");
  assert.equal(changeOf(["tsconfig.json"]).kind, "root");
  assert.equal(changeOf(["cue.mod/module.cue"]).kind, "root");
  assert.equal(changeOf(["scripts/x.ts"]).kind, "other");
  assert.equal(changeOf(["packages/a/x.ts", "scripts/y.ts"]).kind, "other");
  assert.equal(changeOf([]).kind, "other");
});

test("changeOf gives large for a full page, also when the page has only documents", () => {
  const docs = Array.from({ length: PAGE }, (_, i) => `docs/${i}.md`);
  assert.equal(changeOf(docs).kind, "large");
  assert.equal(changeOf(docs.slice(1)).kind, "docs-only");
});

test("spread takes items with the same step, and all items of a short list", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual(spread(items, 3), [0, 3, 6]);
  assert.deepEqual(spread(items, 10), items);
  assert.deepEqual(spread(items, 20), items);
  assert.deepEqual(spread(items, 0), []);
});

test("sampleable keeps only the completed pull-request runs that name a pull request", () => {
  const runs = [run({ id: 1 }), run({ id: 2, status: "in_progress" }), run({ id: 3, event: "push" }), run({ id: 4, pull_requests: [] })];
  assert.deepEqual(
    sampleable(runs).map((r) => r.id),
    [1],
  );
});

test("summarize sums the classes, the kinds and the gain of each part of a selector", () => {
  const minutes = (n: number): string => at(n);
  const testJob = (name: string, pr: number, testMin: number, queueMin = 0): JobRecord =>
    jobRecord(
      "a",
      "CI",
      pr,
      pr,
      job({
        name,
        created_at: at(0),
        started_at: minutes(queueMin),
        completed_at: minutes(queueMin + testMin),
        steps: [{ name: "Run pnpm test", conclusion: "success", started_at: minutes(queueMin), completed_at: minutes(queueMin + testMin) }],
      }),
    );
  const jobs = [testJob("CI / test", 1, 4, 6), testJob("CI / test", 1, 4), testJob("CI / docs", 2, 2)];
  const summary = summarize(
    [{ repo: "a", packages: 4, runs: 9, listed: 9, pullRequests: 3, sampled: 2 }],
    jobs,
    [
      { repo: "a", pr: 1, change: changeOf(["packages/x/src/a.ts"]) },
      { repo: "a", pr: 2, change: changeOf(["README.md"]) },
    ],
  );
  assert.equal(summary.minutes, 10);
  assert.equal(summary.classMs.test, 10 * 60_000);
  assert.equal(summary.queuedLong, 1);
  assert.equal(summary.gain.docsOnly, 2);
  // The 8 test minutes of the "packages" pull request, times the 3 of 4 packages that it does not touch.
  assert.equal(summary.gain.packageTests, 6);
  assert.deepEqual(
    summary.byJob.map((j) => [j.job, j.count, j.minutes]),
    [
      ["CI / test", 2, 8],
      ["CI / docs", 1, 2],
    ],
  );
  assert.deepEqual(
    summary.byKind.map((k) => [k.kind, k.pullRequests, k.jobs, k.minutes]),
    [
      ["packages", 1, 2, 8],
      ["docs-only", 1, 1, 2],
    ],
  );
});

test("render gives the headline, the no-reads, the gain and an escaped job name", () => {
  const record = jobRecord("a", "CI", 1, 1, job({ name: "CI | test" }));
  const summary = summarize([{ repo: "a", packages: 0, runs: 1, listed: 1, pullRequests: 1, sampled: 1 }], [record], []);
  const text = render(summary, 7, ["b (no public repository)"]).join("\n");
  assert.match(text, /^## CI minutes/);
  assert.match(text, /1 repositories, 1 pull-request runs in 7 days\. The list of the API gave 1 of them, of 1 pull requests\./);
  assert.doesNotMatch(text, /until their run was cancelled/);
  assert.doesNotMatch(text, /\| Script \(top/);
  assert.match(text, /No read: b \(no public repository\)\./);
  assert.match(text, /\| Docs only: no job \| 0 \| 0 % \|/);
  assert.match(text, /\| CI \\\| test \|/);
  const empty = render(summarize([], [], []), 7, []).join("\n");
  assert.match(empty, /\| setup \| 0 \| no read \|/);
});
