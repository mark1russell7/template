// The step of the action pull-of-run (action.yml), in the job pull of reusable-ci.yml. A run that workflow_dispatch
// starts has no pull request in its event file, for example a gate that the queue starts (CI.md, "The queue"). This step
// finds the open pull request of the branch of the run. It gives the base, the head, the labels and the text of the pull
// request to the jobs changesets, release-check and checks:
//   1. It lists the open pull requests whose head is the branch of the run, and keeps those of the same repository.
//      No pull request gives found=false: a run by hand on a branch with no pull request examines no change.
//   2. It reads the one pull request. Its head must be the commit of the run. GitHub can update the head some seconds
//      after a push, so the step reads it again some times. When the head stays different, the step fails.
//   3. It reads the tip of the base branch. The change is from that commit to the commit of the run, as in the merge
//      commit of a pull_request run. The field base.sha of a pull request is older: GitHub does not update it when the
//      base branch moves.
// The step fails closed: a lookup that cannot decide stops the job with its reason, and never passes. The function
// pullOfRun takes the fetch as a parameter, so the tests give a fake (.github/actions/pull-of-run.test.ts). main() reads
// the environment of the step and writes GITHUB_OUTPUT.
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { escapeMarkdown, escapeWorkflowData } from "@mark1russell7/text";

/** A function with the shape of `fetch`, for the tests. */
export type Fetch = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;

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

/** The time of the reads of the head. The tests give a sleep that does not wait. */
export interface PullTiming {
  readonly sleep: (ms: number) => Promise<void>;
  /** The number of reads of the pull request after the first, while its head is not the commit of the run. */
  readonly retries: number;
  /** The time between two reads, in milliseconds. */
  readonly waitMs: number;
}

/** The default time: 3 more reads, 10 seconds apart. */
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

/** The message of a refused read: the token cannot read the pull requests. */
const PERMISSION_HELP =
  'The token of the job cannot read the pull requests. A private repository gives "pull-requests: read" to the job that calls reusable-ci.yml, in its ci.yml (CI.md, "The queue").';

/** An answer of the API: the status and the parsed JSON body (null when the body is empty or not JSON). */
interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** This function gives the message of a failed read, with the help for a refused read. */
export function failureOf(path: string, response: ApiResponse): string {
  const message = text(record(response.body)?.["message"]);
  const status = `GET ${path} gave HTTP ${String(response.status)}${message === "" ? "" : `: ${message}`}.`;
  return response.status === 403 || response.status === 404 ? `${status} ${PERMISSION_HELP}` : status;
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
  const read = async (path: string): Promise<unknown> => {
    const response = await fetcher(`${input.api}/${path}`, { method: "GET", headers });
    const body = await response.text();
    let parsed: unknown = null;
    try {
      parsed = body === "" ? null : (JSON.parse(body) as unknown);
    } catch {
      parsed = null;
    }
    if (response.status !== 200) throw new ReadError(failureOf(path, { status: response.status, body: parsed }));
    return parsed;
  };
  const [owner] = input.repository.split("/");
  if (owner === undefined || !/^[^/\s]+\/[^/\s]+$/.test(input.repository)) return { error: `GITHUB_REPOSITORY is "${input.repository}", not <owner>/<name>.` };
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(input.sha)) return { error: `GITHUB_SHA is "${input.sha}", not the hash of a commit.` };
  if (!input.ref.startsWith("refs/heads/")) return { found: false, reason: `The run is on ${input.ref}, not on a branch, so it has no pull request.` };
  const branch = input.ref.slice("refs/heads/".length);
  try {
    // The head filter matches the branch of the owner. A pull request from a fork with the same owner name can match too.
    const listed = await read(`repos/${input.repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`);
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
      pull = record(await read(`repos/${input.repository}/pulls/${String(number)}`));
      head = text(record(pull?.["head"])?.["sha"]);
      if (head === input.sha) break;
    }
    if (pull === undefined || head !== input.sha) {
      const seconds = (timing.retries * timing.waitMs) / 1000;
      return {
        error: `The pull request #${String(number)} has the head ${head === "" ? "(none)" : head}, but the run is on ${input.sha}. The head stayed different for ${String(seconds)} s, so the job cannot tell the change of the run. A newer push to ${branch} starts a new run.`,
      };
    }
    const base = record(pull["base"]);
    const baseRef = text(base?.["ref"]);
    if (baseRef === "") return { error: `The pull request #${String(number)} has no base branch.` };
    const tip = text(record(record(await read(`repos/${input.repository}/git/ref/heads/${segments(baseRef)}`))?.["object"])?.["sha"]);
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
    return { error: `The API did not answer: ${error instanceof Error ? error.message : String(error)}` };
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

export async function main(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: Fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<number> {
  const result = await pullOfRun(
    fetcher,
    { api: env["GITHUB_API_URL"] ?? "https://api.github.com", token: env["GH_TOKEN"] ?? "", repository: env["GITHUB_REPOSITORY"] ?? "", ref: env["GITHUB_REF"] ?? "", sha: env["GITHUB_SHA"] ?? "" },
    { sleep, ...PULL_TIMING },
  );
  const summary = env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") appendFileSync(summary, summaryOf(result));
  if ("error" in result) {
    console.log(`::error title=Pull request of the run::${escapeWorkflowData(result.error)}`);
    return 1;
  }
  if (!result.found) console.log(`::notice title=Pull request of the run::${escapeWorkflowData(result.reason)}`);
  else console.log(`The run is on the head of #${String(result.pullRequest.number)}. The base is ${result.pullRequest.base.ref} at ${result.pullRequest.base.sha}.`);
  const output = env["GITHUB_OUTPUT"];
  if (output === undefined || output === "") {
    console.log("::error title=Pull request of the run::GITHUB_OUTPUT is not set.");
    return 1;
  }
  appendFileSync(output, outputsOf(result));
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
