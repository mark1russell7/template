// Tests of the queue (scripts/workflows/queue.ts, CI.md "The queue"). Start them with "pnpm test:workflows". The API is a
// fake, so the tests use no network and do not wait.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTIONS_APP,
  type Api,
  type ApiResponse,
  type Fetch,
  type GateRun,
  type InflightWorkflow,
  type Outcome,
  type PullState,
  type Timing,
  annotations,
  execute,
  exitCode,
  gateWorkflows,
  githubApi,
  jobChecks,
  main,
  plan,
  queued,
  readGateRuns,
  readInflight,
  readSettledPulls,
  requiredChecks,
  runQueue,
  summaryText,
} from "./queue.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

const ci = { id: 10, path: ".github/workflows/ci.yml" };
const security = { id: 20, path: ".github/workflows/security.yml" };

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

describe("queue: the plan", () => {
  it("takes only the pull requests with auto-merge, not drafts and not from a fork", () => {
    assert.equal(queued(pull(1)), true);
    assert.equal(queued(pull(1, { autoMerge: false })), false);
    assert.equal(queued(pull(1, { draft: true })), false);
    assert.equal(queued(pull(1, { fork: true })), false);
  });

  it("updates each pull request that is BEHIND, with its head as expected_head_sha, and skips the other states", () => {
    const pulls = [pull(3), pull(1, { autoMerge: false }), pull(2, { draft: true }), pull(4, { fork: true }), pull(5, { mergeState: "CLEAN" }), pull(6, { mergeState: "DIRTY" }), pull(7, { mergeState: "UNKNOWN" }), pull(8)];
    const runs = new Map<number, GateRun[]>([[3, [{ check: "CI OK", appId: ACTIONS_APP, workflow: ci }]]]);
    const actions = plan(pulls, ["CI OK"], runs);
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
    assert.deepEqual(actions[0], { kind: "update", pull: 3, mergeState: "BEHIND", ref: "branch-3", expectedHeadSha: "3".repeat(40), dispatch: [{ workflowId: 10, path: ci.path, checks: ["CI OK"] }], noRead: [] });
    assert.deepEqual(actions[1], { kind: "skip", pull: 5, mergeState: "CLEAN", why: "the merge state is CLEAN, not BEHIND", noRead: false });
    assert.match(actions[2]?.kind === "skip" ? actions[2].why : "", /merge conflict/);
    assert.deepEqual(actions[3], { kind: "skip", pull: 7, mergeState: "UNKNOWN", why: "GitHub did not compute the merge state", noRead: true });
    // Each behind pull request gets its turn, also with no check run read: its required check is a no read
    assert.deepEqual(actions[4]?.kind === "update" ? actions[4].noRead : [], [{ check: "CI OK", why: "no check run on the old head 8888888" }]);
  });

  it("joins the checks of one workflow, and a check with no workflow to start is a no read, never a pass", () => {
    const runs: GateRun[] = [
      { check: "CI OK", appId: ACTIONS_APP, workflow: ci },
      { check: "Faults OK", appId: ACTIONS_APP, workflow: ci },
      { check: "Security OK", appId: ACTIONS_APP, workflow: security },
      { check: "Other OK", appId: 999, workflow: null },
      { check: "Dynamic OK", appId: ACTIONS_APP, workflow: { id: 30, path: "dynamic/github-code-scanning/codeql" } },
      { check: "Lost OK", appId: ACTIONS_APP, workflow: null },
    ];
    const required = ["Security OK", "CI OK", "Faults OK", "Missing OK", "Other OK", "Dynamic OK", "Lost OK"];
    const { dispatch, noRead } = gateWorkflows(required, runs, "a".repeat(40));
    assert.deepEqual(dispatch, [
      { workflowId: 10, path: ci.path, checks: ["CI OK", "Faults OK"] },
      { workflowId: 20, path: security.path, checks: ["Security OK"] },
    ]);
    assert.deepEqual(noRead, [
      { check: "Missing OK", why: "no check run on the old head aaaaaaa" },
      { check: "Other OK", why: "the check run comes from the app 999, not from GitHub Actions" },
      { check: "Dynamic OK", why: "its workflow dynamic/github-code-scanning/codeql is not a file of the repository" },
      { check: "Lost OK", why: "the API gives no workflow run for its check suite" },
    ]);
  });

  it("a workflow in progress with a job of the check name gives a check that has no check run yet", () => {
    const inflight: InflightWorkflow[] = [
      { id: 10, path: ci.path, checks: ["ci", "CI OK", "checks (${{ matrix.os }})"] },
      { id: 40, path: ".github/workflows/pages.yml", checks: ["build", "deploy"] },
    ];
    const runs: GateRun[] = [{ check: "Security OK", appId: ACTIONS_APP, workflow: security }];
    const { dispatch, noRead } = gateWorkflows(["CI OK", "Security OK", "Faults OK"], runs, "b".repeat(40), inflight);
    assert.deepEqual(dispatch, [
      { workflowId: 10, path: ci.path, checks: ["CI OK"] },
      { workflowId: 20, path: security.path, checks: ["Security OK"] },
    ]);
    // The workflow in progress gives no pass for a check that none of its jobs has
    assert.deepEqual(noRead, [{ check: "Faults OK", why: "no check run on the old head bbbbbbb, and no workflow in progress on it has a job of this name" }]);
  });

  it("a workflow in progress whose file the queue cannot read makes a no read, never a pass", () => {
    const inflight: InflightWorkflow[] = [
      { id: 10, path: ci.path, checks: null },
      { id: 30, path: ".github/workflows/faults.yml", checks: null },
    ];
    assert.deepEqual(gateWorkflows(["CI OK"], [], "c".repeat(40), inflight), {
      dispatch: [],
      noRead: [{ check: "CI OK", why: "no check run on the old head ccccccc, and the queue cannot read the file of the workflows in progress .github/workflows/ci.yml and .github/workflows/faults.yml" }],
    });
    const mixed = gateWorkflows(["CI OK"], [], "c".repeat(40), [{ id: 40, path: ".github/workflows/pages.yml", checks: ["build"] }, ...inflight.slice(0, 1)]);
    assert.match(mixed.noRead[0]?.why ?? "", /no workflow in progress on it has a job of this name, and the queue cannot read the file of the workflows in progress \.github\/workflows\/ci\.yml$/);
    // Two workflows that both have the job each start
    const both = gateWorkflows(["CI OK"], [], "c".repeat(40), [
      { id: 10, path: ci.path, checks: ["CI OK"] },
      { id: 30, path: ".github/workflows/faults.yml", checks: ["CI OK"] },
    ]);
    assert.deepEqual(
      both.dispatch.map((each) => each.workflowId),
      [10, 30],
    );
    assert.deepEqual(both.noRead, []);
  });

  it("reads the check name of each job: its name, else its id, and not the names of steps or of the workflow", () => {
    const text = [
      "name: CI",
      "on:",
      "  push:",
      "jobs:",
      "  # a comment",
      "  ci:",
      "    uses: owner/repo/.github/workflows/reusable-ci.yml@0123 # main",
      "",
      "  ci-ok:",
      '    name: "CI OK" # the summary',
      "    needs: [ci]",
      "    steps:",
      "      - name: Not a job",
      "        run: echo",
      "  security-ok:",
      "    name: 'It''s OK'",
      "  plain:",
      "    name: Plain name # a comment",
      "  matrix:",
      "    name: checks (${{ matrix.os }})",
      "    strategy:",
      "      matrix:",
      "        name: [a]",
      "env:",
      "  name: not a job",
    ].join("\n");
    assert.deepEqual(jobChecks(text), ["ci", "CI OK", "It's OK", "Plain name", "checks (${{ matrix.os }})"]);
    assert.deepEqual(jobChecks("name: x\non: push\n"), []);
    // Windows line ends and a tab before a comment
    assert.deepEqual(jobChecks("jobs:\r\n  a-b:\r\n    name: \"A \\\"B\\\"\"\r\n  c:\t# c\r\n    runs-on: x\r\n"), ['A "B"', "c"]);
  });

  it("reads the required checks of each ruleset one time, and strict when one rule asks for it", () => {
    const rules = [
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "Actions OK", integration_id: ACTIONS_APP }] } },
      { type: "pull_request", parameters: {} },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "CI OK" }, { context: "Actions OK" }, { context: "Security OK" }] } },
    ];
    assert.deepEqual(requiredChecks(rules), { checks: ["Actions OK", "CI OK", "Security OK"], strict: true });
    assert.deepEqual(requiredChecks([]), { checks: [], strict: false });
  });
});

describe("queue: the reads", () => {
  it("reads the pull requests again while a queued one is UNKNOWN, and reads each page", async () => {
    const api = fakeApi(() => undefined, [page([pull(1, { mergeState: "UNKNOWN" })], "c1"), page([pull(2, { autoMerge: false, mergeState: "UNKNOWN" })]), page([pull(1)], "c2"), page([pull(2, { autoMerge: false, mergeState: "UNKNOWN" })])]);
    const time = timing();
    const pulls = await readSettledPulls(api, "owner/repo", "main", time);
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
    const pulls = await readSettledPulls(api, "owner/repo", "main", time);
    assert.equal(pulls[0]?.mergeState, "UNKNOWN");
    assert.equal(api.queries.length, 3);
    assert.deepEqual(time.slept, [5000, 5000]);
  });

  it("maps each check run to the workflow of its check suite, and reads each suite one time", async () => {
    const api = fakeApi(({ path }) => {
      if (path.includes("check_name=CI%20OK")) return { status: 200, body: { check_runs: [{ name: "CI OK", app: { id: ACTIONS_APP }, check_suite: { id: 7 } }, { name: "CI OK", app: { id: 999 }, check_suite: { id: 9 } }] } };
      if (path.includes("check_name=Faults%20OK")) return { status: 200, body: { check_runs: [{ name: "Faults OK", app: { id: ACTIONS_APP }, check_suite: { id: 7 } }] } };
      if (path.includes("check_name=Security%20OK")) return { status: 200, body: { check_runs: [{ name: "Security OK", app: { id: ACTIONS_APP }, check_suite: { id: 8 } }] } };
      if (path.endsWith("check_suite_id=7&per_page=1")) return { status: 200, body: { workflow_runs: [{ workflow_id: 10, path: ".github/workflows/ci.yml" }] } };
      if (path.endsWith("check_suite_id=8&per_page=1")) return { status: 200, body: { workflow_runs: [{ workflow_id: 20, path: ".github/workflows/security.yml@refs/heads/main" }] } };
      return undefined;
    });
    const runs = await readGateRuns(api, "owner/repo", "abc", ["CI OK", "Faults OK", "Security OK"]);
    assert.deepEqual(runs, [
      { check: "CI OK", appId: ACTIONS_APP, workflow: ci },
      { check: "CI OK", appId: 999, workflow: null },
      { check: "Faults OK", appId: ACTIONS_APP, workflow: ci },
      { check: "Security OK", appId: ACTIONS_APP, workflow: security },
    ]);
    assert.equal(api.calls.filter((call) => call.path.includes("check_suite_id=7")).length, 1);
    assert.ok(api.calls.every((call) => call.method === "GET"));
    assert.equal(api.calls[0]?.path, "repos/owner/repo/commits/abc/check-runs?check_name=CI%20OK&filter=latest&per_page=100");
  });

  it("reads the workflows in progress on a commit, and the file of each one time at that commit", async () => {
    const file = (text: string) => ({ status: 200, body: { encoding: "base64", content: Buffer.from(text).toString("base64") } });
    const api = fakeApi(({ path }) => {
      if (path.startsWith("repos/owner/repo/actions/runs?head_sha=abc&per_page=100&page=1"))
        return {
          status: 200,
          body: {
            total_count: 6,
            workflow_runs: [
              { workflow_id: 10, path: ".github/workflows/ci.yml", status: "in_progress" },
              { workflow_id: 10, path: ".github/workflows/ci.yml", status: "queued" },
              { workflow_id: 20, path: ".github/workflows/security.yml", status: "completed" },
              { workflow_id: 30, path: "dynamic/github-code-scanning/codeql", status: "in_progress" },
              { workflow_id: 40, path: ".github/workflows/odd name.yml@refs/heads/main", status: "waiting" },
              { workflow_id: 50, path: ".github/workflows/gone.yml", status: "requested" },
            ],
          },
        };
      if (path === "repos/owner/repo/contents/.github/workflows/ci.yml?ref=abc") return file("jobs:\n  ci-ok:\n    name: CI OK\n");
      if (path === "repos/owner/repo/contents/.github/workflows/odd%20name.yml?ref=abc") return file("jobs:\n  odd:\n    runs-on: x\n");
      if (path === "repos/owner/repo/contents/.github/workflows/gone.yml?ref=abc") return { status: 404, body: { message: "Not Found" } };
      return undefined;
    });
    assert.deepEqual(await readInflight(api, "owner/repo", "abc"), [
      { id: 10, path: ".github/workflows/ci.yml", checks: ["CI OK"] },
      { id: 40, path: ".github/workflows/odd name.yml", checks: ["odd"] },
      { id: 50, path: ".github/workflows/gone.yml", checks: null },
    ]);
    assert.equal(api.calls.filter((call) => call.path.includes("/contents/.github/workflows/ci.yml")).length, 1);
    assert.ok(api.calls.every((call) => call.method === "GET"));
  });

  it("reads each page of the workflow runs, and throws when a read of the runs fails", async () => {
    const run = (id: number) => ({ workflow_id: id, path: `.github/workflows/w${String(id)}.yml`, status: id === 150 ? "in_progress" : "completed" });
    const api = fakeApi(({ path }) => {
      if (path.endsWith("&page=1")) return { status: 200, body: { total_count: 150, workflow_runs: Array.from({ length: 100 }, (_, index) => run(index + 1)) } };
      if (path.endsWith("&page=2")) return { status: 200, body: { total_count: 150, workflow_runs: Array.from({ length: 50 }, (_, index) => run(index + 101)) } };
      if (path.includes("/contents/")) return { status: 200, body: { encoding: "base64", content: Buffer.from("jobs:\n  last:\n    name: Last\n").toString("base64") } };
      return undefined;
    });
    assert.deepEqual(await readInflight(api, "owner/repo", "abc"), [{ id: 150, path: ".github/workflows/w150.yml", checks: ["Last"] }]);
    assert.equal(api.calls.filter((call) => call.path.includes("/actions/runs")).length, 2);
    await assert.rejects(readInflight(fakeApi(() => ({ status: 403, body: { message: "Resource not accessible by integration" } })), "owner/repo", "abc"), /HTTP 403/);
  });

  it("reads the workflows in progress only for a pull request with a required check that has no check run", async () => {
    const api = fakeApi(
      ({ method, path }) => {
        if (path.startsWith("repos/owner/repo/rules/branches/main")) return { status: 200, body: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "CI OK" }, { context: "Security OK" }] } }] };
        if (path.includes("/commits/1111111111111111111111111111111111111111/check-runs?check_name=Security%20OK")) return { status: 200, body: { check_runs: [{ name: "Security OK", app: { id: ACTIONS_APP }, check_suite: { id: 8 } }] } };
        if (path.includes("/commits/1111111111111111111111111111111111111111/check-runs?check_name=CI%20OK")) return { status: 200, body: { check_runs: [] } };
        if (path.includes("/commits/2222222222222222222222222222222222222222/check-runs")) return { status: 200, body: { check_runs: [{ name: path.includes("CI%20OK") ? "CI OK" : "Security OK", app: { id: ACTIONS_APP }, check_suite: { id: path.includes("CI%20OK") ? 7 : 8 } }] } };
        if (path.endsWith("check_suite_id=7&per_page=1")) return { status: 200, body: { workflow_runs: [{ workflow_id: 10, path: ci.path }] } };
        if (path.endsWith("check_suite_id=8&per_page=1")) return { status: 200, body: { workflow_runs: [{ workflow_id: 20, path: security.path }] } };
        if (path.startsWith("repos/owner/repo/actions/runs?head_sha=1111111111111111111111111111111111111111")) return { status: 200, body: { total_count: 1, workflow_runs: [{ workflow_id: 10, path: ci.path, status: "in_progress" }] } };
        if (path.startsWith("repos/owner/repo/contents/.github/workflows/ci.yml?ref=1111111111111111111111111111111111111111")) return { status: 200, body: { encoding: "base64", content: Buffer.from("jobs:\n  ci-ok:\n    name: CI OK\n").toString("base64") } };
        if (method === "PUT") return { status: 202, body: {} };
        if (method === "GET" && /\/pulls\/\d$/.test(path)) return { status: 200, body: { head: { sha: "f".repeat(40) } } };
        if (method === "POST") return { status: 204, body: null };
        return undefined;
      },
      [page([pull(1), pull(2)])],
    );
    const report = await runQueue(api, { repository: "owner/repo", base: "main", timing: timing() });
    assert.deepEqual(
      report.outcomes.map((outcome) => [outcome.pull, outcome.result, outcome.started, outcome.noRead]),
      [
        [1, "updated", [ci.path, security.path], []],
        [2, "updated", [ci.path, security.path], []],
      ],
    );
    // Pull request #2 has a check run of each required check, so the queue does not read its workflow runs
    assert.equal(api.calls.filter((call) => call.path.includes("actions/runs?head_sha=")).length, 1);
  });

  it("a failed read throws, so the queue changes nothing", async () => {
    const api = fakeApi(() => ({ status: 403, body: { message: "Resource not accessible by integration" } }));
    await assert.rejects(readGateRuns(api, "owner/repo", "abc", ["CI OK"]), /HTTP 403: Resource not accessible by integration/);
  });
});

describe("queue: the actions", () => {
  /** The API of three behind pull requests: #1 updates and its head changes at the second read, #2 has a conflict, #3 never changes. */
  function threePulls(): { api: ReturnType<typeof fakeApi>; actions: ReturnType<typeof plan> } {
    let reads = 0;
    const api = fakeApi(({ method, path }) => {
      if (method === "PUT" && path.endsWith("/pulls/1/update-branch")) return { status: 202, body: { message: "Updating pull request branch." } };
      if (method === "PUT" && path.endsWith("/pulls/2/update-branch")) return { status: 422, body: { message: "merge conflict between base and head" } };
      if (method === "PUT" && path.endsWith("/pulls/3/update-branch")) return { status: 202, body: {} };
      if (method === "GET" && path.endsWith("/pulls/1")) return { status: 200, body: { head: { sha: (reads += 1) >= 2 ? "f".repeat(40) : "1".repeat(40) } } };
      if (method === "GET" && path.endsWith("/pulls/3")) return { status: 200, body: { head: { sha: "3".repeat(40) } } };
      if (method === "POST" && path.endsWith("/actions/workflows/10/dispatches")) return { status: 204, body: null };
      if (method === "POST" && path.endsWith("/actions/workflows/20/dispatches")) return { status: 422, body: { message: "Workflow does not have 'workflow_dispatch' trigger" } };
      return undefined;
    });
    const gates: GateRun[] = [
      { check: "CI OK", appId: ACTIONS_APP, workflow: ci },
      { check: "Security OK", appId: ACTIONS_APP, workflow: security },
    ];
    const actions = plan([pull(2), pull(1), pull(3)], ["CI OK", "Security OK"], new Map([1, 2, 3].map((number) => [number, gates])));
    return { api, actions };
  }

  it("updates each behind pull request, waits for the new heads, and starts the gates only on a new head", async () => {
    const { api, actions } = threePulls();
    const time = timing({ waitMs: 15000 });
    const outcomes = await execute(api, "owner/repo", actions, time);
    const one = outcomes.find((outcome) => outcome.pull === 1);
    assert.equal(one?.result, "updated");
    assert.equal(one?.newSha, "f".repeat(40));
    assert.deepEqual(one?.started, [ci.path]);
    assert.deepEqual(one?.failed, [`${security.path} (HTTP 422: Workflow does not have 'workflow_dispatch' trigger)`]);
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
    // The update names the head that the queue read, and the dispatch names the branch of the pull request
    assert.deepEqual(
      api.calls.filter((call) => call.method === "PUT").map((call) => [call.path, call.body]),
      [
        ["repos/owner/repo/pulls/1/update-branch", { expected_head_sha: "1".repeat(40) }],
        ["repos/owner/repo/pulls/2/update-branch", { expected_head_sha: "2".repeat(40) }],
        ["repos/owner/repo/pulls/3/update-branch", { expected_head_sha: "3".repeat(40) }],
      ],
    );
    const dispatched = api.calls.filter((call) => call.method === "POST");
    assert.deepEqual(
      dispatched.map((call) => [call.path, call.body]),
      [
        ["repos/owner/repo/actions/workflows/10/dispatches", { ref: "branch-1" }],
        ["repos/owner/repo/actions/workflows/20/dispatches", { ref: "branch-1" }],
      ],
    );
    // One wait for all the heads, never longer than the limit
    assert.deepEqual(time.slept, [5000, 5000, 5000]);
    assert.equal(exitCode(outcomes), 1);
  });

  it("passes when each update and each dispatch passed, and a conflict alone does not fail the job", () => {
    const base: Omit<Outcome, "result" | "detail"> = { pull: 1, mergeState: "BEHIND", started: [ci.path], failed: [], noRead: [] };
    assert.equal(exitCode([{ ...base, result: "updated", detail: "" }, { ...base, pull: 2, result: "refused", detail: "", started: [] }, { ...base, pull: 3, result: "skipped", detail: "" }]), 0);
    assert.equal(exitCode([{ ...base, result: "error", detail: "" }]), 1);
    assert.equal(exitCode([{ ...base, result: "timeout", detail: "" }]), 1);
  });

  it("gives an error for an update that fails with a status other than 202 and 422", async () => {
    const api = fakeApi(({ method }) => (method === "PUT" ? { status: 403, body: { message: "refusing to allow a GitHub App to create or update workflow" } } : undefined));
    const outcomes = await execute(api, "owner/repo", plan([pull(1)], [], new Map()), timing());
    assert.equal(outcomes[0]?.result, "error");
    assert.match(outcomes[0]?.detail ?? "", /HTTP 403: refusing/);
    assert.equal(api.calls.length, 1);
  });

  it("gives a no read for a merge state that GitHub did not compute", async () => {
    const outcomes = await execute(fakeApi(() => undefined), "owner/repo", plan([pull(1, { mergeState: "UNKNOWN" })], ["CI OK"], new Map()), timing());
    assert.deepEqual(outcomes[0]?.noRead, [{ check: "merge state", why: "GitHub did not compute the merge state" }]);
    assert.equal(outcomes[0]?.result, "skipped");
  });
});

describe("queue: the summary", () => {
  it("names the rules, each pull request, the started workflows and each no read", () => {
    const text = summaryText({
      base: "main",
      required: ["CI OK", "Security OK"],
      strict: true,
      others: 4,
      outcomes: [
        { pull: 1, mergeState: "BEHIND", result: "updated", detail: "updated from 1111111 to fffffff", newSha: "f".repeat(40), started: [ci.path], failed: ["x.yml (HTTP 422)"], noRead: [{ check: "Faults OK", why: "no check run on the old head 1111111" }] },
        { pull: 2, mergeState: "DIRTY", result: "skipped", detail: "a merge | conflict", started: [], failed: [], noRead: [] },
      ],
    });
    assert.ok(text.includes("The rules of main name the required checks CI OK and Security OK. Strict (a branch with the newest main): on."));
    assert.match(text, /2 pull requests with auto-merge\. 4 other open pull requests/);
    assert.ok(text.includes(String.raw`| #1 | BEHIND | updated: updated from 1111111 to fffffff | \.github\/workflows\/ci\.yml, refused: x\.yml \(HTTP 422\) |`));
    assert.ok(text.includes(String.raw`| #2 | DIRTY | skipped: a merge \| conflict | none |`));
    assert.ok(text.includes("No read (never a pass):\n\n- #1 Faults OK: no check run on the old head 1111111\n"));
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
    const outcome = (pull: number, detail: string, failed: string[] = []): Outcome => ({ pull, mergeState: "BEHIND", result: "error", detail, started: [], failed, noRead: [{ check: "Odd `|` *check*", why: `why ${detail}` }] });
    const details = ["a path C:\\work\\", "a | b", "a \\| b", "**bold** `code` <b>x</b> [link](y)\nnext line"];
    const text = summaryText({ base: "release/v1", required: ["Odd `|` *check*"], strict: true, others: 0, outcomes: details.map((detail, index) => outcome(index + 1, detail, [`x.yml (HTTP 422: ${detail})`])) });
    const rows = text.split("\n").filter((line) => /^\| #\d/.test(line));
    assert.equal(rows.length, details.length);
    for (const [index, row] of rows.entries()) {
      const detail = (details[index] ?? "").replace(/\n/g, " ");
      assert.deepEqual(cells(row), [`#${String(index + 1)}`, "BEHIND", `error: ${detail}`, `refused: x.yml (HTTP 422: ${detail})`], row);
    }
    // Each no read is one line of the list, and its parts start no Markdown
    assert.ok(text.includes(String.raw`- #1 Odd \`\|\` \*check\*: why a path C\:\\work\\` + "\n"));
    assert.ok(text.includes(String.raw`The rules of release\/v1 name the required checks Odd \`\|\` \*check\*.`));
    assert.doesNotMatch(text, /\n {0,3}next line/);
  });

  it("encodes each annotation as one workflow command", () => {
    const lines = annotations([{ pull: 1, mergeState: "BEHIND", result: "error", detail: "100% failed\r\n::error::x", started: [], failed: ["a.yml (50%)"], noRead: [{ check: "C\nD", why: "w" }] }]);
    assert.deepEqual(lines, ["::error title=Queue::#1: 100%25 failed%0D%0A::error::x", "::error title=Queue::#1: workflow_dispatch refused a.yml (50%25)", "::warning title=Queue no read::#1 C%0AD: w"]);
  });

  it("tells that the queue changes nothing with strict off", () => {
    const text = summaryText({ base: "main", required: [], strict: false, others: 0, outcomes: [] });
    assert.match(text, /name no required check\. Strict .*: off\./);
    assert.match(text, /With strict off, GitHub merges a pull request that is behind, so no pull request is BEHIND/);
  });
});

describe("queue: the step", () => {
  /** A fetch of the API of one repository: one behind pull request #5 whose head changes at once. */
  function repositoryFetch(rulesStatus = 200): { fetcher: Fetch; requests: string[] } {
    const requests: string[] = [];
    const fetcher: Fetch = async (url, init) => {
      requests.push(`${init.method} ${url}`);
      const json = (status: number, body: unknown) => ({ status, text: async () => (body === null ? "" : JSON.stringify(body)) });
      if (url.endsWith("/graphql")) return json(200, { data: page([pull(5), pull(6, { autoMerge: false })]) });
      if (url.includes("/rules/branches/main")) return rulesStatus === 200 ? json(200, [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "CI OK" }] } }]) : json(rulesStatus, { message: "Server Error" });
      if (url.includes("/check-runs?check_name=CI%20OK")) return json(200, { check_runs: [{ name: "CI OK", app: { id: ACTIONS_APP }, check_suite: { id: 7 } }] });
      if (url.includes("check_suite_id=7")) return json(200, { workflow_runs: [{ workflow_id: 10, path: ci.path }] });
      if (url.endsWith("/pulls/5/update-branch")) return json(202, { message: "Updating pull request branch." });
      if (url.endsWith("/pulls/5")) return json(200, { head: { sha: "e".repeat(40) } });
      if (url.endsWith("/actions/workflows/10/dispatches")) return json(204, null);
      return json(404, { message: "Not Found" });
    };
    return { fetcher, requests };
  }

  const env = (summary: string): NodeJS.ProcessEnv => ({ GITHUB_REPOSITORY: "owner/repo", GITHUB_API_URL: "https://api.example", GH_TOKEN: "t", BASE: "main", WAIT_SECONDS: "10", GITHUB_STEP_SUMMARY: summary });

  it("updates the behind pull request, starts its gate and writes the summary", async () => {
    const folder = mkdtempSync(join(tmpdir(), "queue-"));
    try {
      const summary = join(folder, "summary.md");
      const { fetcher, requests } = repositoryFetch();
      const code = await main(env(summary), fetcher, async () => undefined);
      assert.equal(code, 0);
      assert.ok(requests.includes("PUT https://api.example/repos/owner/repo/pulls/5/update-branch"));
      assert.ok(requests.includes("POST https://api.example/repos/owner/repo/actions/workflows/10/dispatches"));
      assert.ok(requests.includes("POST https://api.example/graphql"));
      const text = readFileSync(summary, "utf8");
      assert.ok(text.includes(String.raw`| #5 | BEHIND | updated: updated from 5555555 to eeeeeee | \.github\/workflows\/ci\.yml |`));
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
      assert.deepEqual(block.trim().split(/\n\s*/).sort(), ["actions: write", "checks: read", "contents: write", "pull-requests: write"]);
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

  it("installs the version of @mark1russell7/text that pnpm-lock.yaml of the template resolves, so a bump of the lockfile cannot leave the workflow behind", () => {
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    // pnpm 12 writes two documents: the root importer of the second one has the devDependencies
    const locked = [...lock.matchAll(/\nimporters:\n\n {2}\.:\n([\s\S]*?)(?:\n\n|$)/g)]
      .map((match) => /\n {6}'@mark1russell7\/text':\n {8}specifier: \S+\n {8}version: ([^\s(]+)/.exec(`\n${match[1] ?? ""}`)?.[1])
      .find((version) => version !== undefined);
    assert.ok(locked !== undefined, "pnpm-lock.yaml resolves no @mark1russell7/text for the root package");
    assert.equal(/\n {2}TEXT_VERSION: "([^"]+)"\n/.exec(shared)?.[1], locked);
    // The install goes to the folder of the script: the sparse checkout also has the root package.json of the template
    const install = shared.indexOf(`run: npm install --no-save --no-package-lock --ignore-scripts --prefix .queue-template/scripts/workflows "@mark1russell7/text@\${TEXT_VERSION}"\n`);
    assert.ok(install > 0);
    assert.ok(install < shared.indexOf("run: node .queue-template/scripts/workflows/queue.ts"));
  });
});
