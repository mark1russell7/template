// The step "The commit to build" of the action build-ref (action.yml). The step gives the commit that the job build of
// reusable-pages.yml checks out. It fails closed: an event or a field that it does not know stops the job with its
// reason. It never gives a commit of a fork. The pure function buildRef has no I/O, so the tests call it directly
// (.github/actions/build-ref.test.ts). main() reads the environment and the event file of the step.
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The facts of the event that the step reads. */
export interface RefInput {
  /** The event of the run, from `GITHUB_EVENT_NAME`. A reusable workflow gets the event of its caller. */
  readonly eventName: string;
  /** The payload of the event, from the file `GITHUB_EVENT_PATH`. */
  readonly event: unknown;
  /** The repository of the run, from `GITHUB_REPOSITORY`, for example `owner/name`. */
  readonly repository: string;
  /** The commit of the event, from `GITHUB_SHA`. */
  readonly sha: string;
  /** The commit of the step green-main, or an empty string when that step did not start. */
  readonly green: string;
}

/** The commit to build with its reason, or the reason that the job stops. */
export type RefResult = { readonly sha: string; readonly reason: string } | { readonly error: string };

const SHA = /^[0-9a-f]{40}$/;

/** The events that build the commit of the event. Only a person with write access can start them, or they do not deploy. */
export const OWN_COMMIT_EVENTS: readonly string[] = ["push", "workflow_dispatch", "repository_dispatch", "pull_request"];

/** The events of a run that a workflow_run build can follow. A fork cannot start them in this repository. */
export const RUN_EVENTS: readonly string[] = ["push", "workflow_dispatch"];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hash(sha: string, what: string): RefResult {
  return SHA.test(sha) ? { sha, reason: what } : { error: `${what} is "${sha}", not a commit hash of 40 characters.` };
}

/**
 * This function examines the run that a workflow_run event follows. The run must be a passed run of a push or of
 * workflow_dispatch, on the default branch, of this repository. A pull request of a fork fails each of these checks.
 */
function workflowRunRef(input: RefInput): RefResult {
  const event = record(input.event);
  const run = record(event?.["workflow_run"]);
  if (run === undefined) return { error: "The event workflow_run has no field workflow_run." };
  const name = text(run["name"]) || "the run";
  const runEvent = text(run["event"]);
  if (!RUN_EVENTS.includes(runEvent)) {
    return { error: `${name} came from the event "${runEvent}". A build follows only a run of ${RUN_EVENTS.join(" or ")}.` };
  }
  const conclusion = text(run["conclusion"]);
  if (conclusion !== "success") return { error: `${name} concluded "${conclusion}". A build follows only a passed run.` };
  const defaultBranch = text(record(event?.["repository"])?.["default_branch"]);
  if (defaultBranch === "") return { error: "The event has no default branch (repository.default_branch)." };
  const branch = text(run["head_branch"]);
  if (branch !== defaultBranch) return { error: `${name} is of the branch "${branch}", not of the default branch "${defaultBranch}".` };
  const head = text(record(run["head_repository"])?.["full_name"]);
  if (head.toLowerCase() !== input.repository.toLowerCase() || head === "") {
    return { error: `${name} is of the repository "${head}", not of ${input.repository}. A build never takes the commit of a fork.` };
  }
  if (input.green !== "") return hash(input.green, "The commit of green-main");
  return hash(text(run["head_sha"]), `The commit of ${name}`);
}

/**
 * This function gives the commit that the job build checks out. A scheduled build takes the commit of green-main. A
 * workflow_run build takes the commit of the run that it follows, or of green-main after a release, only after the
 * checks of `workflowRunRef`. An event of `OWN_COMMIT_EVENTS` takes its own commit. Each other event fails.
 */
export function buildRef(input: RefInput): RefResult {
  if (input.eventName === "workflow_run") return workflowRunRef(input);
  if (input.eventName === "schedule") {
    if (input.green === "") return { error: "A scheduled build takes the commit of green-main, and green-main gave none." };
    return hash(input.green, "The commit of green-main");
  }
  if (OWN_COMMIT_EVENTS.includes(input.eventName)) {
    if (input.green !== "") return { error: `green-main gave a commit for the event ${input.eventName}, which keeps its own commit.` };
    return hash(input.sha, `The commit of the event ${input.eventName}`);
  }
  return { error: `This step does not know the event "${input.eventName}". Add it to build-ref with the commit that it builds.` };
}

/** This function operates the step: it reads the environment, writes the output `sha` and gives the exit code. */
export function main(env: NodeJS.ProcessEnv = process.env): number {
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(env["GITHUB_EVENT_PATH"] ?? "", "utf8")) as unknown;
  } catch (error) {
    console.log(`::error::The step cannot read the event file GITHUB_EVENT_PATH: ${(error as Error).message}`);
    return 1;
  }
  const result = buildRef({
    eventName: env["GITHUB_EVENT_NAME"] ?? "",
    event,
    repository: env["GITHUB_REPOSITORY"] ?? "",
    sha: env["GITHUB_SHA"] ?? "",
    green: env["GREEN"] ?? "",
  });
  if ("error" in result) {
    console.log(`::error::${result.error}`);
    return 1;
  }
  console.log(`The build takes ${result.sha}: ${result.reason}.`);
  appendFileSync(env["GITHUB_OUTPUT"] ?? "", `sha=${result.sha}\n`);
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
