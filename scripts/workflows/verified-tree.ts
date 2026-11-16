// The verified tree of a commit (CI.md, "A tree that passed CI"). A step of a release can start it before the gates:
//
//   node scripts/workflows/verified-tree.ts [--sha <commit>] [--workflow <file>] [--job <name>]...
//
// The script tells if the tree of a commit on the default branch already passed CI in its pull request. It writes
// verified=true or verified=false, and reason=<code>, to GITHUB_OUTPUT. It writes one line to GITHUB_STEP_SUMMARY and the
// same line to stdout. The exit code is 0 for a yes and for a no. A no is not an error: the caller then starts the full
// checks. No workflow starts the script yet.
//
// The inputs: the repository is GITHUB_REPOSITORY (<owner>/<name>). The commit is --sha, else GITHUB_SHA. The workflow file
// is --workflow, else WORKFLOW_FILE, else ci.yml. The required jobs are each --job, else the lines of REQUIRED_JOBS, else
// "CI OK" (the name of the gate job ci-ok of ci.yml). The token comes from GH_TOKEN, else GITHUB_TOKEN, and only from there.
//
// decide() is a pure function over the facts that the script read: it gives the verdict, or the next fact to read. The
// answer is yes only when each rule holds. Each failed rule has its own reason code:
//   1. The commit C has exactly one parent P (not-one-parent).
//   2. Exactly one merged pull request has the merge commit C (no-pull, many-pulls). Its base is the default branch
//      (pull-base-not-default). Its head is a branch of the same repository, not of a fork (pull-head-fork).
//   3. The tree of C is the tree of the head commit H of that pull request (tree-differs).
//   4. P is H or an ancestor of H: the compare P...H gives behind_by 0 (head-behind-parent).
//   5. Of the runs of the workflow file with the event pull_request on H from the same repository, the newest run (the
//      highest run_number, then the highest run_attempt) is completed (run-not-completed) with the conclusion success
//      (run-not-success). A newer run that is in progress, failed, cancelled or held is a no. No such run is a no (no-run).
//   6. Each required job is in that run (job-missing), with the conclusion success (job-not-success). The script reads the
//      jobs of the newest attempt (filter=latest), page by page. A skipped job is not a pass.
//
// Why rules 3 and 4 prove that CI tested the released tree: a pull_request run does not test H alone. It tests the merge
// of the base branch into H, with the base commit B of the time of the run. The default branch only moves forward, so B
// is P or an ancestor of P. Rule 4 makes P an ancestor of H (or H itself), so B is an ancestor of H too. A merge of an
// ancestor of H into H gives the tree of H with no change. Thus the run tested the tree of H, and rule 3 makes that tree
// the tree of C.
//
// The fail-safe direction: each HTTP error, each missing or malformed field and each fact that the script cannot read
// gives verified=false, with a reason that starts with no-read-. A case that the script cannot read is never a pass. Each
// sha must match /^[0-9a-f]{40}$/ before the script puts it in a URL or an output. Each value in GITHUB_OUTPUT and in the
// summary is a fixed text of this file, a checked sha or an integer. No text from the API (a branch, a title) goes out.
//
// The limits:
//   - The run of the pull request has the event pull_request, and verify of a release has the event of the release (push
//     or workflow_dispatch). A job of ci.yml with a condition on the event is not the same in the two runs. The required
//     jobs are the tool for this: the owner of the release names each job that must have passed.
//   - The proof needs a default branch that only moves forward (a ruleset blocks a force push). It also needs the base of
//     the run to be the default branch. A pull request whose base changed after its last run breaks this. A second pull
//     request of the same head into a different base breaks it too. The API does not give the base of a run.
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The pattern of a full commit sha. Each sha passes it before it goes into a URL or an output. */
export const SHA: RegExp = /^[0-9a-f]{40}$/;

/** The default workflow file of the gate. */
export const DEFAULT_WORKFLOW = "ci.yml";

/** The default jobs that must pass: the name of the gate job `ci-ok` of `ci.yml`. */
export const DEFAULT_JOBS: readonly string[] = ["CI OK"];

/** The number of items on a page of a list of the API, and the most pages that the script reads. */
const PER_PAGE = 100;
const MAX_PAGES = 10;

/** The longest time of one call of the API, in milliseconds. A call that takes longer is a no read. */
const TIMEOUT_MS = 30_000;

/** The reason codes. `passed` is the only reason of a yes. */
export type Reason =
  | "passed"
  | "not-one-parent"
  | "no-pull"
  | "many-pulls"
  | "pull-base-not-default"
  | "pull-head-fork"
  | "tree-differs"
  | "head-behind-parent"
  | "no-run"
  | "run-not-completed"
  | "run-not-success"
  | "job-missing"
  | "job-not-success"
  | "no-read-input"
  | "no-read-commit"
  | "no-read-pulls"
  | "no-read-repo"
  | "no-read-head"
  | "no-read-compare"
  | "no-read-runs"
  | "no-read-jobs"
  | "no-read-error";

/** The reason codes of a fact that the script cannot read. */
export type NoReadReason = Extract<Reason, `no-read-${string}`>;

/** The sentence of each reason code. The outputs contain only these texts, the codes, checked shas and integers. */
export const REASONS: Readonly<Record<Reason, string>> = {
  passed: "The tree of the commit passed CI in its pull request.",
  "not-one-parent": "The commit does not have exactly one parent.",
  "no-pull": "No merged pull request has this commit as its merge commit.",
  "many-pulls": "More than one merged pull request has this commit as its merge commit.",
  "pull-base-not-default": "The base of the pull request is not the default branch.",
  "pull-head-fork": "The head of the pull request is not a branch of this repository.",
  "tree-differs": "The tree of the commit is not the tree of the head of the pull request.",
  "head-behind-parent": "The head of the pull request does not contain the parent of the commit.",
  "no-run": "No pull request run of the workflow from this repository is on the head.",
  "run-not-completed": "The newest run on the head is not completed.",
  "run-not-success": "The newest run on the head did not end with success.",
  "job-missing": "A required job is not in the newest run.",
  "job-not-success": "A required job of the newest run did not end with success.",
  "no-read-input": "An input is missing or not valid.",
  "no-read-commit": "The script cannot read the commit.",
  "no-read-pulls": "The script cannot read the pull requests of the commit.",
  "no-read-repo": "The script cannot read the default branch.",
  "no-read-head": "The script cannot read the head commit of the pull request.",
  "no-read-compare": "The script cannot read the compare of the parent and the head.",
  "no-read-runs": "The script cannot read the runs of the workflow on the head.",
  "no-read-jobs": "The script cannot read the jobs of the newest run.",
  "no-read-error": "The script stopped with an error before a verdict.",
};

/** A commit, from `GET /repos/{o}/{r}/commits/{sha}`. */
export interface CommitFact {
  readonly sha: string;
  readonly tree: string;
  readonly parents: readonly string[];
}

/** A pull request of a commit, from `GET /repos/{o}/{r}/commits/{sha}/pulls`. */
export interface PullFact {
  /** True when the field `merged_at` has a time. */
  readonly merged: boolean;
  readonly mergeCommit: string | null;
  readonly baseRef: string;
  /** The full name of the repository of the base branch. */
  readonly baseRepository: string;
  readonly headSha: string;
  /** The full name of the repository of the head branch. */
  readonly headRepository: string;
}

/** The repository, from `GET /repos/{o}/{r}`. */
export interface RepoFact {
  readonly defaultBranch: string;
}

/** The compare of two commits, from `GET /repos/{o}/{r}/compare/{base}...{head}`. */
export interface CompareFact {
  readonly base: string;
  readonly head: string;
  /** The number of commits of the base that the head does not have. */
  readonly behindBy: number;
  readonly mergeBase: string;
}

/** A run of the workflow file, from `GET /repos/{o}/{r}/actions/workflows/{file}/runs`. */
export interface RunFact {
  readonly id: number;
  readonly runNumber: number;
  readonly runAttempt: number;
  /** The path of the workflow file, with no ref of a called file. */
  readonly path: string;
  readonly event: string;
  readonly headSha: string;
  /** The full name of the repository of the head branch. */
  readonly headRepository: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** A job of a run, from `GET /repos/{o}/{r}/actions/runs/{id}/jobs?filter=latest`. */
export interface JobFact {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** The jobs of the newest `run_attempt` of one run. */
export interface JobsFact {
  readonly run: number;
  readonly jobs: readonly JobFact[];
}

/** A fact that the script cannot read. A no read is not a pass at any time. */
export interface NoRead {
  readonly noRead: NoReadReason;
}

/** A fact, or the reason why the script cannot read it. */
export type Read<T> = T | NoRead;

/** The inputs and each fact that the script read. A fact that it did not read yet is absent. */
export interface Facts {
  readonly repository: string;
  readonly sha: string;
  readonly workflow: string;
  readonly required: readonly string[];
  readonly commit?: Read<CommitFact>;
  readonly pulls?: Read<readonly PullFact[]>;
  readonly repo?: Read<RepoFact>;
  readonly head?: Read<CommitFact>;
  readonly compare?: Read<CompareFact>;
  readonly runs?: Read<readonly RunFact[]>;
  readonly jobs?: Read<JobsFact>;
}

/** The next fact that decide() needs, with the checked values that its read uses. */
export type Need =
  | { readonly fact: "commit"; readonly sha: string }
  | { readonly fact: "pulls"; readonly sha: string }
  | { readonly fact: "repo" }
  | { readonly fact: "head"; readonly sha: string }
  | { readonly fact: "compare"; readonly base: string; readonly head: string }
  | { readonly fact: "runs"; readonly head: string }
  | { readonly fact: "jobs"; readonly run: number };

/** The answer of the script. */
export interface Verdict {
  readonly verified: boolean;
  readonly reason: Reason;
  /** The head commit of the pull request, when the script knows it. */
  readonly head: string | null;
  /** The id of the newest run on the head, when the script knows it. */
  readonly run: number | null;
}

/** The result of decide(): the verdict, or the next fact to read. */
export type Step = { readonly kind: "verdict"; readonly verdict: Verdict } | { readonly kind: "read"; readonly need: Need };

/** This function tells if a fact is a no read. */
function failed<T>(value: Read<T>): value is NoRead {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, "noRead");
}

/** This function tells if a text is the full name of a repository, `<owner>/<name>`, with no `.` or `..` part. */
export function validRepository(value: string): boolean {
  const parts = value.split("/");
  return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9_.-]{1,100}$/.test(part) && part !== "." && part !== "..");
}

/** This function tells if a text is the name of a workflow file in `.github/workflows`, with no folder. */
export function validWorkflow(value: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\.ya?ml$/.test(value);
}

/** This function tells if a list of jobs that must pass is valid: one name or more, each with no control character. */
export function validJobs(names: readonly string[]): boolean {
  return names.length > 0 && names.length <= 50 && names.every((name) => name.length > 0 && name.length <= 200 && !/[\u0000-\u001f\u007f]/.test(name));
}

/**
 * This function gives the newest run of the workflow file with the event `pull_request` on a head from the repository.
 * The newest run has the highest `run_number`, then the highest `run_attempt`. The function gives "none" when no run fits.
 * It gives "tie" when two runs have the same `run_number` and `run_attempt`.
 */
export function newestRun(runs: readonly RunFact[], head: string, repository: string, workflow: string): RunFact | "none" | "tie" {
  const path = `.github/workflows/${workflow}`;
  const fit = runs.filter((run) => run.event === "pull_request" && run.headSha === head && run.headRepository === repository && run.path === path);
  const [first, second] = [...fit].sort((a, b) => b.runNumber - a.runNumber || b.runAttempt - a.runAttempt);
  if (first === undefined) return "none";
  if (second !== undefined && second.runNumber === first.runNumber && second.runAttempt === first.runAttempt) return "tie";
  return first;
}

/**
 * This function decides from the facts. It examines the rules in their order, and gives the verdict of the first rule
 * that fails. When a rule needs a fact that is absent, it gives that fact as the next read. It reads nothing itself.
 */
export function decide(facts: Facts): Step {
  let head: string | null = null;
  let run: number | null = null;
  const no = (reason: Reason): Step => ({ kind: "verdict", verdict: { verified: false, reason, head, run } });
  const need = (next: Need): Step => ({ kind: "read", need: next });
  if (!SHA.test(facts.sha) || !validRepository(facts.repository) || !validWorkflow(facts.workflow) || !validJobs(facts.required)) return no("no-read-input");

  // Rule 1: one parent
  const commit = facts.commit;
  if (commit === undefined) return need({ fact: "commit", sha: facts.sha });
  if (failed(commit)) return no(commit.noRead);
  if (commit.sha !== facts.sha) return no("no-read-commit");
  const [parent, ...others] = commit.parents;
  if (parent === undefined || others.length > 0) return no("not-one-parent");

  // Rule 2: one merged pull request into the default branch, from a branch of the repository
  const pulls = facts.pulls;
  if (pulls === undefined) return need({ fact: "pulls", sha: facts.sha });
  if (failed(pulls)) return no(pulls.noRead);
  const [pull, ...more] = pulls.filter((each) => each.merged && each.mergeCommit === facts.sha);
  if (pull === undefined) return no("no-pull");
  if (more.length > 0) return no("many-pulls");
  const repo = facts.repo;
  if (repo === undefined) return need({ fact: "repo" });
  if (failed(repo)) return no(repo.noRead);
  if (pull.baseRepository !== facts.repository || pull.baseRef !== repo.defaultBranch) return no("pull-base-not-default");
  if (pull.headRepository !== facts.repository) return no("pull-head-fork");
  if (!SHA.test(pull.headSha)) return no("no-read-pulls");
  head = pull.headSha;

  // Rule 3: the same tree
  const headCommit = facts.head;
  if (headCommit === undefined) return need({ fact: "head", sha: head });
  if (failed(headCommit)) return no(headCommit.noRead);
  if (headCommit.sha !== head) return no("no-read-head");
  if (headCommit.tree !== commit.tree) return no("tree-differs");

  // Rule 4: the head has the parent
  const compare = facts.compare;
  if (compare === undefined) return need({ fact: "compare", base: parent, head });
  if (failed(compare)) return no(compare.noRead);
  if (compare.base !== parent || compare.head !== head) return no("no-read-compare");
  if (compare.behindBy !== 0) return no("head-behind-parent");
  // With behind_by 0, the merge base is the parent. A different merge base is a contradiction, not a pass
  if (compare.mergeBase !== parent) return no("no-read-compare");

  // Rule 5: the newest run passed
  const runs = facts.runs;
  if (runs === undefined) return need({ fact: "runs", head });
  if (failed(runs)) return no(runs.noRead);
  const newest = newestRun(runs, head, facts.repository, facts.workflow);
  if (newest === "none") return no("no-run");
  if (newest === "tie") return no("no-read-runs");
  run = newest.id;
  if (newest.status !== "completed") return no("run-not-completed");
  if (newest.conclusion !== "success") return no("run-not-success");

  // Rule 6: each required job passed
  const jobs = facts.jobs;
  if (jobs === undefined) return need({ fact: "jobs", run: newest.id });
  if (failed(jobs)) return no(jobs.noRead);
  if (jobs.run !== newest.id) return no("no-read-jobs");
  for (const name of facts.required) {
    const named = jobs.jobs.filter((job) => job.name === name);
    if (named.length === 0) return no("job-missing");
    if (!named.every((job) => job.status === "completed" && job.conclusion === "success")) return no("job-not-success");
  }
  return { kind: "verdict", verdict: { verified: true, reason: "passed", head, run } };
}

/** An answer of the REST API. */
export interface ApiResponse {
  /** The HTTP status, or 0 when the call failed with no answer. */
  readonly status: number;
  /** The parsed JSON body, or null when the body is empty or not JSON. */
  readonly body: unknown;
}

/** The calls of the GitHub API that the script makes: GET only. The tests give a fake. */
export interface Api {
  /** This function does not throw at any time. A failed call gives the status 0. */
  get(path: string): Promise<ApiResponse>;
}

/** A function with the shape of `fetch`, for the tests. */
export type Fetch = (url: string, init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/** This function gives the API of GitHub on a fetch. The token goes only into the header `authorization`. */
export function githubApi(fetcher: Fetch, input: { readonly api: string; readonly token: string }): Api {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (input.token !== "") headers["authorization"] = `Bearer ${input.token}`;
  return {
    async get(path) {
      try {
        const response = await fetcher(`${input.api}/${path}`, { method: "GET", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        const text = await response.text();
        let body: unknown = null;
        try {
          body = text === "" ? null : (JSON.parse(text) as unknown);
        } catch {
          body = null;
        }
        return { status: response.status, body };
      } catch {
        return { status: 0, body: null };
      }
    },
  };
}

/** This function gives an object of JSON, or null for each other value. */
const record = (value: unknown): Readonly<Record<string, unknown>> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : null);

/** This function gives the value at a path of keys in JSON, or undefined when a part is absent. */
function field(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    const object = record(current);
    if (object === null) return undefined;
    current = object[key];
  }
  return current;
}

/** This function gives a full sha, or null for each other value. */
const shaOf = (value: unknown): string | null => (typeof value === "string" && SHA.test(value) ? value : null);

/** This function gives an integer of 0 or more, or null for each other value. */
const countOf = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** This function gives an integer of 1 or more, or null for each other value. */
const positiveOf = (value: unknown): number | null => {
  const count = countOf(value);
  return count !== null && count > 0 ? count : null;
};

/** This function gives a text, or null for each other value. */
const textOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** This function gives a conclusion: a text, or null. It gives undefined for each other value, so a missing field is not null. */
const conclusionOf = (value: unknown): string | null | undefined => (value === null || typeof value === "string" ? value : undefined);

/** This function gives the facts of a commit, or null when a field is missing or malformed. */
export function parseCommit(body: unknown): CommitFact | null {
  const sha = shaOf(field(body, "sha"));
  const tree = shaOf(field(body, "commit", "tree", "sha"));
  const parents = field(body, "parents");
  if (sha === null || tree === null || !Array.isArray(parents)) return null;
  const list: string[] = [];
  for (const parent of parents as readonly unknown[]) {
    const parentSha = shaOf(field(parent, "sha"));
    if (parentSha === null) return null;
    list.push(parentSha);
  }
  return { sha, tree, parents: list };
}

/** This function gives the facts of a pull request, or null when a field is missing or malformed. */
export function parsePull(item: unknown): PullFact | null {
  const mergedAt = field(item, "merged_at");
  const mergeField = field(item, "merge_commit_sha");
  const mergeCommit = mergeField === null ? null : shaOf(mergeField);
  const baseRef = textOf(field(item, "base", "ref"));
  const baseRepository = textOf(field(item, "base", "repo", "full_name"));
  const headSha = shaOf(field(item, "head", "sha"));
  const headRepository = textOf(field(item, "head", "repo", "full_name"));
  if (mergedAt !== null && typeof mergedAt !== "string") return null;
  if (mergeField !== null && mergeCommit === null) return null;
  if (baseRef === null || baseRepository === null || headSha === null || headRepository === null) return null;
  return { merged: typeof mergedAt === "string", mergeCommit, baseRef, baseRepository, headSha, headRepository };
}

/** This function gives the facts of a run, or null when a field is missing or malformed. */
export function parseRun(item: unknown): RunFact | null {
  const id = positiveOf(field(item, "id"));
  const runNumber = positiveOf(field(item, "run_number"));
  const runAttempt = positiveOf(field(item, "run_attempt"));
  const path = textOf(field(item, "path"));
  const event = textOf(field(item, "event"));
  const headSha = shaOf(field(item, "head_sha"));
  const headRepository = textOf(field(item, "head_repository", "full_name"));
  const status = textOf(field(item, "status"));
  const conclusion = conclusionOf(field(item, "conclusion"));
  if (id === null || runNumber === null || runAttempt === null || path === null || event === null || headSha === null) return null;
  if (headRepository === null || status === null || conclusion === undefined) return null;
  // A path can end with the ref of a called file, for example ".github/workflows/ci.yml@refs/heads/main"
  return { id, runNumber, runAttempt, path: path.replace(/@.*$/, ""), event, headSha, headRepository, status, conclusion };
}

/**
 * This function gives the facts of a job of a run. It gives null when a field is missing or malformed, or when the job
 * is of another run.
 */
export function parseJob(item: unknown, run: number): JobFact | null {
  const name = textOf(field(item, "name"));
  const status = textOf(field(item, "status"));
  const conclusion = conclusionOf(field(item, "conclusion"));
  if (name === null || status === null || conclusion === undefined || field(item, "run_id") !== run) return null;
  return { name, status, conclusion };
}

/**
 * This function reads a list of the API page by page, 100 on a page, at most 10 pages. `key` names the list in the body,
 * or is null when the body is the list. A body with a key must give `total_count`, and the script must read that number
 * of items. It gives null for each failed or malformed read.
 */
export async function readList(api: Api, path: string, key: string | null): Promise<unknown[] | null> {
  const items: unknown[] = [];
  const join = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await api.get(`${path}${join}per_page=${String(PER_PAGE)}&page=${String(page)}`);
    if (response.status !== 200) return null;
    const list = key === null ? response.body : field(response.body, key);
    if (!Array.isArray(list)) return null;
    items.push(...(list as readonly unknown[]));
    const total = key === null ? null : countOf(field(response.body, "total_count"));
    if (key !== null && total === null) return null;
    if (list.length < PER_PAGE || (total !== null && items.length >= total)) return total === null || items.length === total ? items : null;
  }
  return null;
}

/** This function gives each item of a list through a parser, or null when one item does not parse. */
function parseAll<T>(items: readonly unknown[] | null, parse: (item: unknown) => T | null): T[] | null {
  if (items === null) return null;
  const facts: T[] = [];
  for (const item of items) {
    const fact = parse(item);
    if (fact === null) return null;
    facts.push(fact);
  }
  return facts;
}

/** This function gives the body of a GET, or null when the status is not 200. */
async function readBody(api: Api, path: string): Promise<unknown> {
  const response = await api.get(path);
  return response.status === 200 ? response.body : null;
}

/** This function gives a fact, or the no read of a reason when the fact is null. */
const orNoRead = <T>(fact: T | null, reason: NoReadReason): Read<T> => (fact === null ? { noRead: reason } : fact);

/** This function reads a commit. It gives a no read when the API gives a different commit. */
export async function readCommit(api: Api, repository: string, sha: string, reason: "no-read-commit" | "no-read-head"): Promise<Read<CommitFact>> {
  if (!SHA.test(sha)) return { noRead: reason };
  const commit = parseCommit(await readBody(api, `repos/${repository}/commits/${sha}`));
  return orNoRead(commit !== null && commit.sha === sha ? commit : null, reason);
}

/** This function reads the pull requests of a commit, page by page. */
export async function readPulls(api: Api, repository: string, sha: string): Promise<Read<readonly PullFact[]>> {
  if (!SHA.test(sha)) return { noRead: "no-read-pulls" };
  return orNoRead(parseAll(await readList(api, `repos/${repository}/commits/${sha}/pulls`, null), parsePull), "no-read-pulls");
}

/** This function reads the default branch of the repository. */
export async function readRepo(api: Api, repository: string): Promise<Read<RepoFact>> {
  const branch = textOf(field(await readBody(api, `repos/${repository}`), "default_branch"));
  return orNoRead(branch === null || branch === "" ? null : { defaultBranch: branch }, "no-read-repo");
}

/** This function reads the compare of two commits: the number of commits of the base that the head does not have. */
export async function readCompare(api: Api, repository: string, base: string, head: string): Promise<Read<CompareFact>> {
  if (!SHA.test(base) || !SHA.test(head)) return { noRead: "no-read-compare" };
  // One commit on a page keeps the answer small. behind_by counts each commit, also on the other pages
  const body = await readBody(api, `repos/${repository}/compare/${base}...${head}?per_page=1`);
  const behindBy = countOf(field(body, "behind_by"));
  const mergeBase = shaOf(field(body, "merge_base_commit", "sha"));
  return orNoRead(behindBy === null || mergeBase === null ? null : { base, head, behindBy, mergeBase }, "no-read-compare");
}

/** This function reads the runs of the workflow file with the event pull_request on a head, page by page. */
export async function readRuns(api: Api, repository: string, workflow: string, head: string): Promise<Read<readonly RunFact[]>> {
  if (!SHA.test(head) || !validWorkflow(workflow)) return { noRead: "no-read-runs" };
  const path = `repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${head}&event=pull_request`;
  return orNoRead(parseAll(await readList(api, path, "workflow_runs"), parseRun), "no-read-runs");
}

/** This function reads the jobs of the newest `run_attempt` of a run, page by page. */
export async function readJobs(api: Api, repository: string, run: number): Promise<Read<JobsFact>> {
  if (!Number.isSafeInteger(run) || run <= 0) return { noRead: "no-read-jobs" };
  const jobs = parseAll(await readList(api, `repos/${repository}/actions/runs/${String(run)}/jobs?filter=latest`, "jobs"), (item) => parseJob(item, run));
  return orNoRead(jobs === null ? null : { run, jobs }, "no-read-jobs");
}

/** This function reads the fact that decide() needs, and gives the facts with it. */
async function gather(api: Api, facts: Facts, need: Need): Promise<Facts> {
  const repository = facts.repository;
  switch (need.fact) {
    case "commit":
      return { ...facts, commit: await readCommit(api, repository, need.sha, "no-read-commit") };
    case "pulls":
      return { ...facts, pulls: await readPulls(api, repository, need.sha) };
    case "repo":
      return { ...facts, repo: await readRepo(api, repository) };
    case "head":
      return { ...facts, head: await readCommit(api, repository, need.sha, "no-read-head") };
    case "compare":
      return { ...facts, compare: await readCompare(api, repository, need.base, need.head) };
    case "runs":
      return { ...facts, runs: await readRuns(api, repository, facts.workflow, need.head) };
    case "jobs":
      return { ...facts, jobs: await readJobs(api, repository, need.run) };
  }
}

/** The number of facts. Each step of verify() reads one fact that was absent, so it ends after this number of reads. */
const FACTS = 7;

/** This function reads the facts that decide() asks for, one at a time, and gives the verdict. */
export async function verify(api: Api, input: Facts): Promise<Verdict> {
  let facts = input;
  for (let reads = 0; reads <= FACTS; reads += 1) {
    const step = decide(facts);
    if (step.kind === "verdict") return step.verdict;
    facts = await gather(api, facts, step.need);
  }
  throw new Error(`decide() asked for more than ${String(FACTS)} facts`);
}

/** This function gives a verdict of no with a reason, and no head and no run. */
const noVerdict = (reason: Reason): Verdict => ({ verified: false, reason, head: null, run: null });

/** This function gives the reason of a verdict when it is in the closed set, else `no-read-error`. */
function closedReason(reason: string): Reason {
  return Object.hasOwn(REASONS, reason) ? (reason as Reason) : "no-read-error";
}

/** This function gives the text of the outputs, for GITHUB_OUTPUT. A yes needs the reason `passed`. */
export function outputText(verdict: Verdict): string {
  const reason = closedReason(verdict.reason);
  const verified = verdict.verified && reason === "passed";
  return `verified=${verified ? "true" : "false"}\nreason=${reason}\n`;
}

/**
 * This function gives the line of the summary and of stdout. Each part is a fixed text, a reason code, a checked sha or an
 * integer. A head or a run that is not valid is left out. A commit that is not valid is "none".
 */
export function summaryLine(verdict: Verdict, commit: string | null): string {
  const reason = closedReason(verdict.reason);
  const verified = verdict.verified && reason === "passed";
  const parts = [`Verified tree: verified=${verified ? "true" : "false"}`, `reason=${reason}`, `commit=${commit !== null && SHA.test(commit) ? commit : "none"}`];
  if (verdict.head !== null && SHA.test(verdict.head)) parts.push(`head=${verdict.head}`);
  if (verdict.run !== null && Number.isSafeInteger(verdict.run) && verdict.run > 0) parts.push(`run=${String(verdict.run)}`);
  return `${parts.join(" ")}. ${REASONS[reason]}`;
}

/** The checked inputs of a run of the script, with no token. */
export interface Input {
  readonly facts: Facts;
  /** The base URL of the REST API, with no slash at the end. */
  readonly api: string;
}

/** This function parses the arguments. It gives null for an unknown option or a positional argument. */
function parseArguments(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: { sha: { type: "string" }, workflow: { type: "string" }, job: { type: "string", multiple: true } }, strict: true, allowPositionals: false }).values;
  } catch {
    return null;
  }
}

/** This function gives the lines of a text that are not empty, with no spaces at their ends. */
const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** This function reads and checks the inputs from the arguments and the environment. It gives null for an input that is not valid. */
export function readInput(argv: readonly string[], env: NodeJS.ProcessEnv): Input | null {
  const values = parseArguments(argv);
  if (values === null) return null;
  const fromArguments = (values.job ?? []).map((name) => name.trim());
  const fromEnvironment = lines(env["REQUIRED_JOBS"] ?? "");
  const required = values.job !== undefined ? fromArguments : fromEnvironment.length > 0 ? fromEnvironment : [...DEFAULT_JOBS];
  const facts: Facts = {
    repository: env["GITHUB_REPOSITORY"] ?? "",
    sha: values.sha ?? env["GITHUB_SHA"] ?? "",
    workflow: values.workflow ?? (env["WORKFLOW_FILE"] || DEFAULT_WORKFLOW),
    required,
  };
  const api = (env["GITHUB_API_URL"] || "https://api.github.com").replace(/\/+$/, "");
  const valid = SHA.test(facts.sha) && validRepository(facts.repository) && validWorkflow(facts.workflow) && validJobs(facts.required);
  return valid && /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)*$/.test(api) ? { facts, api } : null;
}

/**
 * This function operates the step: it reads the inputs, decides, and writes the outputs, the summary and the line on
 * stdout. It gives 0 for a yes and for a no. A write to GITHUB_OUTPUT or GITHUB_STEP_SUMMARY that fails throws.
 */
export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, fetcher: Fetch = fetch, log: (line: string) => void = console.log): Promise<number> {
  const input = readInput(argv, env);
  let verdict = noVerdict("no-read-input");
  if (input !== null) {
    const api = githubApi(fetcher, { api: input.api, token: env["GH_TOKEN"] || env["GITHUB_TOKEN"] || "" });
    try {
      verdict = await verify(api, input.facts);
    } catch {
      verdict = noVerdict("no-read-error");
    }
  }
  const line = summaryLine(verdict, input === null ? null : input.facts.sha);
  log(line);
  const output = env["GITHUB_OUTPUT"];
  if (output !== undefined && output !== "") appendFileSync(output, outputText(verdict));
  const summary = env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") appendFileSync(summary, `${line}\n`);
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
