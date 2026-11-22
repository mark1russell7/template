// The queue of the pull requests with auto-merge (CI.md, "The queue"). The job of reusable-queue.yml starts it:
//
//   node scripts/workflows/queue.ts
//
// Several writers merge into one main with `gh pr merge --auto`. With strict status checks in the ruleset, GitHub merges
// a pull request only when its branch has the newest main and the required checks passed on that head. This script keeps
// such pull requests up to date, with no hand work:
//   1. It reads the required checks of the rules of the default branch, and the open pull requests into that branch.
//      While GitHub has not computed the merge state of a queued pull request (UNKNOWN), it reads them again, a few times.
//   2. plan() gives the actions: an update for each queued pull request (auto-merge on, not a draft, not from a fork) that
//      is BEHIND. plan() is a pure function, so the tests give it states and read the actions.
//   3. execute() merges the default branch into each such pull request (update-branch with expected_head_sha), and waits
//      until the head changes (a limited time).
//   4. A push with GITHUB_TOKEN starts the pull_request runs of the new head, but GitHub holds each one: its conclusion is
//      action_required, and it starts no job. execute() reads the pull_request runs of the new head until the set is
//      stable, and starts each held run (approve, or rerun when approve refuses). It also starts the held runs of the head
//      of each other queued pull request, so a run that came after the wait of an earlier run of the queue starts too.
// The queue starts only a held run of the same repository, on the head that it reads, whose actor is the bot of
// GITHUB_TOKEN. Each other held run is a no read in the summary, never a pass. A refused update (HTTP 422, for example a
// merge conflict) skips that pull request, and each other pull request still gets its turn. A held run that the queue
// cannot start fails the job, with the id of the run.
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { escapeMarkdown, escapeWorkflowData } from "@mark1russell7/text";

/** The merge state of a pull request whose branch does not have the newest commit of the base branch. */
export const BEHIND = "BEHIND";

/** The login of the bot of GITHUB_TOKEN. A push with GITHUB_TOKEN, for example update-branch, has this actor. */
export const TOKEN_BOT = "github-actions[bot]";

/** The conclusion of a workflow run that GitHub holds until a person or a token with `actions: write` starts it. */
export const HELD = "action_required";

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

/** A workflow run of the event pull_request on a commit, from `GET /repos/{o}/{r}/actions/runs`. */
export interface PullRun {
  readonly id: number;
  /** The path of the workflow file, with no ref of a called file. */
  readonly path: string;
  readonly headSha: string;
  /** The full name of the repository of the head branch, or "" when the API gives none. */
  readonly headRepository: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  /** The login of the actor of the push that made the run, or "" when the API gives none. */
  readonly actor: string;
}

/** A thing that the queue cannot read or must not start, and the reason. A no read is not a pass. */
export interface NoRead {
  readonly subject: string;
  readonly why: string;
}

/** The action of the queue for one queued pull request. */
export type Action =
  | { readonly kind: "skip"; readonly pull: number; readonly mergeState: string; readonly headSha: string; readonly why: string; readonly noRead: boolean }
  | { readonly kind: "update"; readonly pull: number; readonly mergeState: string; readonly expectedHeadSha: string };

/** This function tells if the queue takes a pull request: auto-merge is on, it is not a draft, and it is not from a fork. */
export function queued(pull: PullState): boolean {
  return pull.autoMerge && !pull.draft && !pull.fork;
}

/** The short form of a commit, for the summary. */
const short = (sha: string): string => sha.slice(0, 7);

/**
 * This function gives the checks that the rules of a branch need (`GET /repos/{o}/{r}/rules/branches/{branch}`). It gives
 * each check one time. It tells if a rule asks for an up-to-date branch (strict). It ignores each rule of a different type.
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

/** This function tells if GitHub holds a run: it is completed with the conclusion action_required. */
export function held(run: PullRun): boolean {
  return run.status === "completed" && run.conclusion === HELD;
}

/**
 * This function gives the reason why the queue must not start a held run, or null when it can start it. The queue starts
 * only a pull_request run on the commit that it read. The run comes from a branch of the repository itself, not from a
 * fork. Its actor is the bot of GITHUB_TOKEN.
 */
export function refusal(run: PullRun, repository: string, sha: string): string | null {
  if (run.event !== "pull_request") return `the event is ${run.event}, not pull_request`;
  if (run.headSha !== sha) return `its head ${short(run.headSha)} is not the head ${short(sha)} of the pull request`;
  if (run.headRepository !== repository) return `its head is in the repository ${run.headRepository === "" ? "(none)" : run.headRepository}, not ${repository}`;
  if (run.actor !== TOKEN_BOT) return `its actor is ${run.actor === "" ? "(none)" : run.actor}, not ${TOKEN_BOT}`;
  return null;
}

/** This function gives the reason why the queue does not update a queued pull request, from its merge state. */
function skipReason(state: string): { why: string; noRead: boolean } {
  if (state === "UNKNOWN") return { why: "GitHub did not compute the merge state", noRead: true };
  if (state === "DIRTY") return { why: "a merge conflict with the base branch: a person merges it", noRead: false };
  return { why: `the merge state is ${state}, not ${BEHIND}`, noRead: false };
}

/** This function gives the action of the queue for each queued pull request, in the order of the numbers. */
export function plan(pulls: readonly PullState[]): Action[] {
  return pulls
    .filter(queued)
    .sort((a, b) => a.number - b.number)
    .map((pull): Action => {
      if (pull.mergeState !== BEHIND) return { kind: "skip", pull: pull.number, mergeState: pull.mergeState, headSha: pull.headSha, ...skipReason(pull.mergeState) };
      return { kind: "update", pull: pull.number, mergeState: pull.mergeState, expectedHeadSha: pull.headSha };
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

/** This function gives the body of a GET, and throws when the status is not 200. A failed read is not a pass. */
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
  /** The longest time that the job waits for the new heads of the updated pull requests and for their runs, in milliseconds. */
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

interface RunNode {
  readonly id?: unknown;
  readonly path?: unknown;
  readonly head_sha?: unknown;
  readonly head_repository?: { readonly full_name?: unknown } | null;
  readonly event?: unknown;
  readonly status?: unknown;
  readonly conclusion?: unknown;
  readonly actor?: { readonly login?: unknown } | null;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** This function reads the workflow runs of the event pull_request on a commit, page by page. A failed read throws. */
export async function readPullRuns(api: Api, repository: string, sha: string): Promise<PullRun[]> {
  const runs: PullRun[] = [];
  for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
    const body = (await read(api, `repos/${repository}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100&page=${String(pageNumber)}`)) as {
      total_count?: number;
      workflow_runs?: readonly RunNode[];
    };
    const list = body.workflow_runs ?? [];
    for (const run of list) {
      if (typeof run.id !== "number") continue;
      runs.push({
        id: run.id,
        // A path can end with the ref of a called file, for example ".github/workflows/ci.yml@refs/heads/main"
        path: text(run.path).replace(/@.*$/, ""),
        headSha: text(run.head_sha),
        headRepository: text(run.head_repository?.full_name),
        event: text(run.event),
        status: text(run.status),
        conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
        actor: text(run.actor?.login),
      });
    }
    if (list.length < 100 || pageNumber * 100 >= (body.total_count ?? 0)) return runs;
  }
  throw new Error(`the commit ${short(sha)} has more than 1000 workflow runs`);
}

/** The result of the queue for one queued pull request. */
export interface Outcome {
  readonly pull: number;
  readonly mergeState: string;
  /**
   * `updated`: the head changed. `refused`: update-branch gave HTTP 422. `error`: update-branch or a read gave a different
   * failure, or GitHub made no pull_request run on the new head. `timeout`: the head did not change in the wait time.
   * `skipped`: no update.
   */
  readonly result: "updated" | "refused" | "error" | "timeout" | "skipped";
  readonly detail: string;
  readonly newSha?: string;
  /** Each held run that the queue started: its workflow file, its id and the call that started it. */
  readonly started: readonly string[];
  /** Each held run that the queue could not start: its workflow file, its id and the answers of approve and rerun. */
  readonly failed: readonly string[];
  readonly noRead: readonly NoRead[];
}

/** The runs of the head of one pull request that the queue examined, and what it did with them. */
interface RunState {
  readonly sha: string;
  /** The id of each run of the last read. */
  seen: Set<number>;
  /** True when a read gave at least one run, and no run that the read before it did not give. */
  stable: boolean;
  readonly handled: Set<number>;
  readonly started: string[];
  readonly failed: string[];
  readonly noRead: NoRead[];
  error: string | null;
}

/** This function gives a new state of the runs of a head. */
const runState = (sha: string): RunState => ({ sha, seen: new Set(), stable: false, handled: new Set(), started: [], failed: [], noRead: [], error: null });

/** This function gives the name of a run for the summary: its workflow file and its id. */
const runName = (run: PullRun): string => `${run.path === "" ? "a workflow" : run.path} run ${String(run.id)}`;

/** This function gives an answer of the API for a call that threw. */
const thrown = (error: unknown): ApiResponse => ({ status: 0, body: { message: error instanceof Error ? error.message : String(error) } });

/**
 * This function starts a held run: `POST .../actions/runs/{id}/approve`, and `POST .../rerun` when approve refuses. The
 * documents of GitHub name approve only for a run of a fork. The queue uses it for a held run of its own token, and the
 * rerun keeps the queue working when approve refuses such a run.
 */
async function startHeld(api: Api, repository: string, run: PullRun): Promise<{ readonly started: boolean; readonly text: string }> {
  const approve = await api.rest("POST", `repos/${repository}/actions/runs/${String(run.id)}/approve`).catch(thrown);
  if (approve.status === 201) return { started: true, text: `${runName(run)} (approved)` };
  const rerun = await api.rest("POST", `repos/${repository}/actions/runs/${String(run.id)}/rerun`).catch(thrown);
  if (rerun.status === 201) return { started: true, text: `${runName(run)} (rerun, approve gave ${messageOf(approve)})` };
  return { started: false, text: `${runName(run)} (approve gave ${messageOf(approve)}, rerun gave ${messageOf(rerun)})` };
}

/**
 * This function reads the pull_request runs of a head one time, and starts each held run that it did not examine before.
 * A held run that the queue must not start is a no read. A failed read sets the error of the state.
 */
async function sweep(api: Api, repository: string, state: RunState): Promise<void> {
  let runs: PullRun[];
  try {
    runs = await readPullRuns(api, repository, state.sha);
  } catch (error) {
    state.error = `the queue cannot read the runs of ${short(state.sha)}: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  const ids = new Set(runs.map((run) => run.id));
  state.stable = ids.size > 0 && [...ids].every((id) => state.seen.has(id));
  state.seen = ids;
  for (const run of runs) {
    if (!held(run) || state.handled.has(run.id)) continue;
    state.handled.add(run.id);
    const why = refusal(run, repository, state.sha);
    if (why !== null) {
      state.noRead.push({ subject: runName(run), why: `GitHub holds it, and the queue does not start it: ${why}` });
      continue;
    }
    const result = await startHeld(api, repository, run);
    (result.started ? state.started : state.failed).push(result.text);
  }
}

/**
 * This function operates the actions. It updates each pull request first. It reads the runs of the head of each skipped
 * pull request one time, and starts each held run. Then it waits at most `waitMs`. In that wait, it reads each new head.
 * It reads the pull_request runs of that head until the set is stable, and starts each held run. A failure of one pull
 * request does not stop the others.
 */
export async function execute(api: Api, repository: string, actions: readonly Action[], timing: Timing): Promise<Outcome[]> {
  const outcomes = new Map<number, Outcome>();
  const waiting = new Map<number, Extract<Action, { kind: "update" }>>();
  const skipped: Extract<Action, { kind: "skip" }>[] = [];
  for (const action of actions) {
    if (action.kind === "skip") {
      skipped.push(action);
      continue;
    }
    const base = { pull: action.pull, mergeState: action.mergeState, started: [], failed: [], noRead: [] };
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

  // The held runs of a pull request that the queue does not update: one read, with no wait
  for (const action of skipped) {
    const state = runState(action.headSha);
    await sweep(api, repository, state);
    const noRead = action.noRead ? [{ subject: "merge state", why: action.why }] : [];
    const detail = state.error === null ? action.why : `${action.why}. ${state.error}`;
    outcomes.set(action.pull, { pull: action.pull, mergeState: action.mergeState, result: state.error === null ? "skipped" : "error", detail, started: state.started, failed: state.failed, noRead: [...noRead, ...state.noRead] });
  }

  // One wait for all the updated pull requests. At each step, the queue reads the head of each pull request whose head did
  // not change yet. GitHub makes the runs of a new head some seconds after the push, so from the next step on, the queue
  // reads the runs of that head until the set is stable.
  let waited = 0;
  const heads = new Map<number, RunState>();
  const open = (state: RunState): boolean => !state.stable && state.error === null;
  while ((waiting.size > heads.size || [...heads.values()].some(open)) && waited < timing.waitMs) {
    await timing.sleep(timing.stepMs);
    waited += timing.stepMs;
    for (const [pull, action] of waiting) {
      const state = heads.get(pull);
      if (state !== undefined) {
        if (open(state)) await sweep(api, repository, state);
        continue;
      }
      const response = await api.rest("GET", `repos/${repository}/pulls/${String(pull)}`).catch(() => null);
      const sha = (response?.body as { head?: { sha?: unknown } } | null)?.head?.sha;
      if (response?.status === 200 && typeof sha === "string" && sha !== action.expectedHeadSha) heads.set(pull, runState(sha));
    }
  }

  const seconds = String(timing.waitMs / 1000);
  for (const [pull, action] of waiting) {
    const base = { pull, mergeState: action.mergeState };
    const state = heads.get(pull);
    if (state === undefined) {
      outcomes.set(pull, { ...base, result: "timeout", detail: `the head did not change in ${seconds} s, so the queue started no run`, started: [], failed: [], noRead: [] });
      continue;
    }
    const sha = state.sha;
    const updated = `updated from ${short(action.expectedHeadSha)} to ${short(sha)}`;
    const noRead = [...state.noRead];
    let result: Outcome["result"] = "updated";
    let detail = updated;
    if (state.error !== null) {
      result = "error";
      detail = `${updated}, but ${state.error}`;
    } else if (state.seen.size === 0) {
      result = "error";
      detail = `${updated}, but GitHub made no pull_request run on the new head in ${seconds} s. The next run of the queue starts a held run that comes later`;
    } else if (!state.stable) {
      noRead.push({ subject: "runs", why: `the set of the runs of ${short(sha)} changed until the end of the wait. The next run of the queue starts a held run that comes later` });
    }
    outcomes.set(pull, { ...base, result, detail, newSha: sha, started: state.started, failed: state.failed, noRead });
  }
  return actions.map((action) => outcomes.get(action.pull)).filter((outcome): outcome is Outcome => outcome !== undefined);
}

/** This function gives the exit code: 1 when an update, a read or the start of a held run failed, so a person must look. */
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
 * This function gives the step summary of a run of the queue. Some parts come from the API or from the repository: a
 * branch, a check, a merge state, a path, a detail. Each one goes through `escapeMarkdown`, also in a table cell. Thus it
 * cannot end a cell or start Markdown. A backslash escape does not operate in a code span, so these parts are plain text.
 */
export function summaryText(report: Report): string {
  const lines = ["### The queue", ""];
  const base = escapeMarkdown(report.base);
  const checks = report.required.length === 0 ? "no required check" : `the required checks ${words(report.required.map(escapeMarkdown))}`;
  lines.push(`The rules of ${base} name ${checks}. Strict (a branch with the newest ${base}): ${report.strict ? "on" : "off"}.`);
  if (!report.strict) lines.push("", `With strict off, GitHub merges a pull request that is behind, so no pull request is ${BEHIND} and the queue updates no branch.`);
  lines.push("", `${String(report.outcomes.length)} pull requests with auto-merge. ${String(report.others)} other open pull requests have no auto-merge, are drafts or come from a fork.`);
  if (report.outcomes.length > 0) {
    lines.push("", "| Pull request | Merge state | Result | Held runs started |", "|---|---|---|---|");
    for (const outcome of report.outcomes) {
      const started = [...outcome.started.map(escapeMarkdown), ...outcome.failed.map((item) => `not started: ${escapeMarkdown(item)}`)];
      lines.push(`| #${String(outcome.pull)} | ${escapeMarkdown(outcome.mergeState)} | ${outcome.result}: ${escapeMarkdown(outcome.detail)} | ${started.length === 0 ? "none" : started.join(", ")} |`);
    }
  }
  const noReads = report.outcomes.flatMap((outcome) => outcome.noRead.map((item) => `- #${String(outcome.pull)} ${escapeMarkdown(item.subject)}: ${escapeMarkdown(item.why)}`));
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
    for (const item of outcome.failed) lines.push(`::error title=Queue::${escapeWorkflowData(`${pull}: GitHub holds ${item}, and the queue cannot start it`)}`);
    for (const item of outcome.noRead) lines.push(`::warning title=Queue no read::${escapeWorkflowData(`${pull} ${item.subject}: ${item.why}`)}`);
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
  const actions = plan(pulls);
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
  const summary = summaryText(report);
  console.log(summary);
  for (const line of annotations(report.outcomes)) console.log(line);
  const file = env["GITHUB_STEP_SUMMARY"];
  if (file !== undefined && file !== "") appendFileSync(file, summary);
  return exitCode(report.outcomes);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
