// Tests of the verified tree (scripts/workflows/verified-tree.ts, CI.md "A tree that passed CI"). Start them with
// "pnpm test:workflows". The API is a fake, so the tests use no network and do not wait.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type Api,
  type ApiResponse,
  type Facts,
  type Fetch,
  type Reason,
  type Verdict,
  DEFAULT_JOBS,
  REASONS,
  decide,
  githubApi,
  main,
  outputText,
  readInput,
  readList,
  summaryLine,
  timeOf,
  verify,
} from "./verified-tree.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = "owner/repo";
/** The commit of the release, its parent, the head of its pull request, and their tree. */
const C = "c".repeat(40);
const P = "a".repeat(40);
const H = "b".repeat(40);
const TREE = "d".repeat(40);
const RUN = 7001;
const PULL = 5;
const GATE = "CI OK";
/** The time that GitHub made the run, and the time of the merge, one hour later. */
const MADE = "2026-11-16T09:00:00Z";
const MERGED = "2026-11-16T10:00:00Z";

type Kind = "repo" | "commit" | "pulls" | "head-pulls" | "head" | "compare" | "runs" | "timeline" | "jobs";
const KINDS: readonly Kind[] = ["commit", "pulls", "repo", "head-pulls", "head", "compare", "runs", "timeline", "jobs"];

/** The answers of the fake API. Each test changes the fields that it needs. */
interface World {
  repo: unknown;
  commit: unknown;
  pulls: unknown[];
  /** The head branch. The fake gives `headPulls` only for a query of this branch. */
  branch: string;
  headPulls: unknown[];
  head: unknown;
  compare: unknown;
  runs: unknown[];
  timeline: unknown[];
  jobs: unknown[];
  /** The HTTP status of each kind of call that fails. */
  fail: Partial<Record<Kind, number>>;
  /** A total_count that is not the length of the list. */
  totals: Partial<Record<"runs" | "jobs", number>>;
}

type Json = Record<string, unknown>;

const commitBody = (sha: string, over: Json = {}): Json => ({ sha, commit: { tree: { sha: TREE }, message: "a change" }, parents: [{ sha: P }], ...over });
const baseOf = (over: Json = {}): Json => ({ ref: "main", sha: P, repo: { full_name: repo }, ...over });
const headOf = (over: Json = {}): Json => ({ ref: "feature", sha: H, repo: { full_name: repo }, ...over });
const pullBody = (over: Json = {}): Json => ({ number: PULL, title: "feat: a change", state: "closed", merged_at: MERGED, merge_commit_sha: C, base: baseOf(), head: headOf(), ...over });
const runBody = (over: Json = {}): Json => ({
  id: RUN,
  run_number: 10,
  run_attempt: 1,
  path: ".github/workflows/ci.yml",
  event: "pull_request",
  head_sha: H,
  head_branch: "feature",
  head_repository: { full_name: repo },
  created_at: MADE,
  run_started_at: MADE,
  status: "completed",
  conclusion: "success",
  ...over,
});
/** A base change in the timeline of the pull request. */
const baseChange = (event: string, created_at: unknown): Json => ({ id: 1, event, created_at, commit_id: null });
const jobBody = (name: string, over: Json = {}): Json => ({ id: 1, run_id: RUN, name, status: "completed", conclusion: "success", ...over });

/** A repository where each rule holds: a squash merge of a head that has the parent, and a gate that passed. */
function world(): World {
  return {
    repo: { full_name: repo, default_branch: "main" },
    commit: commitBody(C),
    pulls: [pullBody()],
    branch: "feature",
    headPulls: [pullBody()],
    head: commitBody(H),
    compare: { status: "ahead", ahead_by: 1, behind_by: 0, merge_base_commit: { sha: P } },
    runs: [runBody()],
    // The shapes of a live timeline: a committed item has no created_at, and a review has submitted_at
    timeline: [
      { event: "committed", sha: H, message: "a change", parents: [{ sha: P }] },
      { event: "labeled", created_at: "2026-11-16T08:30:00Z", label: { name: "ci" } },
      { event: "reviewed", state: "approved", submitted_at: "2026-11-16T09:30:00Z" },
      { event: "automatic_base_change_failed", created_at: "2026-11-16T09:40:00Z" },
      { event: "merged", created_at: MERGED, commit_id: C },
      { event: "closed", created_at: MERGED },
      { event: "head_ref_deleted", created_at: "2026-11-16T10:00:03Z" },
    ],
    jobs: [jobBody("ci / checks (ubuntu-latest, node 26)"), jobBody("presets (node)", { conclusion: "skipped" }), jobBody(GATE)],
    fail: {},
    totals: {},
  };
}

/** This function gives the kind of a call from its path, or null for a path that the fake does not know. */
function kindOf(pathname: string): Kind | null {
  const base = `repos/${repo}`;
  if (pathname === base) return "repo";
  if (pathname === `${base}/commits/${C}`) return "commit";
  if (pathname === `${base}/commits/${C}/pulls`) return "pulls";
  if (pathname === `${base}/pulls`) return "head-pulls";
  if (pathname === `${base}/commits/${H}`) return "head";
  if (pathname === `${base}/compare/${P}...${H}`) return "compare";
  if (pathname === `${base}/actions/workflows/ci.yml/runs`) return "runs";
  if (pathname === `${base}/issues/${String(PULL)}/timeline`) return "timeline";
  if (new RegExp(`^${base}/actions/runs/\\d+/jobs$`).test(pathname)) return "jobs";
  return null;
}

/** This function gives the answer of the fake API to a GET, with the pages of a list. */
function answer(w: World, path: string): ApiResponse {
  const [pathname = "", query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  const kind = kindOf(pathname);
  if (kind === null) return { status: 404, body: { message: "Not Found" } };
  const failure = w.fail[kind];
  if (failure !== undefined) return { status: failure, body: { message: failure === 404 ? "Not Found" : "Server Error" } };
  const page = (items: readonly unknown[]): unknown[] => {
    const number = Number(params.get("page") ?? "1");
    const size = Number(params.get("per_page") ?? "30");
    return items.slice((number - 1) * size, number * size);
  };
  const ok = (body: unknown): ApiResponse => ({ status: 200, body });
  switch (kind) {
    case "repo":
      return ok(w.repo);
    case "commit":
      return ok(w.commit);
    case "pulls":
      return ok(page(w.pulls));
    case "head-pulls":
      // Like the API, a query of a different branch gives an empty list, not an error
      return ok(params.get("state") === "all" && params.get("head") === `owner:${w.branch}` ? page(w.headPulls) : []);
    case "head":
      return ok(w.head);
    case "compare":
      return ok(w.compare);
    case "runs":
      return ok({ total_count: w.totals.runs ?? w.runs.length, workflow_runs: page(w.runs) });
    case "timeline":
      return ok(page(w.timeline));
    case "jobs":
      return ok({ total_count: w.totals.jobs ?? w.jobs.length, jobs: page(w.jobs) });
  }
}

/** A fake API on a world, with a record of each path that it got. */
function fakeApi(w: World): Api & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(path) {
      calls.push(path);
      return answer(w, path);
    },
  };
}

/** A fake fetch on a world, with a record of each request, for the tests of the step. */
function fakeFetch(w: World): { fetcher: Fetch; requests: { url: string; method: string; headers: Record<string, string> }[] } {
  const requests: { url: string; method: string; headers: Record<string, string> }[] = [];
  const prefix = "https://api.example/";
  const fetcher: Fetch = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers });
    const response = url.startsWith(prefix) ? answer(w, url.slice(prefix.length)) : { status: 404, body: null };
    return { status: response.status, text: async () => (response.body === null ? "" : JSON.stringify(response.body)) };
  };
  return { fetcher, requests };
}

/** The inputs of a run on the commit C, with fields that the test changes. */
const input = (over: Partial<Facts> = {}): Facts => ({ repository: repo, sha: C, workflow: "ci.yml", required: DEFAULT_JOBS, ...over });

/** This function changes a world, verifies, and gives the verdict. */
async function verdictOf(change: (w: World) => void, over: Partial<Facts> = {}): Promise<Verdict> {
  const w = world();
  change(w);
  return verify(fakeApi(w), input(over));
}

describe("verified tree: the rules", () => {
  it("gives yes when each rule holds, and reads each fact one time, in the order of the rules", async () => {
    const w = world();
    const api = fakeApi(w);
    assert.deepEqual(await verify(api, input()), { verified: true, reason: "passed", head: H, run: RUN });
    assert.deepEqual(api.calls, [
      `repos/${repo}/commits/${C}`,
      `repos/${repo}/commits/${C}/pulls?per_page=100&page=1`,
      `repos/${repo}`,
      `repos/${repo}/pulls?state=all&head=owner:feature&per_page=100&page=1`,
      `repos/${repo}/commits/${H}`,
      `repos/${repo}/compare/${P}...${H}?per_page=1`,
      `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${H}&event=pull_request&per_page=100&page=1`,
      `repos/${repo}/issues/${String(PULL)}/timeline?per_page=100&page=1`,
      `repos/${repo}/actions/runs/${String(RUN)}/jobs?filter=latest&per_page=100&page=1`,
    ]);
  });

  it("puts a head branch with special characters into the URL through encodeURIComponent only", async () => {
    const w = world();
    w.branch = "feat/a b&head=x";
    w.pulls = [pullBody({ head: headOf({ ref: w.branch }) })];
    w.headPulls = [pullBody({ head: headOf({ ref: w.branch }) })];
    w.runs = [runBody({ head_branch: w.branch })];
    const api = fakeApi(w);
    assert.deepEqual(await verify(api, input()), { verified: true, reason: "passed", head: H, run: RUN });
    assert.ok(api.calls.includes(`repos/${repo}/pulls?state=all&head=owner:feat%2Fa%20b%26head%3Dx&per_page=100&page=1`));
  });

  const yes: { readonly name: string; readonly change: (w: World) => void; readonly over?: Partial<Facts> }[] = [
    { name: "an open pull request of the same commit next to the merged one", change: (w) => void w.pulls.push(pullBody({ number: 6, state: "open", merged_at: null, merge_commit_sha: "9".repeat(40) })) },
    { name: "an older run that failed before the newest run that passed", change: (w) => void w.runs.unshift(runBody({ id: 7000, run_number: 9, conclusion: "failure" })) },
    { name: "a path of the run with the ref of a called file", change: (w) => (w.runs = [runBody({ path: ".github/workflows/ci.yml@refs/heads/main" })]) },
    { name: "a list of required jobs that each passed", change: () => undefined, over: { required: [GATE, "ci / checks (ubuntu-latest, node 26)"] } },
    { name: "an older run from a fork that failed", change: (w) => void w.runs.push(runBody({ id: 6999, run_number: 8, head_repository: { full_name: "someone/repo" }, conclusion: "failure" })) },
    {
      name: "a stacked pull request: base changes to the default branch, then a newer run",
      change: (w) => {
        w.timeline.unshift(baseChange("base_ref_changed", "2026-11-16T08:00:00Z"), baseChange("automatic_base_change_succeeded", "2026-11-16T08:59:59Z"));
        w.runs.unshift(runBody({ id: 6990, run_number: 9, created_at: "2026-11-16T07:00:00Z" }));
      },
    },
    {
      name: "an older pull request of the same branch into a different base, with a different head commit",
      change: (w) => void w.headPulls.push(pullBody({ number: 3, merged_at: null, merge_commit_sha: null, base: baseOf({ ref: "release" }), head: headOf({ sha: "9".repeat(40) }) })),
    },
    { name: "a newer run on the head commit from a different branch that failed", change: (w) => void w.runs.push(runBody({ id: 7002, run_number: 11, head_branch: "copy", conclusion: "failure" })) },
    { name: "a run made in the second before the second of the merge", change: (w) => (w.runs = [runBody({ created_at: "2026-11-16T09:59:59.999Z" })]) },
    { name: "a rerun after the merge of a run made before it (created_at decides, not run_started_at)", change: (w) => (w.runs = [runBody({ run_attempt: 3, run_started_at: "2026-11-16T11:00:00Z" })]) },
  ];
  for (const each of yes) {
    it(`gives yes with ${each.name}`, async () => {
      assert.deepEqual(await verdictOf(each.change, each.over), { verified: true, reason: "passed", head: H, run: RUN });
    });
  }

  const no: { readonly name: string; readonly change: (w: World) => void; readonly reason: Reason; readonly over?: Partial<Facts> }[] = [
    { name: "a commit with two parents (a merge commit)", change: (w) => (w.commit = commitBody(C, { parents: [{ sha: P }, { sha: H }] })), reason: "not-one-parent" },
    { name: "a commit with no parent", change: (w) => (w.commit = commitBody(C, { parents: [] })), reason: "not-one-parent" },
    { name: "no pull request", change: (w) => (w.pulls = []), reason: "no-pull" },
    { name: "only an open pull request", change: (w) => (w.pulls = [pullBody({ state: "open", merged_at: null, merge_commit_sha: C })]), reason: "no-pull" },
    { name: "a merged pull request with a different merge commit", change: (w) => (w.pulls = [pullBody({ merge_commit_sha: "9".repeat(40) })]), reason: "no-pull" },
    { name: "two merged pull requests", change: (w) => void w.pulls.push(pullBody({ number: 6 })), reason: "many-pulls" },
    { name: "a head in a fork", change: (w) => (w.pulls = [pullBody({ head: headOf({ repo: { full_name: "someone/repo" } }) })]), reason: "pull-head-fork" },
    { name: "a base that is not the default branch", change: (w) => (w.pulls = [pullBody({ base: baseOf({ ref: "release" }) })]), reason: "pull-base-not-default" },
    { name: "a base in a different repository", change: (w) => (w.pulls = [pullBody({ base: baseOf({ repo: { full_name: "someone/repo" } }) })]), reason: "pull-base-not-default" },
    { name: "a different tree", change: (w) => (w.head = commitBody(H, { commit: { tree: { sha: "e".repeat(40) } } })), reason: "tree-differs" },
    { name: "a head that is behind the parent", change: (w) => (w.compare = { status: "diverged", ahead_by: 2, behind_by: 3, merge_base_commit: { sha: "e".repeat(40) } }), reason: "head-behind-parent" },
    { name: "no run", change: (w) => (w.runs = []), reason: "no-run" },
    { name: "only a run of a different event", change: (w) => (w.runs = [runBody({ event: "push" })]), reason: "no-run" },
    { name: "only a run of a different workflow file", change: (w) => (w.runs = [runBody({ path: ".github/workflows/security.yml" })]), reason: "no-run" },
    { name: "only a run from a fork", change: (w) => (w.runs = [runBody({ head_repository: { full_name: "someone/repo" } })]), reason: "no-run" },
    { name: "a newest run that failed after an older run that passed", change: (w) => void w.runs.push(runBody({ id: 7002, run_number: 11, conclusion: "failure" })), reason: "run-not-success" },
    { name: "a newest attempt that failed after an attempt that passed", change: (w) => void w.runs.push(runBody({ id: 7002, run_attempt: 2, conclusion: "failure" })), reason: "run-not-success" },
    { name: "a newest run that is in progress", change: (w) => void w.runs.push(runBody({ id: 7002, run_number: 11, status: "in_progress", conclusion: null })), reason: "run-not-completed" },
    { name: "a newest run that GitHub holds", change: (w) => void w.runs.push(runBody({ id: 7002, run_number: 11, conclusion: "action_required" })), reason: "run-not-success" },
    { name: "a newest run that was cancelled", change: (w) => void w.runs.push(runBody({ id: 7002, run_number: 11, conclusion: "cancelled" })), reason: "run-not-success" },
    {
      name: "a newest run of the repository that failed, and a newer run from a fork that passed",
      change: (w) => (w.runs = [runBody({ conclusion: "failure" }), runBody({ id: 7002, run_number: 11, head_repository: { full_name: "someone/repo" } })]),
      reason: "run-not-success",
    },
    { name: "a required job that is missing", change: (w) => (w.jobs = w.jobs.slice(0, 2)), reason: "job-missing" },
    { name: "a required job that was skipped", change: (w) => (w.jobs = [jobBody(GATE, { conclusion: "skipped" })]), reason: "job-not-success" },
    { name: "a required job that failed", change: (w) => (w.jobs = [jobBody(GATE, { conclusion: "failure" })]), reason: "job-not-success" },
    { name: "a second required job that is missing", change: () => undefined, reason: "job-missing", over: { required: [GATE, "Xplat OK"] } },
    { name: "two runs with the same number and attempt", change: (w) => void w.runs.push(runBody({ id: 7002 })), reason: "no-read-runs" },
    {
      name: "a second pull request of the head branch with the head commit, into a different base",
      change: (w) => void w.headPulls.push(pullBody({ number: 6, state: "open", merged_at: null, merge_commit_sha: null, base: baseOf({ ref: "release" }) })),
      reason: "many-pulls-of-head",
    },
    { name: "a second closed pull request of the head branch with the head commit", change: (w) => void w.headPulls.unshift(pullBody({ number: 4, merged_at: null, merge_commit_sha: null })), reason: "many-pulls-of-head" },
    { name: "only a run of a different branch on the head commit", change: (w) => (w.runs = [runBody({ head_branch: "copy" })]), reason: "no-run" },
    { name: "only a run with no head branch", change: (w) => (w.runs = [runBody({ head_branch: null })]), reason: "no-run" },
    { name: "a run made after the merge", change: (w) => (w.runs = [runBody({ created_at: "2026-11-16T10:00:01Z" })]), reason: "run-after-merge" },
    { name: "a run made in the second of the merge", change: (w) => (w.runs = [runBody({ created_at: MERGED })]), reason: "run-after-merge" },
    {
      name: "a run made in the second of the merge, some milliseconds before it",
      change: (w) => {
        w.pulls = [pullBody({ merged_at: "2026-11-16T10:00:00.900Z" })];
        w.runs = [runBody({ created_at: "2026-11-16T10:00:00.100Z" })];
      },
      reason: "run-after-merge",
    },
    { name: "a newer run after the merge (an event such as closed or labeled)", change: (w) => void w.runs.push(runBody({ id: 7002, run_number: 11, created_at: "2026-11-16T10:05:00Z" })), reason: "run-after-merge" },
    { name: "a base change after the run", change: (w) => void w.timeline.push(baseChange("base_ref_changed", "2026-11-16T09:30:00Z")), reason: "base-changed-after-run" },
    { name: "an automatic base change after the run", change: (w) => void w.timeline.push(baseChange("automatic_base_change_succeeded", "2026-11-16T09:30:00Z")), reason: "base-changed-after-run" },
    { name: "a force push of the base after the run", change: (w) => void w.timeline.push(baseChange("base_ref_force_pushed", "2026-11-16T09:30:00Z")), reason: "base-changed-after-run" },
    { name: "a base change in the second of the run", change: (w) => void w.timeline.push(baseChange("base_ref_changed", MADE)), reason: "base-changed-after-run" },
    {
      name: "a rerun after a base change: the run keeps the time of its event",
      change: (w) => {
        w.runs = [runBody({ run_attempt: 2, run_started_at: "2026-11-16T09:20:00Z" })];
        w.timeline.push(baseChange("base_ref_changed", "2026-11-16T09:10:00Z"));
      },
      reason: "base-changed-after-run",
    },
  ];
  for (const each of no) {
    it(`gives no (${each.reason}) with ${each.name}`, async () => {
      const verdict = await verdictOf(each.change, each.over);
      assert.equal(verdict.verified, false);
      assert.equal(verdict.reason, each.reason);
    });
  }
});

describe("verified tree: a fact that the script cannot read is never a pass", () => {
  for (const kind of KINDS) {
    for (const status of [404, 500]) {
      it(`gives no-read-${kind} when the read of ${kind} gives HTTP ${String(status)}`, async () => {
        const verdict = await verdictOf((w) => (w.fail[kind] = status));
        assert.deepEqual([verdict.verified, verdict.reason], [false, `no-read-${kind}`]);
      });
    }
  }

  const malformed: { readonly name: string; readonly change: (w: World) => void; readonly reason: Reason }[] = [
    { name: "a tree that is not a sha", change: (w) => (w.commit = commitBody(C, { commit: { tree: { sha: "TREE" } } })), reason: "no-read-commit" },
    { name: "a parent in capital letters", change: (w) => (w.commit = commitBody(C, { parents: [{ sha: P.toUpperCase() }] })), reason: "no-read-commit" },
    { name: "a commit that is not the commit of the read", change: (w) => (w.commit = commitBody("f".repeat(40))), reason: "no-read-commit" },
    { name: "a body that is not an object", change: (w) => (w.commit = "<html>"), reason: "no-read-commit" },
    { name: "a head sha of 39 characters", change: (w) => (w.pulls = [pullBody({ head: headOf({ sha: H.slice(1) }) })]), reason: "no-read-pulls" },
    { name: "a merge commit of 41 characters", change: (w) => (w.pulls = [pullBody({ merge_commit_sha: `${C}c` })]), reason: "no-read-pulls" },
    { name: "a merge commit that is a number", change: (w) => (w.pulls = [pullBody({ merge_commit_sha: 5 })]), reason: "no-read-pulls" },
    { name: "a head with no repository", change: (w) => (w.pulls = [pullBody({ head: headOf({ repo: null }) })]), reason: "no-read-pulls" },
    { name: "a pull request with no merged_at", change: (w) => (w.pulls = [pullBody({ merged_at: undefined })]), reason: "no-read-pulls" },
    { name: "a pull request with no fields", change: (w) => (w.pulls = [{}]), reason: "no-read-pulls" },
    { name: "a pull request with no number", change: (w) => (w.pulls = [pullBody({ number: undefined })]), reason: "no-read-pulls" },
    { name: "a pull request with no head branch", change: (w) => (w.pulls = [pullBody({ head: headOf({ ref: undefined }) })]), reason: "no-read-pulls" },
    { name: "a merged_at that is not a time", change: (w) => (w.pulls = [pullBody({ merged_at: "yesterday" })]), reason: "no-read-pulls" },
    { name: "a merged_at with no time zone", change: (w) => (w.pulls = [pullBody({ merged_at: "2026-11-16T10:00:00" })]), reason: "no-read-pulls" },
    { name: "a merged_at on a date that does not exist", change: (w) => (w.pulls = [pullBody({ merged_at: "2026-02-30T10:00:00Z" })]), reason: "no-read-pulls" },
    { name: "a list of the head branch without the pull request", change: (w) => (w.headPulls = []), reason: "no-read-head-pulls" },
    { name: "a list of the head branch with only a different number on the head commit", change: (w) => (w.headPulls = [pullBody({ number: 6 })]), reason: "no-read-head-pulls" },
    { name: "a pull request of the head branch with no number", change: (w) => void w.headPulls.push({ head: { sha: H } }), reason: "no-read-head-pulls" },
    { name: "a pull request of the head branch with a head that is not a sha", change: (w) => void w.headPulls.push(pullBody({ number: 6, head: headOf({ sha: "main" }) })), reason: "no-read-head-pulls" },
    { name: "a head branch with a control character", change: (w) => (w.pulls = [pullBody({ head: headOf({ ref: "feature\n" }) })]), reason: "no-read-head-pulls" },
    { name: "no default branch", change: (w) => (w.repo = { full_name: repo }), reason: "no-read-repo" },
    { name: "an empty default branch", change: (w) => (w.repo = { full_name: repo, default_branch: "" }), reason: "no-read-repo" },
    { name: "a head commit that is not the head of the pull request", change: (w) => (w.head = commitBody("f".repeat(40))), reason: "no-read-head" },
    { name: "a head commit with a tree that is not a sha", change: (w) => (w.head = commitBody(H, { commit: { tree: null } })), reason: "no-read-head" },
    { name: "no behind_by", change: (w) => (w.compare = { merge_base_commit: { sha: P } }), reason: "no-read-compare" },
    { name: "a negative behind_by", change: (w) => (w.compare = { behind_by: -1, merge_base_commit: { sha: P } }), reason: "no-read-compare" },
    { name: "a behind_by that is not an integer", change: (w) => (w.compare = { behind_by: 0.5, merge_base_commit: { sha: P } }), reason: "no-read-compare" },
    { name: "a merge base that is not the parent with behind_by 0", change: (w) => (w.compare = { behind_by: 0, merge_base_commit: { sha: "e".repeat(40) } }), reason: "no-read-compare" },
    { name: "a merge base that is not a sha", change: (w) => (w.compare = { behind_by: 0, merge_base_commit: { sha: "HEAD" } }), reason: "no-read-compare" },
    { name: "a run with a head that is not a sha", change: (w) => (w.runs = [runBody({ head_sha: "main" })]), reason: "no-read-runs" },
    { name: "a run with no run_number", change: (w) => (w.runs = [runBody({ run_number: undefined })]), reason: "no-read-runs" },
    { name: "a run with no conclusion field", change: (w) => (w.runs = [runBody({ conclusion: undefined })]), reason: "no-read-runs" },
    { name: "a run with no head repository", change: (w) => (w.runs = [runBody({ head_repository: null })]), reason: "no-read-runs" },
    { name: "a total_count of the runs that the pages do not give", change: (w) => (w.totals.runs = 2), reason: "no-read-runs" },
    { name: "a run with no created_at", change: (w) => (w.runs = [runBody({ created_at: undefined })]), reason: "no-read-runs" },
    { name: "a run with a created_at that is a number", change: (w) => (w.runs = [runBody({ created_at: 1794826800 })]), reason: "no-read-runs" },
    { name: "a run with a created_at at hour 24", change: (w) => (w.runs = [runBody({ created_at: "2026-11-16T24:00:00Z" })]), reason: "no-read-runs" },
    { name: "a run with a head branch that is a number", change: (w) => (w.runs = [runBody({ head_branch: 5 })]), reason: "no-read-runs" },
    { name: "a base change with no created_at", change: (w) => void w.timeline.push({ event: "base_ref_changed", id: 1 }), reason: "no-read-timeline" },
    { name: "a base change with a created_at that is not an ISO time", change: (w) => void w.timeline.push(baseChange("base_ref_changed", "2026-11-16 08:00")), reason: "no-read-timeline" },
    { name: "an automatic base change on a date that does not exist", change: (w) => void w.timeline.push(baseChange("automatic_base_change_succeeded", "2026-02-30T08:00:00Z")), reason: "no-read-timeline" },
    { name: "a timeline item that is not an object", change: (w) => void w.timeline.push("base_ref_changed"), reason: "no-read-timeline" },
    { name: "a job with a conclusion that is a number", change: (w) => (w.jobs = [jobBody(GATE, { conclusion: 1 })]), reason: "no-read-jobs" },
    { name: "a job of a different run", change: (w) => (w.jobs = [jobBody(GATE, { run_id: 9 })]), reason: "no-read-jobs" },
    { name: "a total_count of the jobs that is not valid", change: (w) => (w.totals.jobs = -1), reason: "no-read-jobs" },
  ];
  for (const each of malformed) {
    it(`gives ${each.reason} for ${each.name}`, async () => {
      const verdict = await verdictOf(each.change);
      assert.deepEqual([verdict.verified, verdict.reason], [false, each.reason]);
    });
  }

  it("gives no-read-commit when the fetch throws, and when the body is not JSON", async () => {
    const thrown = githubApi(async () => Promise.reject(new Error("socket hang up")), { api: "https://api.example", token: "t" });
    assert.equal((await verify(thrown, input())).reason, "no-read-commit");
    const html = githubApi(async () => ({ status: 200, text: async () => "<html>rate limit</html>" }), { api: "https://api.example", token: "t" });
    assert.equal((await verify(html, input())).reason, "no-read-commit");
  });

  it("reads the jobs on two pages", async () => {
    const w = world();
    w.jobs = [...Array.from({ length: 100 }, (_, index) => jobBody(`job ${String(index)}`)), jobBody(GATE)];
    const api = fakeApi(w);
    assert.equal((await verify(api, input())).reason, "passed");
    assert.ok(api.calls.includes(`repos/${repo}/actions/runs/${String(RUN)}/jobs?filter=latest&per_page=100&page=2`));
  });

  it("reads the runs on two pages, so a newest run on page 2 decides", async () => {
    const w = world();
    w.runs = [...Array.from({ length: 100 }, (_, index) => runBody({ id: 100 + index, run_number: index + 1 })), runBody({ id: 7002, run_number: 200, conclusion: "failure" })];
    const api = fakeApi(w);
    assert.deepEqual(await verify(api, input()), { verified: false, reason: "run-not-success", head: H, run: 7002 });
    assert.ok(api.calls.includes(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${H}&event=pull_request&per_page=100&page=2`));
  });

  it("reads the timeline on two pages, so a base change on page 2 decides", async () => {
    const w = world();
    w.timeline = [...Array.from({ length: 100 }, () => ({ event: "labeled", created_at: "2026-11-16T08:00:00Z" })), baseChange("base_ref_changed", "2026-11-16T09:30:00Z")];
    const api = fakeApi(w);
    assert.deepEqual(await verify(api, input()), { verified: false, reason: "base-changed-after-run", head: H, run: RUN });
    assert.ok(api.calls.includes(`repos/${repo}/issues/${String(PULL)}/timeline?per_page=100&page=2`));
  });

  it("reads only ISO times in UTC, to the second", () => {
    assert.equal(timeOf("2026-11-16T09:00:00Z"), Date.parse("2026-11-16T09:00:00Z") / 1000);
    assert.equal(timeOf("2026-11-16T09:00:00.999Z"), timeOf("2026-11-16T09:00:00Z"));
    for (const value of ["2026-11-16T09:00:00+00:00", "2026-11-16T09:00:00", "2026-02-29T00:00:00Z", "2026-11-16T09:60:00Z", "", "now", null, 1794826800, undefined]) {
      assert.equal(timeOf(value), null, String(value));
    }
    assert.equal(timeOf("2028-02-29T00:00:00Z"), Date.parse("2028-02-29T00:00:00Z") / 1000);
  });

  it("gives no list after 10 full pages", async () => {
    const full: Api = { get: async () => ({ status: 200, body: { total_count: 5000, jobs: Array.from({ length: 100 }, () => ({})) } }) };
    assert.equal(await readList(full, "repos/owner/repo/actions/runs/1/jobs?filter=latest", "jobs"), null);
  });
});

describe("verified tree: decide is a pure function over the facts", () => {
  const made = Date.parse(MADE) / 1000;
  const facts: Facts = {
    ...input(),
    commit: { sha: C, tree: TREE, parents: [P] },
    pulls: [{ number: PULL, mergedAt: Date.parse(MERGED) / 1000, mergeCommit: C, baseRef: "main", baseRepository: repo, headRef: "feature", headSha: H, headRepository: repo }],
    repo: { defaultBranch: "main" },
    headPulls: { ref: "feature", pulls: [{ number: PULL, headSha: H }] },
    head: { sha: H, tree: TREE, parents: [P] },
    compare: { base: P, head: H, behindBy: 0, mergeBase: P },
    runs: [
      {
        id: RUN,
        runNumber: 10,
        runAttempt: 1,
        path: ".github/workflows/ci.yml",
        event: "pull_request",
        headSha: H,
        headBranch: "feature",
        headRepository: repo,
        createdAt: made,
        status: "completed",
        conclusion: "success",
      },
    ],
    timeline: { pull: PULL, changes: [made - 1] },
    jobs: { run: RUN, jobs: [{ name: GATE, status: "completed", conclusion: "success" }] },
  };

  /** This function gives the facts with no value for some keys. */
  const without = (keys: readonly (keyof Facts)[]): Facts => Object.fromEntries(Object.entries(facts).filter(([key]) => !keys.includes(key as keyof Facts))) as unknown as Facts;

  it("gives the verdict from the facts, with no read", () => {
    assert.deepEqual(decide(facts), { kind: "verdict", verdict: { verified: true, reason: "passed", head: H, run: RUN } });
  });

  it("asks for each absent fact in the order of the rules", () => {
    assert.deepEqual(decide(input()), { kind: "read", need: { fact: "commit", sha: C } });
    assert.deepEqual(decide(without(["jobs"])), { kind: "read", need: { fact: "jobs", run: RUN } });
    assert.deepEqual(decide(without(["timeline", "jobs"])), { kind: "read", need: { fact: "timeline", pull: PULL } });
    assert.deepEqual(decide(without(["compare", "runs", "jobs"])), { kind: "read", need: { fact: "compare", base: P, head: H } });
    assert.deepEqual(decide(without(["headPulls", "head", "compare", "runs", "timeline", "jobs"])), { kind: "read", need: { fact: "headPulls", owner: "owner", ref: "feature" } });
  });

  it("gives a no read for a fact of a different commit or run, and for inputs that are not valid", () => {
    const reason = (over: Partial<Facts>): Reason | null => {
      const step = decide({ ...facts, ...over });
      return step.kind === "verdict" ? step.verdict.reason : null;
    };
    assert.equal(reason({ head: { sha: "f".repeat(40), tree: TREE, parents: [P] } }), "no-read-head");
    assert.equal(reason({ compare: { base: H, head: P, behindBy: 0, mergeBase: P } }), "no-read-compare");
    assert.equal(reason({ jobs: { run: 1, jobs: [{ name: GATE, status: "completed", conclusion: "success" }] } }), "no-read-jobs");
    assert.equal(reason({ commit: { noRead: "no-read-commit" } }), "no-read-commit");
    assert.equal(reason({ headPulls: { ref: "other", pulls: [{ number: PULL, headSha: H }] } }), "no-read-head-pulls");
    assert.equal(reason({ timeline: { pull: PULL + 1, changes: [] } }), "no-read-timeline");
    assert.equal(reason({ timeline: { pull: PULL, changes: [made - 1, made] } }), "base-changed-after-run");
    assert.equal(reason({ timeline: { pull: PULL, changes: [] } }), "passed");
    assert.equal(reason({ sha: "C".repeat(40) }), "no-read-input");
    assert.equal(reason({ repository: "owner/.." }), "no-read-input");
    assert.equal(reason({ workflow: "../ci.yml" }), "no-read-input");
    assert.equal(reason({ required: [] }), "no-read-input");
    assert.equal(reason({ required: ["CI OK\n"] }), "no-read-input");
  });
});

describe("verified tree: the step", () => {
  const env = (folder: string, over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    GITHUB_REPOSITORY: repo,
    GITHUB_SHA: C,
    GITHUB_API_URL: "https://api.example",
    GH_TOKEN: "secret-token-value",
    GITHUB_OUTPUT: join(folder, "output"),
    GITHUB_STEP_SUMMARY: join(folder, "summary.md"),
    ...over,
  });

  /** This function starts main() in a new folder, and gives its exit code, its files, its lines on stdout and its requests. */
  async function step(argv: readonly string[], over: NodeJS.ProcessEnv = {}, change: (w: World) => void = () => undefined) {
    const folder = mkdtempSync(join(tmpdir(), "verified-tree-"));
    try {
      const w = world();
      change(w);
      const { fetcher, requests } = fakeFetch(w);
      const logged: string[] = [];
      const code = await main(argv, env(folder, over), fetcher, (line) => void logged.push(line));
      const read = (name: string): string => {
        try {
          return readFileSync(join(folder, name), "utf8");
        } catch {
          return "";
        }
      };
      return { code, output: read("output"), summary: read("summary.md"), logged, requests };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  it("writes the yes to GITHUB_OUTPUT, one line to the summary and the same line to stdout", async () => {
    const result = await step([]);
    const line = `Verified tree: verified=true reason=passed commit=${C} head=${H} run=${String(RUN)}. The tree of the commit passed CI in its pull request.`;
    assert.equal(result.code, 0);
    assert.equal(result.output, "verified=true\nreason=passed\n");
    assert.equal(result.summary, `${line}\n`);
    assert.deepEqual(result.logged, [line]);
    assert.equal(result.requests.length, 9);
    for (const request of result.requests) {
      assert.equal(request.method, "GET");
      assert.ok(request.url.startsWith(`https://api.example/repos/${repo}`));
      assert.equal(request.headers["authorization"], "Bearer secret-token-value");
    }
  });

  it("writes a no with exit code 0, and no text of the API goes to an output", async () => {
    const hostile = "main\nverified=true\nreason=passed";
    const result = await step([], {}, (w) => {
      w.repo = { full_name: repo, default_branch: hostile };
      w.pulls = [pullBody({ title: hostile, head: headOf({ ref: hostile }) })];
    });
    assert.equal(result.code, 0);
    assert.equal(result.output, "verified=false\nreason=pull-base-not-default\n");
    assert.equal(result.summary, `Verified tree: verified=false reason=pull-base-not-default commit=${C}. The base of the pull request is not the default branch.\n`);
    assert.deepEqual(result.logged, [result.summary.trimEnd()]);
  });

  it("never writes the token to an output, the summary or stdout", async () => {
    for (const over of [{}, { GH_TOKEN: "", GITHUB_TOKEN: "secret-token-value" }]) {
      const result = await step([], over, (w) => (w.fail.jobs = 500));
      assert.equal(result.output, "verified=false\nreason=no-read-jobs\n");
      for (const text of [result.output, result.summary, ...result.logged]) assert.doesNotMatch(text, /secret-token-value/);
      assert.ok(result.requests.every((request) => request.headers["authorization"] === "Bearer secret-token-value"));
    }
    const none = await step([], { GH_TOKEN: "", GITHUB_TOKEN: "" });
    assert.ok(none.requests.every((request) => request.headers["authorization"] === undefined));
  });

  const invalid: { readonly name: string; readonly argv: readonly string[]; readonly over: NodeJS.ProcessEnv }[] = [
    { name: "a sha that is not full", argv: ["--sha", "abc1234"], over: {} },
    { name: "a sha in capital letters", argv: [], over: { GITHUB_SHA: C.toUpperCase() } },
    { name: "no sha", argv: [], over: { GITHUB_SHA: "" } },
    { name: "a repository with a .. part", argv: [], over: { GITHUB_REPOSITORY: "owner/.." } },
    { name: "a repository with no owner", argv: [], over: { GITHUB_REPOSITORY: "repo" } },
    { name: "a workflow in a different folder", argv: ["--workflow", "../ci.yml"], over: {} },
    { name: "an empty job name", argv: ["--job", ""], over: {} },
    { name: "an unknown option", argv: ["--force"], over: {} },
    { name: "a positional argument", argv: [C], over: {} },
    { name: "an API URL that is not https", argv: [], over: { GITHUB_API_URL: "http://api.example" } },
  ];
  for (const each of invalid) {
    it(`gives no-read-input with exit code 0 and no request for ${each.name}`, async () => {
      const result = await step(each.argv, each.over);
      assert.equal(result.code, 0);
      assert.equal(result.output, "verified=false\nreason=no-read-input\n");
      assert.equal(result.summary, "Verified tree: verified=false reason=no-read-input commit=none. An input is missing or not valid.\n");
      assert.deepEqual(result.requests, []);
    });
  }

  it("reads the inputs: the arguments replace the environment, and the default job is the gate", () => {
    const base = { GITHUB_REPOSITORY: repo, GITHUB_SHA: C };
    assert.deepEqual(readInput([], base), { facts: { repository: repo, sha: C, workflow: "ci.yml", required: [GATE] }, api: "https://api.github.com" });
    assert.deepEqual(readInput(["--sha", H, "--workflow", "gate.yml", "--job", "A OK", "--job", "B OK"], { ...base, REQUIRED_JOBS: "X OK", WORKFLOW_FILE: "other.yml" })?.facts, {
      repository: repo,
      sha: H,
      workflow: "gate.yml",
      required: ["A OK", "B OK"],
    });
    assert.deepEqual(readInput([], { ...base, REQUIRED_JOBS: "CI OK\r\n\n  Xplat OK \n", WORKFLOW_FILE: "gate.yaml", GITHUB_API_URL: "https://ghe.example/api/v3/" }), {
      facts: { repository: repo, sha: C, workflow: "gate.yaml", required: [GATE, "Xplat OK"] },
      api: "https://ghe.example/api/v3",
    });
  });
});

describe("verified tree: the outputs are a closed set", () => {
  const codes = Object.keys(REASONS) as Reason[];
  const code = `(?:${codes.join("|")})`;
  const outputPattern = new RegExp(`^verified=(?:true|false)\\nreason=${code}\\n$`);
  const linePattern = new RegExp(`^Verified tree: verified=(?:true|false) reason=${code} commit=(?:[0-9a-f]{40}|none)(?: head=[0-9a-f]{40})?(?: run=[1-9][0-9]*)?\\. [^\\n]+$`);

  it("gives only fixed texts, reason codes, checked shas and integers, for each reason and each value", () => {
    for (const reason of codes) {
      for (const verified of [true, false]) {
        for (const head of [H, null, "main\nverified=true"]) {
          for (const run of [RUN, null, 1.5, -1]) {
            const verdict = { verified, reason, head, run };
            const output = outputText(verdict);
            assert.match(output, outputPattern);
            assert.equal(output.startsWith("verified=true\n"), verified && reason === "passed");
            for (const commit of [C, null, "x"]) {
              const line = summaryLine(verdict, commit);
              assert.match(line, linePattern);
              assert.ok(line.endsWith(REASONS[reason]));
            }
          }
        }
      }
    }
  });

  it("gives no-read-error for a reason that is not in the set", () => {
    const verdict = { verified: true, reason: "passed\nverified=true" as string as Reason, head: null, run: null };
    assert.equal(outputText(verdict), "verified=false\nreason=no-read-error\n");
    assert.equal(summaryLine(verdict, C), `Verified tree: verified=false reason=no-read-error commit=${C}. ${REASONS["no-read-error"]}`);
  });
});

describe("verified tree: the files", () => {
  it("the default required job is the name of the gate job ci-ok of ci.yml", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    assert.equal(/\n {2}ci-ok:\n {4}name: (.+)\n/.exec(ci)?.[1], GATE);
    assert.deepEqual(DEFAULT_JOBS, [GATE]);
  });

  it("the script imports only node: built-ins, so it runs with no install", () => {
    const source = readFileSync(join(root, "scripts/workflows/verified-tree.ts"), "utf8");
    const imports = [...source.matchAll(/^import\b[^;]*?from "([^"]+)";$/gms)].map((match) => match[1] ?? "");
    assert.ok(imports.length > 0);
    for (const specifier of imports) assert.match(specifier, /^node:/);
    assert.doesNotMatch(source, /\bimport\(/);
  });
});
