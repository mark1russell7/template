// Tests of the rules of the read of the CI minutes (scripts/ci-minutes/ci-minutes.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Job,
  type JobRecord,
  type Run,
  PAGE,
  changeOf,
  isDocs,
  jobRecord,
  packageOf,
  ran,
  render,
  sampleable,
  spread,
  stepClass,
  summarize,
  took,
} from "../ci-minutes/ci-minutes.ts";

const at = (minute: number, second = 0): string => new Date(Date.UTC(2026, 10, 16, 10, minute, second)).toISOString();

const job = (over: Partial<Job> = {}): Job => ({
  name: "CI / test",
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
    [{ repo: "a", packages: 4, runs: 9, pullRequests: 3, sampled: 2 }],
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
  const summary = summarize([{ repo: "a", packages: 0, runs: 1, pullRequests: 1, sampled: 1 }], [record], []);
  const text = render(summary, 7, ["b (no public repository)"]).join("\n");
  assert.match(text, /^## CI minutes/);
  assert.match(text, /1 repositories, 1 pull-request runs of 1 pull requests in 7 days/);
  assert.match(text, /No read: b \(no public repository\)\./);
  assert.match(text, /\| Docs only: no job \| 0 \| 0 % \|/);
  assert.match(text, /\| CI \\\| test \|/);
  const empty = render(summarize([], [], []), 7, []).join("\n");
  assert.match(empty, /\| setup \| 0 \| no read \|/);
});
