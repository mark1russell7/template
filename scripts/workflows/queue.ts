// The queue of the pull requests with auto-merge (CI.md, "The queue"). The job of reusable-queue.yml starts it:
//
//   node scripts/workflows/queue.ts
//
// Several writers merge into one main with `gh pr merge --auto`. With strict status checks in the ruleset, GitHub merges
// a pull request only when its branch has the newest main and the required checks passed on that head. This script keeps
// such pull requests up to date, with no hand work:
//   1. It reads the required checks of the rules of the default branch, and the open pull requests into that branch.
//      While GitHub has not computed the merge state of a queued pull request (UNKNOWN), it reads them again, a few times.
//   2. For each queued pull request (auto-merge on, not a draft, not from a fork) that is BEHIND, it reads the check runs
//      of the required checks on the head, and the workflow file of the run of each check. A summary check such as
//      "CI OK" gets its check run only when the jobs that it needs end, so a required check can have no check run yet.
//      For such a check, it reads the workflow runs that are still in progress on the head, and the job names of their
//      files: a workflow in progress that has a job of that name gives the check.
//   3. plan() gives the actions: update each such pull request, then start the workflows of its required checks. plan()
//      is a pure function, so the tests give it states and check runs, and read the actions.
//   4. execute() merges the default branch into each pull request (update-branch with expected_head_sha). An update with
//      GITHUB_TOKEN starts no pull_request run. So it waits until the head changes (a limited time), and then starts each
//      workflow with workflow_dispatch on the branch of the pull request.
// A required check with no run on the old head is a no read in the summary, never a pass. A refused update (HTTP 422, for
// example a merge conflict) skips that pull request, and each other pull request still gets its turn.
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { escapeMarkdown, escapeWorkflowData } from "@mark1russell7/text";

/** The id of the GitHub App "GitHub Actions". Only a check run of this app has a workflow that the queue can start. */
export const ACTIONS_APP = 15368;

/** The merge state of a pull request whose branch does not have the newest commit of the base branch. */
export const BEHIND = "BEHIND";

/** One open pull request into the default branch, from the GraphQL API. */
export interface PullState {
  readonly number: number;
  readonly draft: boolean;
  /** True when the head branch is in a different repository (a fork). */
  readonly fork: boolean;
  readonly autoMerge: boolean;
  /** The field `mergeStateStatus`, for example `BEHIND`, `BLOCKED`, `CLEAN`, `DIRTY` or `UNKNOWN`. */
  readonly mergeState: string;
  readonly headRef: string;
  readonly headSha: string;
}

/** A check run of a required check on the head of a pull request, with the workflow of its run. */
export interface GateRun {
  readonly check: string;
  /** The id of the GitHub App of the check run, or 0 when the API gives none. */
  readonly appId: number;
  /** The workflow of the run of the check suite, or null when the API gives no workflow run for the suite. */
  readonly workflow: { readonly id: number; readonly path: string } | null;
}

/** A workflow to start with workflow_dispatch, and the required checks that it gives. */
export interface Dispatch {
  readonly workflowId: number;
  readonly path: string;
  readonly checks: readonly string[];
}

/** A required check that the queue cannot start, and the reason. A no read is never a pass. */
export interface NoRead {
  readonly check: string;
  readonly why: string;
}

/** A workflow with a run in progress on the old head of a pull request, and the check names of the jobs of its file. */
export interface InflightWorkflow {
  readonly id: number;
  readonly path: string;
  /** The check name of each job of the file (its name, or its id when it has no name), or null when the file cannot be read. */
  readonly checks: readonly string[] | null;
}

/** The action of the queue for one queued pull request. */
export type Action =
  | { readonly kind: "skip"; readonly pull: number; readonly mergeState: string; readonly why: string; readonly noRead: boolean }
  | {
      readonly kind: "update";
      readonly pull: number;
      readonly mergeState: string;
      readonly ref: string;
      readonly expectedHeadSha: string;
      readonly dispatch: readonly Dispatch[];
      readonly noRead: readonly NoRead[];
    };

/** This function tells if the queue takes a pull request: auto-merge is on, it is not a draft, and it is not from a fork. */
export function queued(pull: PullState): boolean {
  return pull.autoMerge && !pull.draft && !pull.fork;
}

/** The short form of a commit, for the summary. */
const short = (sha: string): string => sha.slice(0, 7);

/**
 * This function gives the required checks of the rules of a branch (`GET /repos/{o}/{r}/rules/branches/{branch}`), each one
 * time, and tells if a rule asks for an up-to-date branch (strict). It ignores each rule of a different type.
 */
export function requiredChecks(rules: readonly unknown[]): { checks: string[]; strict: boolean } {
  const checks: string[] = [];
  let strict = false;
  for (const rule of rules as readonly { type?: unknown; parameters?: { strict_required_status_checks_policy?: unknown; required_status_checks?: readonly { context?: unknown }[] } }[]) {
    if (rule?.type !== "required_status_checks") continue;
    if (rule.parameters?.strict_required_status_checks_policy === true) strict = true;
    for (const check of rule.parameters?.required_status_checks ?? []) {
      if (typeof check?.context === "string" && !checks.includes(check.context)) checks.push(check.context);
    }
  }
  return { checks, strict };
}

/** This function gives the value of a plain, single-quoted or double-quoted YAML scalar on one line, with no comment. */
function scalar(raw: string): string {
  const double = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (double) return (double[1] ?? "").replace(/\\(.)/g, "$1");
  const single = /^'((?:[^']|'')*)'/.exec(raw);
  if (single) return (single[1] ?? "").replace(/''/g, "'");
  return raw.replace(/\s+#.*$/, "").trim();
}

/**
 * This function gives the check name of each job of a workflow file: the value of its key `name`, or its id when it has no
 * name. It reads the block `jobs:` by its indentation, so the names of steps and of the workflow are not in the list. A
 * name of a matrix job (with `${{ }}`) stays as it is, so it is equal to no check name.
 */
export function jobChecks(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^jobs:[ \t]*(?:#.*)?$/.test(line));
  if (start < 0) return [];
  const checks: string[] = [];
  let jobIndent = -1;
  let job: { id: string; name: string | null; indent: number } | null = null;
  const close = (): void => {
    if (job !== null) checks.push(job.name ?? job.id);
  };
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    if (jobIndent < 0) jobIndent = indent;
    if (indent <= jobIndent) {
      close();
      const key = /^\s+([A-Za-z_][\w-]*):[ \t]*(?:#.*)?$/.exec(line);
      job = indent === jobIndent && key ? { id: key[1] ?? "", name: null, indent: -1 } : null;
      continue;
    }
    if (job === null) continue;
    if (job.indent < 0) job.indent = indent;
    if (indent !== job.indent || job.name !== null) continue;
    const name = /^\s+name:[ \t]*(.*)$/.exec(line);
    if (name) job.name = scalar(name[1] ?? "");
  }
  close();
  return [...new Set(checks)];
}

/**
 * This function gives the workflows that give the required checks, from the check runs of the old head of a pull request.
 * It joins the checks of one workflow into one dispatch. For a required check with no check run, a workflow in progress on
 * the old head with a job of that name gives the check. A required check with no check run of GitHub Actions that has a
 * workflow file of the repository, and no such workflow in progress, is a no read.
 */
export function gateWorkflows(required: readonly string[], runs: readonly GateRun[], oldSha: string, inflight: readonly InflightWorkflow[] = []): { dispatch: Dispatch[]; noRead: NoRead[] } {
  const byWorkflow = new Map<number, { path: string; checks: string[] }>();
  const noRead: NoRead[] = [];
  const add = (file: { readonly id: number; readonly path: string }, check: string): void => {
    const entry = byWorkflow.get(file.id) ?? { path: file.path, checks: [] };
    if (!entry.checks.includes(check)) entry.checks.push(check);
    byWorkflow.set(file.id, entry);
  };
  for (const check of required) {
    const own = runs.filter((run) => run.check === check);
    if (own.length === 0) {
      const givers = inflight.filter((workflow) => workflow.checks?.includes(check) === true);
      for (const workflow of givers) add(workflow, check);
      if (givers.length > 0) continue;
      const unread = inflight.filter((workflow) => workflow.checks === null).map((workflow) => workflow.path);
      let why = `no check run on the old head ${short(oldSha)}`;
      if (inflight.length > unread.length) why += ", and no workflow in progress on it has a job of this name";
      if (unread.length > 0) why += `, and the queue cannot read the file of the workflows in progress ${words(unread)}`;
      noRead.push({ check, why });
      continue;
    }
    const actions = own.filter((run) => run.appId === ACTIONS_APP);
    if (actions.length === 0) {
      noRead.push({ check, why: `the check run comes from the app ${String(own[0]?.appId ?? 0)}, not from GitHub Actions` });
      continue;
    }
    const files = actions.flatMap((run) => (run.workflow !== null && run.workflow.path.startsWith(".github/workflows/") ? [run.workflow] : []));
    if (files.length === 0) {
      const path = actions.find((run) => run.workflow !== null)?.workflow?.path;
      noRead.push({ check, why: path === undefined ? "the API gives no workflow run for its check suite" : `its workflow ${path} is not a file of the repository` });
      continue;
    }
    for (const file of files) add(file, check);
  }
  const dispatch = [...byWorkflow.entries()].map(([workflowId, entry]) => ({ workflowId, path: entry.path, checks: entry.checks })).sort((a, b) => a.path.localeCompare(b.path));
  return { dispatch, noRead };
}

/** This function gives the reason why the queue does not update a queued pull request, from its merge state. */
function skipReason(state: string): { why: string; noRead: boolean } {
  if (state === "UNKNOWN") return { why: "GitHub did not compute the merge state", noRead: true };
  if (state === "DIRTY") return { why: "a merge conflict with the base branch: a person merges it", noRead: false };
  return { why: `the merge state is ${state}, not ${BEHIND}`, noRead: false };
}

/**
 * This function gives the action of the queue for each queued pull request, in the order of the numbers. A pull request
 * that is BEHIND gets an update, then a dispatch of the workflows of its required checks. `runs` has the check runs of the
 * head of each such pull request, by number, and `inflight` the workflows in progress on that head.
 */
export function plan(pulls: readonly PullState[], required: readonly string[], runs: ReadonlyMap<number, readonly GateRun[]>, inflight: ReadonlyMap<number, readonly InflightWorkflow[]> = new Map()): Action[] {
  return pulls
    .filter(queued)
    .sort((a, b) => a.number - b.number)
    .map((pull): Action => {
      if (pull.mergeState !== BEHIND) return { kind: "skip", pull: pull.number, mergeState: pull.mergeState, ...skipReason(pull.mergeState) };
      const { dispatch, noRead } = gateWorkflows(required, runs.get(pull.number) ?? [], pull.headSha, inflight.get(pull.number) ?? []);
      return { kind: "update", pull: pull.number, mergeState: pull.mergeState, ref: pull.headRef, expectedHeadSha: pull.headSha, dispatch, noRead };
    });
}

/** An answer of the REST API. */
export interface ApiResponse {
  readonly status: number;
  /** The parsed JSON body, or null when the body is empty or not JSON. */
  readonly body: unknown;
}

/** The calls of the GitHub API that the queue makes. The tests give a fake. */
export interface Api {
  rest(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<ApiResponse>;
  /** This function gives the field `data` of a GraphQL answer. It throws for an HTTP failure or for `errors`. */
  graphql(query: string, variables: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/** A function with the shape of `fetch`, for the tests. */
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

/** This function gives the message of an answer of the API, for the summary. */
export function messageOf(response: ApiResponse): string {
  const message = (response.body as { message?: unknown } | null)?.message;
  return typeof message === "string" ? `HTTP ${String(response.status)}: ${message}` : `HTTP ${String(response.status)}`;
}

/** This function gives the API of GitHub with a token, on a fetch. */
export function githubApi(fetcher: Fetch, input: { readonly api: string; readonly graphql: string; readonly token: string }): Api {
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${input.token}`, "x-github-api-version": "2022-11-28", "content-type": "application/json" };
  const call = async (method: string, url: string, body?: unknown): Promise<ApiResponse> => {
    const response = await fetcher(url, body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : (JSON.parse(text) as unknown);
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  };
  return {
    rest: (method, path, body) => call(method, `${input.api}/${path}`, body),
    async graphql(query, variables) {
      const response = await call("POST", input.graphql, { query, variables });
      const answer = response.body as { data?: unknown; errors?: readonly { message?: unknown }[] } | null;
      if (response.status !== 200) throw new Error(`the GraphQL API gave ${messageOf(response)}`);
      if (answer?.errors !== undefined && answer.errors.length > 0) throw new Error(`the GraphQL API gave errors: ${answer.errors.map((error) => String(error.message)).join("; ")}`);
      return answer?.data;
    },
  };
}

/** This function gives the body of a GET, and throws when the status is not 200. A failed read is never a pass. */
async function read(api: Api, path: string): Promise<unknown> {
  const response = await api.rest("GET", path);
  if (response.status !== 200) throw new Error(`GET ${path} gave ${messageOf(response)}`);
  return response.body;
}

/** The query of the open pull requests into a branch, 100 on a page. */
export const PULLS_QUERY = `query($owner: String!, $name: String!, $base: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, baseRefName: $base, first: 100, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number isDraft isCrossRepository headRefName headRefOid mergeStateStatus autoMergeRequest { enabledAt } }
    }
  }
}`;

interface PullNode {
  readonly number: number;
  readonly isDraft: boolean;
  readonly isCrossRepository: boolean;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly mergeStateStatus: string;
  readonly autoMergeRequest: unknown;
}

/** This function reads the open pull requests into a branch, page by page. */
export async function readPulls(api: Api, repository: string, base: string): Promise<PullState[]> {
  const [owner, name] = repository.split("/");
  const pulls: PullState[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const data = (await api.graphql(PULLS_QUERY, { owner, name, base, after })) as {
      repository?: { pullRequests?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: readonly PullNode[] } } | null;
    } | null;
    const list = data?.repository?.pullRequests;
    if (list === undefined) throw new Error(`the GraphQL API gave no pull requests of ${repository}`);
    for (const node of list.nodes) {
      pulls.push({
        number: node.number,
        draft: node.isDraft,
        fork: node.isCrossRepository,
        autoMerge: node.autoMergeRequest !== null && node.autoMergeRequest !== undefined,
        mergeState: node.mergeStateStatus,
        headRef: node.headRefName,
        headSha: node.headRefOid,
      });
    }
    if (!list.pageInfo.hasNextPage) return pulls;
    after = list.pageInfo.endCursor;
  }
  throw new Error(`${repository} has more than 5000 open pull requests into ${base}`);
}

/** The options of the time of the queue. The tests give a sleep that does not wait. */
export interface Timing {
  readonly sleep: (ms: number) => Promise<void>;
  /** The time between two reads of a state, in milliseconds. */
  readonly stepMs: number;
  /** The longest time that the job waits for the new head of the updated pull requests, in milliseconds. */
  readonly waitMs: number;
  /** The number of reads of the pull requests while a queued one has the merge state UNKNOWN. */
  readonly reads: number;
}

/**
 * This function reads the pull requests again while a queued one has the merge state UNKNOWN, at most `reads` times. A read
 * starts the computation at GitHub, so the next read usually has the state.
 */
export async function readSettledPulls(api: Api, repository: string, base: string, timing: Timing): Promise<PullState[]> {
  let pulls = await readPulls(api, repository, base);
  for (let count = 1; count < timing.reads && pulls.some((pull) => queued(pull) && pull.mergeState === "UNKNOWN"); count += 1) {
    await timing.sleep(timing.stepMs);
    pulls = await readPulls(api, repository, base);
  }
  return pulls;
}

/** This function reads the rules that apply to a branch, page by page. */
export async function readRules(api: Api, repository: string, branch: string): Promise<unknown[]> {
  const rules: unknown[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const items = await read(api, `repos/${repository}/rules/branches/${encodeURIComponent(branch)}?per_page=100&page=${String(page)}`);
    if (!Array.isArray(items)) throw new Error(`the rules of ${branch} are not a list`);
    rules.push(...(items as unknown[]));
    if (items.length < 100) return rules;
  }
  throw new Error(`the branch ${branch} has more than 2000 rules`);
}

/**
 * This function reads the check runs of the required checks on a commit, and the workflow of the run of each check suite of
 * GitHub Actions. It reads each check suite one time.
 */
export async function readGateRuns(api: Api, repository: string, sha: string, required: readonly string[], suites: Map<number, GateRun["workflow"]> = new Map()): Promise<GateRun[]> {
  const runs: GateRun[] = [];
  for (const check of required) {
    const body = (await read(api, `repos/${repository}/commits/${sha}/check-runs?check_name=${encodeURIComponent(check)}&filter=latest&per_page=100`)) as {
      check_runs?: readonly { name?: string; app?: { id?: number } | null; check_suite?: { id?: number } | null }[];
    };
    for (const run of body.check_runs ?? []) {
      if (run.name !== check) continue;
      const appId = run.app?.id ?? 0;
      const suite = run.check_suite?.id;
      let workflow: GateRun["workflow"] = null;
      if (appId === ACTIONS_APP && suite !== undefined) {
        if (!suites.has(suite)) {
          const list = (await read(api, `repos/${repository}/actions/runs?check_suite_id=${String(suite)}&per_page=1`)) as { workflow_runs?: readonly { workflow_id?: number; path?: string }[] };
          const first = list.workflow_runs?.[0];
          // A path can end with the ref of a called file, for example ".github/workflows/ci.yml@refs/heads/main"
          suites.set(suite, first?.workflow_id !== undefined && first.path !== undefined ? { id: first.workflow_id, path: first.path.replace(/@.*$/, "") } : null);
        }
        workflow = suites.get(suite) ?? null;
      }
      runs.push({ check, appId, workflow });
    }
  }
  return runs;
}

/**
 * This function reads the workflows with a run that is not completed on a commit, and the check name of each job of the
 * file of each such workflow at that commit. It reads each workflow one time. The list has the runs of each event: a run
 * that an earlier queue run started is a run of workflow_dispatch. A file that the API does not give has no checks (null),
 * so the checks that only it could give are a no read. A failed read of the runs throws.
 */
export async function readInflight(api: Api, repository: string, sha: string): Promise<InflightWorkflow[]> {
  const found = new Map<number, InflightWorkflow>();
  for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
    const body = (await read(api, `repos/${repository}/actions/runs?head_sha=${sha}&per_page=100&page=${String(pageNumber)}`)) as {
      total_count?: number;
      workflow_runs?: readonly { workflow_id?: number; path?: string; status?: string }[];
    };
    const list = body.workflow_runs ?? [];
    for (const run of list) {
      if (run.status === "completed" || run.workflow_id === undefined || run.path === undefined || found.has(run.workflow_id)) continue;
      // A path can end with the ref of a called file, and a dynamic workflow such as CodeQL has no file
      const path = run.path.replace(/@.*$/, "");
      if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) continue;
      const file = await api.rest("GET", `repos/${repository}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`);
      const content = file.body as { content?: unknown; encoding?: unknown } | null;
      const checks = file.status === 200 && content?.encoding === "base64" && typeof content.content === "string" ? jobChecks(Buffer.from(content.content, "base64").toString("utf8")) : null;
      found.set(run.workflow_id, { id: run.workflow_id, path, checks });
    }
    if (list.length < 100 || pageNumber * 100 >= (body.total_count ?? 0)) return [...found.values()];
  }
  throw new Error(`the commit ${short(sha)} has more than 1000 workflow runs`);
}

/** The result of the queue for one queued pull request. */
export interface Outcome {
  readonly pull: number;
  readonly mergeState: string;
  /**
   * `updated`: the head changed, and the queue started the workflows. `refused`: update-branch gave HTTP 422. `error`:
   * update-branch gave a different failure. `timeout`: the head did not change in the wait time. `skipped`: no update.
   */
  readonly result: "updated" | "refused" | "error" | "timeout" | "skipped";
  readonly detail: string;
  readonly newSha?: string;
  /** The workflow files that the queue started. */
  readonly started: readonly string[];
  /** The workflow files that workflow_dispatch refused, each with the message of the API. */
  readonly failed: readonly string[];
  readonly noRead: readonly NoRead[];
}

/**
 * This function operates the actions. It updates each pull request first, then waits once for all the new heads, and then
 * starts the workflows of each pull request whose head changed. A failure of one pull request does not stop the others.
 */
export async function execute(api: Api, repository: string, actions: readonly Action[], timing: Timing): Promise<Outcome[]> {
  const outcomes = new Map<number, Outcome>();
  const waiting = new Map<number, Extract<Action, { kind: "update" }>>();
  for (const action of actions) {
    if (action.kind === "skip") {
      outcomes.set(action.pull, { pull: action.pull, mergeState: action.mergeState, result: "skipped", detail: action.why, started: [], failed: [], noRead: action.noRead ? [{ check: "merge state", why: action.why }] : [] });
      continue;
    }
    const base = { pull: action.pull, mergeState: action.mergeState, started: [], failed: [], noRead: action.noRead };
    let response: ApiResponse;
    try {
      response = await api.rest("PUT", `repos/${repository}/pulls/${String(action.pull)}/update-branch`, { expected_head_sha: action.expectedHeadSha });
    } catch (error) {
      outcomes.set(action.pull, { ...base, result: "error", detail: `update-branch failed: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (response.status === 202) waiting.set(action.pull, action);
    else if (response.status === 422) outcomes.set(action.pull, { ...base, result: "refused", detail: `update-branch refused the update (${messageOf(response)})` });
    else outcomes.set(action.pull, { ...base, result: "error", detail: `update-branch gave ${messageOf(response)}` });
  }

  const heads = new Map<number, string>();
  for (let waited = 0; waiting.size > heads.size && waited < timing.waitMs; waited += timing.stepMs) {
    await timing.sleep(timing.stepMs);
    for (const [pull, action] of waiting) {
      if (heads.has(pull)) continue;
      const response = await api.rest("GET", `repos/${repository}/pulls/${String(pull)}`).catch(() => null);
      const sha = (response?.body as { head?: { sha?: unknown } } | null)?.head?.sha;
      if (response?.status === 200 && typeof sha === "string" && sha !== action.expectedHeadSha) heads.set(pull, sha);
    }
  }

  for (const [pull, action] of waiting) {
    const base = { pull, mergeState: action.mergeState, noRead: action.noRead };
    const sha = heads.get(pull);
    if (sha === undefined) {
      outcomes.set(pull, { ...base, result: "timeout", detail: `the head did not change in ${String(timing.waitMs / 1000)} s, so the queue started no workflow`, started: [], failed: [] });
      continue;
    }
    const started: string[] = [];
    const failed: string[] = [];
    for (const dispatch of action.dispatch) {
      const response = await api.rest("POST", `repos/${repository}/actions/workflows/${String(dispatch.workflowId)}/dispatches`, { ref: action.ref }).catch((error: unknown) => ({ status: 0, body: { message: error instanceof Error ? error.message : String(error) } }));
      if (response.status === 204) started.push(dispatch.path);
      else failed.push(`${dispatch.path} (${messageOf(response)})`);
    }
    outcomes.set(pull, { ...base, result: "updated", detail: `updated from ${short(action.expectedHeadSha)} to ${short(sha)}`, newSha: sha, started, failed });
  }
  return actions.map((action) => outcomes.get(action.pull)).filter((outcome): outcome is Outcome => outcome !== undefined);
}

/** This function gives the exit code: 1 when an update or a dispatch failed in a way that a person must examine. */
export function exitCode(outcomes: readonly Outcome[]): number {
  return outcomes.some((outcome) => outcome.result === "error" || outcome.result === "timeout" || outcome.failed.length > 0) ? 1 : 0;
}

/** This function gives a list in words: "a", "a and b", "a, b and c". */
const words = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`);

/** The facts of a run of the queue, for the summary. */
export interface Report {
  readonly base: string;
  readonly required: readonly string[];
  readonly strict: boolean;
  /** The number of open pull requests into the base branch that the queue does not take. */
  readonly others: number;
  readonly outcomes: readonly Outcome[];
}

/**
 * This function gives the step summary of a run of the queue. Each part that comes from the API or from the repository
 * (a branch, a check, a merge state, a path, a detail) goes through `escapeMarkdown`, also in a table cell, so it cannot
 * end a cell or start Markdown. A backslash escape does not operate in a code span, so these parts are plain text.
 */
export function summaryText(report: Report): string {
  const lines = ["### The queue", ""];
  const base = escapeMarkdown(report.base);
  const checks = report.required.length === 0 ? "no required check" : `the required checks ${words(report.required.map(escapeMarkdown))}`;
  lines.push(`The rules of ${base} name ${checks}. Strict (a branch with the newest ${base}): ${report.strict ? "on" : "off"}.`);
  if (!report.strict) lines.push("", `With strict off, GitHub merges a pull request that is behind, so no pull request is ${BEHIND} and the queue changes nothing.`);
  lines.push("", `${String(report.outcomes.length)} pull requests with auto-merge. ${String(report.others)} other open pull requests have no auto-merge, are drafts or come from a fork.`);
  if (report.outcomes.length > 0) {
    lines.push("", "| Pull request | Merge state | Result | Workflows started |", "|---|---|---|---|");
    for (const outcome of report.outcomes) {
      const started = [...outcome.started.map(escapeMarkdown), ...outcome.failed.map((text) => `refused: ${escapeMarkdown(text)}`)];
      lines.push(`| #${String(outcome.pull)} | ${escapeMarkdown(outcome.mergeState)} | ${outcome.result}: ${escapeMarkdown(outcome.detail)} | ${started.length === 0 ? "none" : started.join(", ")} |`);
    }
  }
  const noReads = report.outcomes.flatMap((outcome) => outcome.noRead.map((item) => `- #${String(outcome.pull)} ${escapeMarkdown(item.check)}: ${escapeMarkdown(item.why)}`));
  if (noReads.length > 0) lines.push("", "No read (never a pass):", "", ...noReads);
  return `${lines.join("\n")}\n`;
}

/** This function gives the workflow commands (annotations) of the outcomes. */
export function annotations(outcomes: readonly Outcome[]): string[] {
  const lines: string[] = [];
  for (const outcome of outcomes) {
    const pull = `#${String(outcome.pull)}`;
    if (outcome.result === "error" || outcome.result === "timeout") lines.push(`::error title=Queue::${escapeWorkflowData(`${pull}: ${outcome.detail}`)}`);
    if (outcome.result === "refused") lines.push(`::warning title=Queue::${escapeWorkflowData(`${pull}: ${outcome.detail}`)}`);
    for (const text of outcome.failed) lines.push(`::error title=Queue::${escapeWorkflowData(`${pull}: workflow_dispatch refused ${text}`)}`);
    for (const item of outcome.noRead) lines.push(`::warning title=Queue no read::${escapeWorkflowData(`${pull} ${item.check}: ${item.why}`)}`);
  }
  return lines;
}

/** The input of a run of the queue. */
export interface QueueInput {
  readonly repository: string;
  readonly base: string;
  readonly timing: Timing;
}

/** This function operates the queue: it reads the states, plans the actions and operates them. A failed read throws. */
export async function runQueue(api: Api, input: QueueInput): Promise<Report> {
  const { repository, base, timing } = input;
  const { checks, strict } = requiredChecks(await readRules(api, repository, base));
  const pulls = await readSettledPulls(api, repository, base, timing);
  const suites = new Map<number, GateRun["workflow"]>();
  const runs = new Map<number, readonly GateRun[]>();
  const inflight = new Map<number, readonly InflightWorkflow[]>();
  for (const pull of pulls.filter((each) => queued(each) && each.mergeState === BEHIND)) {
    const own = await readGateRuns(api, repository, pull.headSha, checks, suites);
    runs.set(pull.number, own);
    // A summary check gets its check run only when the jobs that it needs end, so it can have no check run yet
    if (checks.some((check) => !own.some((run) => run.check === check))) inflight.set(pull.number, await readInflight(api, repository, pull.headSha));
  }
  const actions = plan(pulls, checks, runs, inflight);
  const outcomes = await execute(api, repository, actions, timing);
  return { base, required: checks, strict, others: pulls.length - actions.length, outcomes };
}

/** This function operates the step: it reads the environment, writes the summary and the annotations, and gives the exit code. */
export async function main(env: NodeJS.ProcessEnv = process.env, fetcher: Fetch = fetch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))): Promise<number> {
  const repository = env["GITHUB_REPOSITORY"] ?? "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    console.log(`::error::${escapeWorkflowData(`GITHUB_REPOSITORY is "${repository}", not <owner>/<name>.`)}`);
    return 1;
  }
  const wait = Number(env["WAIT_SECONDS"] ?? "90");
  if (!Number.isFinite(wait) || wait < 0 || wait > 300) {
    console.log(`::error::${escapeWorkflowData(`WAIT_SECONDS is "${env["WAIT_SECONDS"] ?? ""}". Give a number of seconds from 0 to 300.`)}`);
    return 1;
  }
  const apiUrl = env["GITHUB_API_URL"] ?? "https://api.github.com";
  const api = githubApi(fetcher, { api: apiUrl, graphql: env["GITHUB_GRAPHQL_URL"] ?? `${apiUrl}/graphql`, token: env["GH_TOKEN"] ?? "" });
  const timing: Timing = { sleep, stepMs: 5000, waitMs: Math.ceil(wait / 5) * 5000, reads: 6 };
  let report: Report;
  try {
    let base = env["BASE"] ?? "";
    if (base === "") base = String(((await read(api, `repos/${repository}`)) as { default_branch?: unknown }).default_branch ?? "");
    if (base === "") throw new Error(`the API gives no default branch of ${repository}`);
    report = await runQueue(api, { repository, base, timing });
  } catch (error) {
    console.log(`::error title=Queue::${escapeWorkflowData(`The queue cannot read the state of the pull requests, so it changes nothing: ${error instanceof Error ? error.message : String(error)}`)}`);
    return 1;
  }
  const text = summaryText(report);
  console.log(text);
  for (const line of annotations(report.outcomes)) console.log(line);
  const summary = env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") appendFileSync(summary, text);
  return exitCode(report.outcomes);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
