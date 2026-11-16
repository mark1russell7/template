// Tests of the queue (scripts/workflows/queue.ts, CI.md "The queue"). Start them with "pnpm test:workflows". The API is a
// fake, so the tests use no network and do not wait.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type Api,
  type ApiResponse,
  type Fetch,
  type Outcome,
  type PullRun,
  type PullState,
  type Timing,
  HELD,
  TOKEN_BOT,
  annotations,
  execute,
  exitCode,
  githubApi,
  held,
  main,
  plan,
  queued,
  readPullRuns,
  readSettledPulls,
  refusal,
  requiredChecks,
  summaryText,
} from "./queue.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = "owner/repo";

/** A pull request with auto-merge that is behind, with fields that the test changes. */
const pull = (number: number, over: Partial<PullState> = {}): PullState => ({
  number,
  draft: false,
  fork: false,
  autoMerge: true,
  mergeState: "BEHIND",
  headRef: `branch-${String(number)}`,
  headSha: String(number).repeat(40).slice(0, 40),
  ...over,
});

const ci = ".github/workflows/ci.yml";
const security = ".github/workflows/security.yml";

/** A held pull_request run of the bot of GITHUB_TOKEN on a commit of the repository, with fields that the test changes. */
const run = (id: number, sha: string, over: Partial<PullRun> = {}): PullRun => ({
  id,
  path: ci,
  headSha: sha,
  headRepository: repo,
  event: "pull_request",
  status: "completed",
  conclusion: HELD,
  actor: TOKEN_BOT,
  ...over,
});

/** The body of `GET /repos/{o}/{r}/actions/runs` for some runs. */
const runsBody = (runs: readonly PullRun[]): unknown => ({
  total_count: runs.length,
  workflow_runs: runs.map((each) => ({
    id: each.id,
    path: each.path,
    head_sha: each.headSha,
    head_repository: each.headRepository === "" ? null : { full_name: each.headRepository },
    event: each.event,
    status: each.status,
    conclusion: each.conclusion,
    actor: each.actor === "" ? null : { login: each.actor },
  })),
});

/** A timing that does not wait, and records each sleep. */
function timing(over: Partial<Timing> = {}): Timing & { slept: number[] } {
  const slept: number[] = [];
  return { sleep: async (ms) => void slept.push(ms), stepMs: 5000, waitMs: 15000, reads: 3, ...over, slept };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

/** A fake API: `rest` answers each call from the handler, and `graphql` gives the next page of the list. */
function fakeApi(rest: (call: Call) => ApiResponse | undefined, pages: unknown[] = []): Api & { calls: Call[]; queries: Readonly<Record<string, unknown>>[] } {
  const calls: Call[] = [];
  const queries: Readonly<Record<string, unknown>>[] = [];
  return {
    calls,
    queries,
    async rest(method, path, body) {
      const call = body === undefined ? { method, path } : { method, path, body };
      calls.push(call);
      const answer = rest(call);
      if (answer === undefined) throw new Error(`no answer for ${method} ${path}`);
      return answer;
    },
    async graphql(_query, variables) {
      queries.push(variables);
      const page = pages.length > 1 ? pages.shift() : pages[0];
      if (page === undefined) throw new Error("no page");
      return page;
    },
  };
}

/** A GraphQL page of pull requests. */
const page = (pulls: readonly PullState[], next?: string): unknown => ({
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null },
      nodes: pulls.map((each) => ({
        number: each.number,
        isDraft: each.draft,
        isCrossRepository: each.fork,
        headRefName: each.headRef,
        headRefOid: each.headSha,
        mergeStateStatus: each.mergeState,
        autoMergeRequest: each.autoMerge ? { enabledAt: "2026-11-15T00:00:00Z" } : null,
      })),
    },
  },
});

/** The calls that start a run (approve and rerun), in their order. */
const starts = (api: { calls: Call[] }): string[] => api.calls.filter((call) => call.method === "POST").map((call) => call.path);

describe("queue: the plan", () => {
  it("takes only the pull requests with auto-merge, not drafts and not from a fork", () => {
    assert.equal(queued(pull(1)), true);
    assert.equal(queued(pull(1, { autoMerge: false })), false);
    assert.equal(queued(pull(1, { draft: true })), false);
    assert.equal(queued(pull(1, { fork: true })), false);
  });

  it("updates each pull request that is BEHIND, with its head as expected_head_sha, and skips the other states", () => {
    const pulls = [pull(3), pull(1, { autoMerge: false }), pull(2, { draft: true }), pull(4, { fork: true }), pull(5, { mergeState: "CLEAN" }), pull(6, { mergeState: "DIRTY" }), pull(7, { mergeState: "UNKNOWN" }), pull(8)];
    const actions = plan(pulls);
    assert.deepEqual(
      actions.map((action) => [action.pull, action.kind]),
      [
        [3, "update"],
        [5, "skip"],
        [6, "skip"],
        [7, "skip"],
        [8, "update"],
      ],
    );
    assert.deepEqual(actions[0], { kind: "update", pull: 3, mergeState: "BEHIND", expectedHeadSha: "3".repeat(40) });
    assert.deepEqual(actions[1], { kind: "skip", pull: 5, mergeState: "CLEAN", headSha: "5".repeat(40), why: "the merge state is CLEAN, not BEHIND", noRead: false });
    assert.match(actions[2]?.kind === "skip" ? actions[2].why : "", /merge conflict/);
    assert.deepEqual(actions[3], { kind: "skip", pull: 7, mergeState: "UNKNOWN", headSha: "7".repeat(40), why: "GitHub did not compute the merge state", noRead: true });
  });

  it("reads the required checks of each ruleset one time, and strict when one rule asks for it", () => {
    const rules = [
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "Actions OK", integration_id: 15368 }] } },
      { type: "pull_request", parameters: {} },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "CI OK" }, { context: "Actions OK" }, { context: "Security OK" }] } },
    ];
    assert.deepEqual(requiredChecks(rules), { checks: ["Actions OK", "CI OK", "Security OK"], strict: true });
    assert.deepEqual(requiredChecks([]), { checks: [], strict: false });
  });

  it("a held run is a completed run with the conclusion action_required", () => {
    const sha = "a".repeat(40);
    assert.equal(held(run(1, sha)), true);
    assert.equal(held(run(1, sha, { status: "in_progress", conclusion: null })), false);
    assert.equal(held(run(1, sha, { conclusion: "success" })), false);
  });

  it("starts only a pull_request run of the repository on the head that it read, whose actor is the bot of GITHUB_TOKEN", () => {
    const sha = "a".repeat(40);
    assert.equal(refusal(run(1, sha), repo, sha), null);
    // A run of a fork is never started, also when each other field fits
    assert.equal(refusal(run(1, sha, { headRepository: "someone/repo" }), repo, sha), `its head is in the repository someone/repo, not ${repo}`);
    assert.equal(refusal(run(1, sha, { headRepository: "" }), repo, sha), `its head is in the repository (none), not ${repo}`);
    assert.equal(refusal(run(1, sha, { actor: "a-person" }), repo, sha), `its actor is a-person, not ${TOKEN_BOT}`);
    assert.equal(refusal(run(1, sha, { headSha: "b".repeat(40) }), repo, sha), "its head bbbbbbb is not the head aaaaaaa of the pull request");
    assert.equal(refusal(run(1, sha, { event: "pull_request_target" }), repo, sha), "the event is pull_request_target, not pull_request");
  });
});

describe("queue: the reads", () => {
  it("reads the pull requests again while a queued one is UNKNOWN, and reads each page", async () => {
    const api = fakeApi(() => undefined, [page([pull(1, { mergeState: "UNKNOWN" })], "c1"), page([pull(2, { autoMerge: false, mergeState: "UNKNOWN" })]), page([pull(1)], "c2"), page([pull(2, { autoMerge: false, mergeState: "UNKNOWN" })])]);
    const time = timing();
    const pulls = await readSettledPulls(api, repo, "main", time);
    assert.deepEqual(
      pulls.map((each) => [each.number, each.mergeState]),
      [
        [1, "BEHIND"],
        [2, "UNKNOWN"],
      ],
    );
    assert.deepEqual(time.slept, [5000]);
    assert.deepEqual(
      api.queries.map((query) => query["after"]),
      [null, "c1", null, "c2"],
    );
    assert.deepEqual(api.queries[0], { owner: "owner", name: "repo", base: "main", after: null });
  });

  it("stops after the limit of reads when the state stays UNKNOWN", async () => {
    const api = fakeApi(() => undefined, [page([pull(1, { mergeState: "UNKNOWN" })])]);
    const time = timing({ reads: 3 });
    const pulls = await readSettledPulls(api, repo, "main", time);
    assert.equal(pulls[0]?.mergeState, "UNKNOWN");
    assert.equal(api.queries.length, 3);
    assert.deepEqual(time.slept, [5000, 5000]);
  });

  it("reads the pull_request runs of a commit page by page, with the path of the file and no ref of a called file", async () => {
    const sha = "a".repeat(40);
    const first = Array.from({ length: 100 }, (_, index) => run(index + 1, sha));
    const api = fakeApi(({ path }) => {
      if (path === `repos/${repo}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100&page=1`) return { status: 200, body: { ...(runsBody(first) as object), total_count: 101 } };
      if (path.endsWith("&page=2")) return { status: 200, body: { total_count: 101, workflow_runs: [{ id: 200, path: `${security}@refs/heads/main`, head_sha: sha, head_repository: null, event: "pull_request", status: "completed", conclusion: HELD, actor: null }, { path: "no id" }] } };
      return undefined;
    });
    const runs = await readPullRuns(api, repo, sha);
    assert.equal(runs.length, 101);
    assert.deepEqual(runs[100], { id: 200, path: security, headSha: sha, headRepository: "", event: "pull_request", status: "completed", conclusion: HELD, actor: "" });
  });

  it("a failed read throws", async () => {
    const api = fakeApi(() => ({ status: 403, body: { message: "Resource not accessible by integration" } }));
    await assert.rejects(readPullRuns(api, repo, "abc"), /HTTP 403: Resource not accessible by integration/);
  });
});

describe("queue: the actions", () => {
  const newHead = "f".repeat(40);

  /**
   * The API of three behind pull requests: #1 updates and its head changes at the second read, #2 has a conflict, #3 never
   * changes. The new head of #1 has two held runs. Approve starts the first one and refuses the second one, and rerun starts
   * the second one.
   */
  function threePulls(runs: readonly PullRun[] = [run(101, newHead), run(102, newHead, { path: security })]) {
    let reads = 0;
    const api = fakeApi(({ method, path }) => {
      if (method === "PUT" && path.endsWith("/pulls/1/update-branch")) return { status: 202, body: { message: "Updating pull request branch." } };
      if (method === "PUT" && path.endsWith("/pulls/2/update-branch")) return { status: 422, body: { message: "merge conflict between base and head" } };
      if (method === "PUT" && path.endsWith("/pulls/3/update-branch")) return { status: 202, body: {} };
      if (method === "GET" && path.endsWith("/pulls/1")) return { status: 200, body: { head: { sha: (reads += 1) >= 2 ? newHead : "1".repeat(40) } } };
      if (method === "GET" && path.endsWith("/pulls/3")) return { status: 200, body: { head: { sha: "3".repeat(40) } } };
      if (method === "GET" && path.includes(`actions/runs?head_sha=${newHead}&event=pull_request`)) return { status: 200, body: runsBody(runs) };
      if (method === "POST" && path.endsWith("/actions/runs/101/approve")) return { status: 201, body: {} };
      if (method === "POST" && path.endsWith("/actions/runs/102/approve")) return { status: 403, body: { message: "This run is not from a fork pull request" } };
      if (method === "POST" && path.endsWith("/actions/runs/102/rerun")) return { status: 201, body: {} };
      return undefined;
    });
    return { api, actions: plan([pull(2), pull(1), pull(3)]) };
  }

  it("updates each behind pull request, waits for the new heads, and starts each held run of a new head", async () => {
    const { api, actions } = threePulls();
    const time = timing({ waitMs: 25000 });
    const outcomes = await execute(api, repo, actions, time);
    const one = outcomes.find((outcome) => outcome.pull === 1);
    assert.equal(one?.result, "updated");
    assert.equal(one?.newSha, newHead);
    assert.deepEqual(one?.started, [`${ci} run 101 (approved)`, `${security} run 102 (rerun, approve gave HTTP 403: This run is not from a fork pull request)`]);
    assert.deepEqual(one?.failed, []);
    assert.deepEqual(one?.noRead, []);
    // A conflict skips only its own pull request
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.pull, outcome.result]),
      [
        [1, "updated"],
        [2, "refused"],
        [3, "timeout"],
      ],
    );
    assert.match(outcomes[1]?.detail ?? "", /HTTP 422: merge conflict between base and head/);
    // The update names the head that the queue read
    assert.deepEqual(
      api.calls.filter((call) => call.method === "PUT").map((call) => [call.path, call.body]),
      [
        [`repos/${repo}/pulls/1/update-branch`, { expected_head_sha: "1".repeat(40) }],
        [`repos/${repo}/pulls/2/update-branch`, { expected_head_sha: "2".repeat(40) }],
        [`repos/${repo}/pulls/3/update-branch`, { expected_head_sha: "3".repeat(40) }],
      ],
    );
    // Each held run starts one time: the second read of the runs gives the same set, so the set is stable
    assert.deepEqual(starts(api), [`repos/${repo}/actions/runs/101/approve`, `repos/${repo}/actions/runs/102/approve`, `repos/${repo}/actions/runs/102/rerun`]);
    assert.equal(api.calls.filter((call) => call.path.includes("actions/runs?head_sha=")).length, 2);
    // No dispatch: a workflow_dispatch run gives no check to the pull request
    assert.equal(api.calls.filter((call) => call.path.includes("/dispatches")).length, 0);
    // One wait for all the heads and their runs, never longer than the limit
    assert.deepEqual(time.slept, [5000, 5000, 5000, 5000, 5000]);
    // The head of #3 did not change
    assert.equal(exitCode(outcomes), 1);
  });

  it("never starts a held run of a fork or of a different actor: each one is a no read", async () => {
    const runs = [run(101, newHead), run(103, newHead, { headRepository: "someone/repo" }), run(104, newHead, { actor: "a-person" }), run(105, newHead, { conclusion: "success" })];
    const { api } = threePulls(runs);
    const outcomes = await execute(api, repo, plan([pull(1)]), timing({ waitMs: 25000 }));
    assert.deepEqual(starts(api), [`repos/${repo}/actions/runs/101/approve`]);
    assert.equal(outcomes[0]?.result, "updated");
    assert.deepEqual(outcomes[0]?.noRead, [
      { subject: `${ci} run 103`, why: `GitHub holds it, and the queue does not start it: its head is in the repository someone/repo, not ${repo}` },
      { subject: `${ci} run 104`, why: `GitHub holds it, and the queue does not start it: its actor is a-person, not ${TOKEN_BOT}` },
    ]);
    assert.equal(exitCode(outcomes), 0);
  });

  it("fails with the id of each held run when approve and rerun both refuse it", async () => {
    const api = fakeApi(({ method, path }) => {
      if (method === "PUT") return { status: 202, body: {} };
      if (method === "GET" && path.endsWith("/pulls/1")) return { status: 200, body: { head: { sha: newHead } } };
      if (method === "GET" && path.includes("actions/runs?head_sha=")) return { status: 200, body: runsBody([run(101, newHead), run(102, newHead, { path: security })]) };
      if (method === "POST" && path.endsWith("/approve")) return { status: 403, body: { message: "Resource not accessible by integration" } };
      if (method === "POST" && path.endsWith("/actions/runs/101/rerun")) return { status: 403, body: { message: "Resource not accessible by integration" } };
      if (method === "POST" && path.endsWith("/actions/runs/102/rerun")) return { status: 201, body: {} };
      return undefined;
    });
    const outcomes = await execute(api, repo, plan([pull(1)]), timing({ waitMs: 25000 }));
    assert.deepEqual(outcomes[0]?.failed, [`${ci} run 101 (approve gave HTTP 403: Resource not accessible by integration, rerun gave HTTP 403: Resource not accessible by integration)`]);
    assert.deepEqual(outcomes[0]?.started, [`${security} run 102 (rerun, approve gave HTTP 403: Resource not accessible by integration)`]);
    assert.equal(exitCode(outcomes), 1);
    const lines = annotations(outcomes);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /^::error title=Queue::#1: GitHub holds \.github\/workflows\/ci\.yml run 101 \(approve gave HTTP 403/);
  });

  it("fails when GitHub makes no pull_request run on the new head in the wait time", async () => {
    const api = fakeApi(({ method, path }) => {
      if (method === "PUT") return { status: 202, body: {} };
      if (method === "GET" && path.endsWith("/pulls/1")) return { status: 200, body: { head: { sha: newHead } } };
      if (method === "GET" && path.includes("actions/runs?head_sha=")) return { status: 200, body: runsBody([]) };
      return undefined;
    });
    const time = timing({ waitMs: 15000 });
    const outcomes = await execute(api, repo, plan([pull(1)]), time);
    assert.equal(outcomes[0]?.result, "error");
    assert.match(outcomes[0]?.detail ?? "", /GitHub made no pull_request run on the new head in 15 s/);
    assert.deepEqual(time.slept, [5000, 5000, 5000]);
    assert.equal(exitCode(outcomes), 1);
  });

  it("a set of runs that grows until the end of the wait is a no read, and each run that came starts", async () => {
    let reads = 0;
    const api = fakeApi(({ method, path }) => {
      if (method === "PUT") return { status: 202, body: {} };
      if (method === "GET" && path.endsWith("/pulls/1")) return { status: 200, body: { head: { sha: newHead } } };
      if (method === "GET" && path.includes("actions/runs?head_sha=")) return { status: 200, body: runsBody([run(101, newHead), ...((reads += 1) >= 2 ? [run(102, newHead)] : [])]) };
      if (method === "POST") return { status: 201, body: {} };
      return undefined;
    });
    const outcomes = await execute(api, repo, plan([pull(1)]), timing({ waitMs: 15000 }));
    assert.equal(outcomes[0]?.result, "updated");
    assert.equal(outcomes[0]?.started.length, 2);
    assert.match(outcomes[0]?.noRead[0]?.why ?? "", /changed until the end of the wait/);
    assert.equal(exitCode(outcomes), 0);
  });

  it("starts the held runs of the head of a queued pull request that it does not update, with one read and no wait", async () => {
    const head = "5".repeat(40);
    const api = fakeApi(({ method, path }) => {
      if (method === "GET" && path.includes(`actions/runs?head_sha=${head}`)) return { status: 200, body: runsBody([run(301, head), run(302, head, { conclusion: "success" })]) };
      if (method === "GET" && path.includes("actions/runs?head_sha=")) return { status: 200, body: runsBody([]) };
      if (method === "POST" && path.endsWith("/actions/runs/301/approve")) return { status: 201, body: {} };
      return undefined;
    });
    const time = timing();
    const outcomes = await execute(api, repo, plan([pull(5, { mergeState: "BLOCKED" }), pull(7, { mergeState: "UNKNOWN" })]), time);
    assert.deepEqual(outcomes[0], { pull: 5, mergeState: "BLOCKED", result: "skipped", detail: "the merge state is BLOCKED, not BEHIND", started: [`${ci} run 301 (approved)`], failed: [], noRead: [] });
    assert.deepEqual(outcomes[1]?.noRead, [{ subject: "merge state", why: "GitHub did not compute the merge state" }]);
    assert.deepEqual(time.slept, []);
    assert.equal(exitCode(outcomes), 0);
  });

  it("passes when each update and each start passed, and a conflict alone does not fail the job", () => {
    const base: Omit<Outcome, "result" | "detail"> = { pull: 1, mergeState: "BEHIND", started: [`${ci} run 1 (approved)`], failed: [], noRead: [] };
    assert.equal(exitCode([{ ...base, result: "updated", detail: "" }, { ...base, pull: 2, result: "refused", detail: "", started: [] }, { ...base, pull: 3, result: "skipped", detail: "" }]), 0);
    assert.equal(exitCode([{ ...base, result: "error", detail: "" }]), 1);
    assert.equal(exitCode([{ ...base, result: "timeout", detail: "" }]), 1);
    assert.equal(exitCode([{ ...base, result: "updated", detail: "", failed: ["x"] }]), 1);
  });

  it("gives an error for an update that fails with a status other than 202 and 422", async () => {
    const api = fakeApi(({ method }) => (method === "PUT" ? { status: 403, body: { message: "refusing to allow a GitHub App to create or update workflow" } } : undefined));
    const outcomes = await execute(api, repo, plan([pull(1)]), timing());
    assert.equal(outcomes[0]?.result, "error");
    assert.match(outcomes[0]?.detail ?? "", /HTTP 403: refusing/);
    assert.equal(api.calls.length, 1);
  });

  it("gives an error for a failed read of the runs, and changes nothing more for that pull request", async () => {
    const api = fakeApi(({ method, path }) => {
      if (method === "PUT") return { status: 202, body: {} };
      if (method === "GET" && path.endsWith("/pulls/1")) return { status: 200, body: { head: { sha: newHead } } };
      if (method === "GET" && path.includes("actions/runs?head_sha=")) return { status: 502, body: { message: "Bad Gateway" } };
      return undefined;
    });
    const time = timing({ waitMs: 25000 });
    const outcomes = await execute(api, repo, plan([pull(1)]), time);
    assert.equal(outcomes[0]?.result, "error");
    assert.match(outcomes[0]?.detail ?? "", /cannot read the runs of fffffff: .*HTTP 502: Bad Gateway/);
    assert.deepEqual(time.slept, [5000, 5000]);
  });
});

describe("queue: the summary", () => {
  it("names the rules, each pull request, the started runs and each no read", () => {
    const text = summaryText({
      base: "main",
      required: ["CI OK", "Security OK"],
      strict: true,
      others: 4,
      outcomes: [
        { pull: 1, mergeState: "BEHIND", result: "updated", detail: "updated from 1111111 to fffffff", newSha: "f".repeat(40), started: [`${ci} run 101 (approved)`], failed: [`${security} run 102 (HTTP 403)`], noRead: [{ subject: `${ci} run 103`, why: "its actor is a-person" }] },
        { pull: 2, mergeState: "DIRTY", result: "skipped", detail: "a merge | conflict", started: [], failed: [], noRead: [] },
      ],
    });
    assert.ok(text.includes("The rules of main name the required checks CI OK and Security OK. Strict (a branch with the newest main): on."));
    assert.match(text, /2 pull requests with auto-merge\. 4 other open pull requests/);
    assert.ok(text.includes("| Pull request | Merge state | Result | Held runs started |"));
    assert.ok(text.includes(String.raw`| #1 | BEHIND | updated: updated from 1111111 to fffffff | \.github\/workflows\/ci\.yml run 101 \(approved\), not started: \.github\/workflows\/security\.yml run 102 \(HTTP 403\) |`));
    assert.ok(text.includes(String.raw`| #2 | DIRTY | skipped: a merge \| conflict | none |`));
    assert.ok(text.includes(String.raw`No read (never a pass):` + "\n\n" + String.raw`- #1 \.github\/workflows\/ci\.yml run 103: its actor is a\-person` + "\n"));
    assert.doesNotMatch(text, /strict off/);
  });

  /** The cells of a row of a GitHub Markdown table: a backslash escapes the next character, and each other pipe ends a cell. */
  function cells(row: string): string[] {
    const parts: string[] = [];
    let part = "";
    for (let index = 0; index < row.length; index += 1) {
      const char = row[index] ?? "";
      if (char === "\\") {
        part += char + (row[index + 1] ?? "");
        index += 1;
      } else if (char === "|") {
        parts.push(part.trim());
        part = "";
      } else part += char;
    }
    parts.push(part.trim());
    return parts.slice(1, -1).map((cell) => cell.replace(/\\(.)/g, "$1"));
  }

  it("keeps 4 cells in each row and the text of each part, when a part ends in a backslash or has a pipe or Markdown", () => {
    const outcome = (pull: number, detail: string, failed: string[] = []): Outcome => ({ pull, mergeState: "BEHIND", result: "error", detail, started: [], failed, noRead: [{ subject: "Odd `|` *check*", why: `why ${detail}` }] });
    const details = ["a path C:\\work\\", "a | b", "a \\| b", "**bold** `code` <b>x</b> [link](y)\nnext line"];
    const text = summaryText({ base: "release/v1", required: ["Odd `|` *check*"], strict: true, others: 0, outcomes: details.map((detail, index) => outcome(index + 1, detail, [`x.yml run 1 (HTTP 422: ${detail})`])) });
    const rows = text.split("\n").filter((line) => /^\| #\d/.test(line));
    assert.equal(rows.length, details.length);
    for (const [index, row] of rows.entries()) {
      const detail = (details[index] ?? "").replace(/\n/g, " ");
      assert.deepEqual(cells(row), [`#${String(index + 1)}`, "BEHIND", `error: ${detail}`, `not started: x.yml run 1 (HTTP 422: ${detail})`], row);
    }
    // Each no read is one line of the list, and its parts start no Markdown
    assert.ok(text.includes(String.raw`- #1 Odd \`\|\` \*check\*: why a path C\:\\work\\` + "\n"));
    assert.ok(text.includes(String.raw`The rules of release\/v1 name the required checks Odd \`\|\` \*check\*.`));
    assert.doesNotMatch(text, /\n {0,3}next line/);
  });

  it("encodes each annotation as one workflow command", () => {
    const lines = annotations([{ pull: 1, mergeState: "BEHIND", result: "error", detail: "100% failed\r\n::error::x", started: [], failed: ["a.yml run 7 (50%)"], noRead: [{ subject: "C\nD", why: "w" }] }]);
    assert.deepEqual(lines, ["::error title=Queue::#1: 100%25 failed%0D%0A::error::x", "::error title=Queue::#1: GitHub holds a.yml run 7 (50%25), and the queue cannot start it", "::warning title=Queue no read::#1 C%0AD: w"]);
  });

  it("tells that the queue updates no branch with strict off", () => {
    const text = summaryText({ base: "main", required: [], strict: false, others: 0, outcomes: [] });
    assert.match(text, /name no required check\. Strict .*: off\./);
    assert.match(text, /With strict off, GitHub merges a pull request that is behind, so no pull request is BEHIND and the queue updates no branch/);
  });
});

describe("queue: the step", () => {
  /** A fetch of the API of one repository: one behind pull request #5 whose head changes at once, with one held run. */
  function repositoryFetch(rulesStatus = 200): { fetcher: Fetch; requests: string[] } {
    const requests: string[] = [];
    const head = "e".repeat(40);
    const fetcher: Fetch = async (url, init) => {
      requests.push(`${init.method} ${url}`);
      const json = (status: number, body: unknown) => ({ status, text: async () => (body === null ? "" : JSON.stringify(body)) });
      if (url.endsWith("/graphql")) return json(200, { data: page([pull(5), pull(6, { autoMerge: false })]) });
      if (url.includes("/rules/branches/main")) return rulesStatus === 200 ? json(200, [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "CI OK" }] } }]) : json(rulesStatus, { message: "Server Error" });
      if (url.endsWith("/pulls/5/update-branch")) return json(202, { message: "Updating pull request branch." });
      if (url.endsWith("/pulls/5")) return json(200, { head: { sha: head } });
      if (url.includes(`/actions/runs?head_sha=${head}&event=pull_request`)) return json(200, runsBody([run(901, head)]));
      if (url.endsWith("/actions/runs/901/approve")) return json(201, {});
      return json(404, { message: "Not Found" });
    };
    return { fetcher, requests };
  }

  const env = (summary: string): NodeJS.ProcessEnv => ({ GITHUB_REPOSITORY: repo, GITHUB_API_URL: "https://api.example", GH_TOKEN: "t", BASE: "main", WAIT_SECONDS: "30", GITHUB_STEP_SUMMARY: summary });

  it("updates the behind pull request, starts its held run and writes the summary", async () => {
    const folder = mkdtempSync(join(tmpdir(), "queue-"));
    try {
      const summary = join(folder, "summary.md");
      const { fetcher, requests } = repositoryFetch();
      const code = await main(env(summary), fetcher, async () => undefined);
      assert.equal(code, 0);
      assert.ok(requests.includes(`PUT https://api.example/repos/${repo}/pulls/5/update-branch`));
      assert.ok(requests.includes(`POST https://api.example/repos/${repo}/actions/runs/901/approve`));
      assert.ok(requests.includes("POST https://api.example/graphql"));
      const text = readFileSync(summary, "utf8");
      assert.ok(text.includes(String.raw`| #5 | BEHIND | updated: updated from 5555555 to eeeeeee | \.github\/workflows\/ci\.yml run 901 \(approved\) |`));
      assert.match(text, /1 other open pull requests/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("changes nothing and fails when a read fails, because a no read is never a pass", async () => {
    const { fetcher, requests } = repositoryFetch(500);
    assert.equal(await main(env(""), fetcher, async () => undefined), 1);
    assert.ok(requests.every((request) => request.startsWith("GET ")));
  });

  it("refuses a repository name or a wait that is not valid", async () => {
    const { fetcher } = repositoryFetch();
    assert.equal(await main({ ...env(""), GITHUB_REPOSITORY: "" }, fetcher, async () => undefined), 1);
    assert.equal(await main({ ...env(""), WAIT_SECONDS: "900" }, fetcher, async () => undefined), 1);
  });

  it("the API throws for a GraphQL error", async () => {
    const fetcher: Fetch = async () => ({ status: 200, text: async () => JSON.stringify({ errors: [{ message: "Field 'x' doesn't exist" }] }) });
    await assert.rejects(githubApi(fetcher, { api: "a", graphql: "g", token: "t" }).graphql("{}", {}), /GraphQL API gave errors: Field 'x' doesn't exist/);
  });
});

describe("queue: the workflows", () => {
  const caller = readFileSync(join(root, ".github/workflows/queue.yml"), "utf8");
  const shared = readFileSync(join(root, ".github/workflows/reusable-queue.yml"), "utf8");

  it("the caller starts on a push to main, on auto-merge and by hand, with one group that does not cancel", () => {
    assert.match(caller, /\non:\n(?:\s*#.*\n)*\s+push:\n\s+branches: \[main\]\n/);
    assert.match(caller, /\n\s+pull_request:\n\s+types: \[auto_merge_enabled\]\n/);
    assert.match(caller, /\n\s+workflow_dispatch:\n/);
    assert.match(caller, /\nconcurrency:\n\s+group: queue\n\s+cancel-in-progress: false\n/);
    assert.match(caller, /uses: \.\/\.github\/workflows\/reusable-queue\.yml\n/);
    for (const text of [caller, shared]) assert.doesNotMatch(text, /pull_request_target|merge_group/);
  });

  it("the job has only the permissions that it needs, and each action is pinned to a full commit", () => {
    const permissions = /\n {4}permissions:\n((?: {6}[\w-]+: \w+\n)+)/;
    for (const text of [caller, shared]) {
      const block = permissions.exec(text)?.[1] ?? "";
      assert.deepEqual(block.trim().split(/\n\s*/).sort(), ["actions: write", "contents: write", "pull-requests: write"]);
    }
    const uses = [...shared.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((match) => match[1] ?? "");
    assert.ok(uses.length > 0);
    for (const use of uses) assert.match(use, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    assert.match(shared, /run: node \.queue-template\/scripts\/workflows\/queue\.ts\n/);
    assert.match(shared, /node-version: "24"/);
  });

  it("the job starts in a private repository only when the input private is true, and the input is false by default", () => {
    assert.match(shared, /\n {6}private:\n {8}description: >-\n(?: {10}.*\n)+ {8}type: boolean\n {8}default: false\n/);
    const condition = /\n {4}if: >-\n((?: {6}.*\n)+)/.exec(shared)?.[1]?.replace(/\s+/g, " ").trim();
    assert.equal(condition, "(github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) && (!github.event.repository.private || inputs.private)");
    // The caller of the template is public, so it does not set the input
    assert.doesNotMatch(caller, /private:/);
  });

  it("installs the version of @mark1russell7/text that pnpm-lock.yaml of the template gives, so a bump of the lockfile also moves the install", () => {
    // The install goes to the folder of the script: the sparse checkout also has the root package.json of the template
    assert.match(shared, /\n {10}path: \.queue-template\n {10}sparse-checkout: \|\n {12}scripts\/workflows\n {12}\.github\/actions\/pull-of-run\n/);
    const run = [
      'version="$(node .queue-template/.github/actions/pull-of-run/locked-version.ts .queue-template/pnpm-lock.yaml @mark1russell7/text)"',
      'npm install --no-save --no-package-lock --ignore-scripts --prefix .queue-template/scripts/workflows "@mark1russell7/text@${version}"',
    ];
    const install = shared.indexOf(`run: |\n          ${run[0]}\n          ${run[1]}\n`);
    assert.ok(install > 0);
    assert.ok(install < shared.indexOf("run: node .queue-template/scripts/workflows/queue.ts"));
    assert.doesNotMatch(shared, /TEXT_VERSION/);
  });
});
