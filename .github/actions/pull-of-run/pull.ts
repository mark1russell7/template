// The step of the action pull-of-run (action.yml), in the job pull of reusable-ci.yml and in the job changes of a gate
// with paths (CI.md, "A dispatched run of a gate"). A run that workflow_dispatch starts has no pull request in its event
// file, for example a run by hand (CI.md, "A dispatched run of a pull request"). This step finds the open pull request of
// the branch of the run. It gives the base, the head, the labels and the text of the pull request to the jobs changesets,
// release-check and checks:
//   1. It lists the open pull requests whose head is the branch of the run, and keeps those of the same repository.
//      No pull request gives found=false: a run by hand on a branch with no pull request examines no change.
//   2. It reads the one pull request. Its head must be the commit of the run. GitHub can update the head some seconds
//      after a push, so the step reads it again some times. When the head stays different, the step fails.
//   3. It reads the tip of the base branch. The change is from that commit to the commit of the run, as in the merge
//      commit of a pull_request run. The field base.sha of a pull request is older: GitHub does not update it when the
//      base branch moves.
// A read that fails for a time (HTTP 429 or 5xx, or no answer) is read again, with the same limit as the head. The step
// fails closed: a lookup that cannot decide stops the job with its reason, and never passes. The function pullOfRun
// takes the fetch as a parameter, so the tests give a fake (.github/actions/pull-of-run.test.ts). main() reads the
// environment of the step, writes GITHUB_OUTPUT and, with PULL_REQUEST_FILE, the pull request as a JSON file.
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeMarkdown, escapeWorkflowData } from "@mark1russell7/text";

/** A function with the shape of `fetch`, for the tests. The headers are optional, so a fake can omit them. */
export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }>;

/** The facts of the run that the step reads. */
export interface PullInput {
  /** The URL of the REST API, from `GITHUB_API_URL`. */
  readonly api: string;
  /** The token of the job. It has the permissions that the caller of reusable-ci.yml gives. */
  readonly token: string;
  /** The repository of the run, `owner/name`, from `GITHUB_REPOSITORY`. */
  readonly repository: string;
  /** The ref of the run, from `GITHUB_REF`, for example `refs/heads/topic`. */
  readonly ref: string;
  /** The commit of the run, from `GITHUB_SHA`. */
  readonly sha: string;
}

/** The time of the reads again. The tests give a sleep that does not wait. */
export interface PullTiming {
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * The limit of the reads again, for each of two causes: the head of the pull request is not yet the commit of the run,
   * or a read failed for a time (HTTP 429 or 5xx, or no answer). The limit of the second cause is for all reads of the
   * run together.
   */
  readonly retries: number;
  /** The time before each read again, in milliseconds. */
  readonly waitMs: number;
}

/** The default time: 3 more reads for each cause, 10 seconds apart. */
export const PULL_TIMING: Omit<PullTiming, "sleep"> = { retries: 3, waitMs: 10_000 };

/** The pull request of the run, as the file of CONVENTIONS_PULL_REQUEST has it. */
export interface PullRequestOfRun {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly commits: number;
  /** The base branch, and the commit at its tip. */
  readonly base: { readonly ref: string; readonly sha: string };
  /** The head branch, and its commit. It is the commit of the run. */
  readonly head: { readonly ref: string; readonly sha: string };
}

/** The result of the step: the pull request, no pull request with the reason, or the reason that the step fails. */
export type PullResult = { readonly found: true; readonly pullRequest: PullRequestOfRun } | { readonly found: false; readonly reason: string } | { readonly error: string };

/** The help for a refused read of the pull requests: the token cannot read them. */
export const PERMISSION_HELP =
  'The token of the job cannot read the pull requests. A private repository gives "pull-requests: read" to the job that calls reusable-ci.yml, in its ci.yml, with the input pull-request-private (CI.md, "A dispatched run of a pull request").';

/** The help for a refused read when the rate limit of the API stopped it. */
export const RATE_LIMIT_HELP = "The rate limit of the API stopped the read. Start the run again when the limit resets.";

/** An answer of the API: the status, the parsed JSON body (null when the body is empty or not JSON) and the reads left. */
export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  /** The header `x-ratelimit-remaining`, or null when the answer has no such header. */
  readonly remaining?: string | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** This function tells if the rate limit of the API refused a read: HTTP 429, or HTTP 403 with no reads left or with a rate limit message. */
export function rateLimited(response: ApiResponse): boolean {
  if (response.status === 429) return true;
  return response.status === 403 && (response.remaining === "0" || /rate limit/iu.test(text(record(response.body)?.["message"])));
}

/** This function tells if a read failed for a time, so a read again can pass: HTTP 429 or 5xx. */
const transient = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);

/** The help of a read for each status of a refusal: what the status tells about this read, and what to do. */
export type RefusedHelp = Readonly<Partial<Record<403 | 404, string>>>;

/**
 * This function gives the message of a failed read. A refused read (403 or 404) gets the help of the read for its
 * status, except when the rate limit refused it: that gets the help of the rate limit.
 */
export function failureOf(path: string, response: ApiResponse, help: RefusedHelp = {}): string {
  const message = text(record(response.body)?.["message"]);
  const status = `GET ${path} gave HTTP ${String(response.status)}${message === "" ? "" : `: ${message}`}.`;
  if (rateLimited(response)) return `${status} ${RATE_LIMIT_HELP}`;
  const extra = response.status === 403 || response.status === 404 ? help[response.status] : undefined;
  return extra === undefined ? status : `${status} ${extra}`;
}

/** This function encodes each segment of a path, and keeps the `/` between the segments. */
const segments = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** An error of a read, with the message for the log. */
class ReadError extends Error {}

/**
 * This function finds the pull request of the run. It fails closed: each answer that it does not know gives an error,
 * never a pass.
 */
export async function pullOfRun(fetcher: Fetch, input: PullInput, timing: PullTiming): Promise<PullResult> {
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${input.token}`, "x-github-api-version": "2022-11-28" };
  let again = 0;
  const seconds = String(timing.waitMs / 1000);
  /** One read, again after a failure for a time while the limit allows it. A refused read gets `help`. */
  const read = async (path: string, help: RefusedHelp): Promise<unknown> => {
    for (;;) {
      let failure: string;
      try {
        const response = await fetcher(`${input.api}/${path}`, { method: "GET", headers });
        const body = await response.text();
        let parsed: unknown = null;
        try {
          parsed = body === "" ? null : (JSON.parse(body) as unknown);
        } catch {
          parsed = null;
        }
        if (response.status === 200) return parsed;
        const answer: ApiResponse = { status: response.status, body: parsed, remaining: response.headers?.get("x-ratelimit-remaining") ?? null };
        failure = failureOf(path, answer, help);
        if (!transient(response.status)) throw new ReadError(failure);
      } catch (error) {
        if (error instanceof ReadError) throw error;
        failure = `The API did not answer GET ${path}: ${error instanceof Error ? error.message : String(error)}.`;
      }
      if (again >= timing.retries) throw new ReadError(again === 0 ? failure : `${failure} The step read the API again ${String(again)} times, ${seconds} s apart, which is the limit of the run.`);
      again += 1;
      await timing.sleep(timing.waitMs);
    }
  };
  const pullsHelp: RefusedHelp = { 403: PERMISSION_HELP, 404: PERMISSION_HELP };
  const [owner] = input.repository.split("/");
  if (owner === undefined || !/^[^/\s]+\/[^/\s]+$/.test(input.repository)) return { error: `GITHUB_REPOSITORY is "${input.repository}", not <owner>/<name>.` };
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(input.sha)) return { error: `GITHUB_SHA is "${input.sha}", not the hash of a commit.` };
  if (!input.ref.startsWith("refs/heads/")) return { found: false, reason: `The run is on ${input.ref}, not on a branch, so it has no pull request.` };
  const branch = input.ref.slice("refs/heads/".length);
  try {
    // The head filter matches the branch of the owner. A pull request from a fork with the same owner name can match too.
    const listed = await read(`repos/${input.repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`, pullsHelp);
    if (!Array.isArray(listed)) return { error: `The list of the pull requests of ${branch} is not a JSON array.` };
    const numbers = listed
      .map(record)
      .filter((pull) => text(record(record(pull?.["head"])?.["repo"])?.["full_name"]) === input.repository && text(record(pull?.["head"])?.["ref"]) === branch)
      .map((pull) => pull?.["number"])
      .filter((number): number is number => typeof number === "number");
    if (numbers.length === 0) return { found: false, reason: `No open pull request has the branch ${branch} as its head, so the run examines no change.` };
    if (numbers.length > 1) return { error: `The open pull requests ${numbers.map((number) => `#${String(number)}`).join(", ")} all have the branch ${branch} as their head, so the job cannot tell the base of the change.` };
    const number = numbers[0] as number;
    let pull: Record<string, unknown> | undefined;
    let head = "";
    for (let attempt = 0; attempt <= timing.retries; attempt += 1) {
      if (attempt > 0) await timing.sleep(timing.waitMs);
      pull = record(await read(`repos/${input.repository}/pulls/${String(number)}`, pullsHelp));
      if (pull === undefined) return { error: `The read of the pull request #${String(number)} is not a JSON object.` };
      head = text(record(pull["head"])?.["sha"]);
      if (head === input.sha) break;
    }
    if (pull === undefined || head !== input.sha) {
      const waited = (timing.retries * timing.waitMs) / 1000;
      return {
        error: `The pull request #${String(number)} has the head ${head === "" ? "(none)" : head}, but the run is on ${input.sha}. The head stayed different for ${String(waited)} s, so the job cannot tell the change of the run. When ${branch} has a newer commit, the pull_request run of that commit examines it. Else start this run again.`,
      };
    }
    const base = record(pull["base"]);
    const baseRef = text(base?.["ref"]);
    if (baseRef === "") return { error: `The pull request #${String(number)} has no base branch.` };
    // A 404 of the ref is a base branch that is gone. A 403 is a token that cannot read the contents.
    const branchHelp: RefusedHelp = {
      403: 'The token of the job cannot read the branches of the repository. The job that calls reusable-ci.yml gives "contents: read".',
      404: `The base branch ${baseRef} of #${String(number)} is not in the repository: it was deleted or renamed. Change the base of the pull request.`,
    };
    const tip = text(record(record(await read(`repos/${input.repository}/git/ref/heads/${segments(baseRef)}`, branchHelp))?.["object"])?.["sha"]);
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tip)) return { error: `The API gives no commit at the tip of ${baseRef}, the base branch of #${String(number)}.` };
    const labels = Array.isArray(pull["labels"]) ? pull["labels"].map((label) => text(record(label)?.["name"])).filter((name) => name !== "") : [];
    const commits = pull["commits"];
    return {
      found: true,
      pullRequest: {
        number,
        title: text(pull["title"]),
        body: text(pull["body"]),
        labels,
        commits: typeof commits === "number" ? commits : 0,
        base: { ref: baseRef, sha: tip },
        head: { ref: branch, sha: head },
      },
    };
  } catch (error) {
    if (error instanceof ReadError) return { error: error.message };
    return { error: `The step failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** This function gives the outputs of the step, one `name=value` line each. No value has a line break. */
export function outputsOf(result: PullResult): string {
  const values: [string, string][] = [["found", String("found" in result && result.found)]];
  if ("found" in result && result.found) {
    const pull = result.pullRequest;
    values.push(
      ["number", String(pull.number)],
      ["base-ref", pull.base.ref],
      ["base-sha", pull.base.sha],
      ["head-ref", pull.head.ref],
      ["head-sha", pull.head.sha],
      ["labels", JSON.stringify(pull.labels)],
      ["pull-request", JSON.stringify(pull)],
    );
  }
  for (const [name, value] of values) if (/[\r\n]/.test(value)) throw new Error(`The output ${name} has a line break.`);
  return values.map(([name, value]) => `${name}=${value}\n`).join("");
}

/** This function gives the line of the summary of the run, in Markdown. */
export function summaryOf(result: PullResult): string {
  if ("error" in result) return `### Pull request of the run\n\nNo read: ${escapeMarkdown(result.error)}\n`;
  if (!result.found) return `### Pull request of the run\n\n${escapeMarkdown(result.reason)}\n`;
  const pull = result.pullRequest;
  return `### Pull request of the run\n\nThe run is on the head of #${String(pull.number)} (${escapeMarkdown(pull.head.ref)}). The change is from ${escapeMarkdown(pull.base.ref)} at ${pull.base.sha} to ${pull.head.sha}.\n`;
}

/** This function writes the error of the step to the log, and gives the exit code 1. */
function fail(message: string): number {
  console.log(`::error title=Pull request of the run::${escapeWorkflowData(message)}`);
  return 1;
}

export async function main(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: Fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<number> {
  // The step reads the API only when it can give the outputs
  const output = env["GITHUB_OUTPUT"];
  if (output === undefined || output === "") return fail("GITHUB_OUTPUT is not set.");
  const result = await pullOfRun(
    fetcher,
    { api: env["GITHUB_API_URL"] ?? "https://api.github.com", token: env["GH_TOKEN"] ?? "", repository: env["GITHUB_REPOSITORY"] ?? "", ref: env["GITHUB_REF"] ?? "", sha: env["GITHUB_SHA"] ?? "" },
    { sleep, ...PULL_TIMING },
  );
  const summary = env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") appendFileSync(summary, summaryOf(result));
  if ("error" in result) return fail(result.error);
  if (!result.found) console.log(`::notice title=Pull request of the run::${escapeWorkflowData(result.reason)}`);
  else console.log(`The run is on the head of #${String(result.pullRequest.number)}. The base is ${result.pullRequest.base.ref} at ${result.pullRequest.base.sha}.`);
  // The file has the text of the pull request for another job. An environment variable takes at most 32 767 characters
  // on Windows, and a body of a pull request can be longer.
  const file = env["PULL_REQUEST_FILE"];
  if (result.found && file !== undefined && file !== "") {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(result.pullRequest)}\n`);
    } catch (error) {
      return fail(`The step cannot write the pull request to ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  appendFileSync(output, outputsOf(result));
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
