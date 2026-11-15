// The step "Build and deploy" of the action build-ref (action.yml), in the job ref of reusable-pages.yml. The job
// build checks out the commit of the event (github.sha), with no ref of its own. This step decides if that commit
// builds and if it deploys. It fails closed: an event or a field that it does not know stops the job with its reason.
// A run that a fork starts never deploys. The pure function buildRef has no I/O, so the tests call it directly
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
  /** The commit of the event, from `GITHUB_SHA`. The job build checks out this commit. */
  readonly sha: string;
  /** The ref of the event, from `GITHUB_REF`, for example `refs/heads/main`. */
  readonly ref: string;
  /** The default branch of the repository, from the API. */
  readonly defaultBranch: string;
  /** The CI state of `sha`, or an empty string when the step did not read it (only for a push or a pull request). */
  readonly state: string;
  /** What to do while CI of `sha` has not finished: `head` deploys it, as a push deploy does. `green` waits for CI. */
  readonly pending: string;
}

/** The decision of the step with its reason, or the reason that the job stops. */
export type RefResult = { readonly build: boolean; readonly deploy: boolean; readonly reason: string } | { readonly error: string };

const SHA = /^[0-9a-f]{40}$/;

/** The events whose commit is the head of the default branch, and that deploy only after the CI check of `ciGate`. */
export const HEAD_EVENTS: readonly string[] = ["schedule", "workflow_dispatch", "repository_dispatch"];

/** The events of a run that a workflow_run build can follow. A fork cannot start them in this repository. */
export const RUN_EVENTS: readonly string[] = ["push", "workflow_dispatch"];

/** The CI states that the step knows. */
export const CI_STATES: readonly string[] = ["green", "running", "none", "red"];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const build = (reason: string): RefResult => ({ build: true, deploy: false, reason });
const deploy = (reason: string): RefResult => ({ build: true, deploy: true, reason });
const skip = (reason: string): RefResult => ({ build: false, deploy: false, reason });

/**
 * This function decides a run on the head of the default branch. These runs are a schedule, a run by hand, a
 * repository dispatch and a run after a release. A green commit deploys. A commit whose CI has not finished deploys when `pending`
 * is `head`, because its push deploy is already on the site. A red commit deploys nothing, so the site keeps its last
 * deploy and does not go back to an older commit.
 */
function ciGate(input: RefInput, what: string): RefResult {
  if (!CI_STATES.includes(input.state)) return { error: `The CI state of ${input.sha} is "${input.state}", not one of ${CI_STATES.join(", ")}.` };
  if (input.pending !== "head" && input.pending !== "green") return { error: `The input pending is "${input.pending}", not "head" or "green".` };
  if (input.state === "green") return deploy(`${what} is at ${input.sha}, and CI passed on it`);
  if (input.state === "red") return skip(`${what} is at ${input.sha}, and CI failed on it. The site keeps its last deploy`);
  const ci = input.state === "running" ? "CI has not finished on it" : "it has no CI run";
  if (input.pending === "head") return deploy(`${what} is at ${input.sha}, ${ci}, and the input pending is "head"`);
  return skip(`${what} is at ${input.sha}, ${ci}, and the input pending is "green". The site keeps its last deploy`);
}

/**
 * This function examines the run that a workflow_run event follows. The run must be a passed run of a push or of
 * workflow_dispatch, on the default branch, of this repository. A pull request of a fork fails each of these checks.
 * After a release, `ciGate` decides. After CI, the commit deploys only when it is the commit that CI examined. Else a
 * newer commit is on the branch, and its own CI run deploys it.
 */
function workflowRun(input: RefInput): RefResult {
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
  const branch = text(run["head_branch"]);
  if (branch !== input.defaultBranch) return { error: `${name} is of the branch "${branch}", not of the default branch "${input.defaultBranch}".` };
  const head = text(record(run["head_repository"])?.["full_name"]);
  if (head.toLowerCase() !== input.repository.toLowerCase() || head === "") {
    return { error: `${name} is of the repository "${head}", not of ${input.repository}. A build never follows a run of a fork.` };
  }
  if (name === "Release") return ciGate(input, "After the release, the default branch");
  const examined = text(run["head_sha"]);
  if (!SHA.test(examined)) return { error: `The commit of ${name} is "${examined}", not a commit hash of 40 characters.` };
  if (examined === input.sha) return deploy(`${name} passed on ${input.sha}, the head of the default branch`);
  return skip(`${name} passed on ${examined}, and the default branch is at ${input.sha}. The ${name} run of that commit deploys it`);
}

/**
 * This function decides if the commit of the event builds and deploys. A push to the default branch deploys its
 * commit. A pull request and a push to a different branch build, and do not deploy. A schedule, a run by hand and a
 * repository dispatch on the default branch deploy after the check of `ciGate`. A workflow_run follows the checks of
 * `workflowRun`. Each other event fails.
 */
export function buildRef(input: RefInput): RefResult {
  if (!SHA.test(input.sha)) return { error: `The commit of the event is "${input.sha}", not a commit hash of 40 characters.` };
  if (input.defaultBranch === "") return { error: "The step has no default branch of the repository." };
  const onDefault = input.ref === `refs/heads/${input.defaultBranch}`;
  if (input.eventName === "pull_request") return build(`A pull request builds its commit ${input.sha} and never deploys`);
  if (input.eventName === "push") {
    if (onDefault) return deploy(`A push to the default branch deploys its commit ${input.sha}`);
    return build(`A push to ${input.ref} builds its commit ${input.sha}, and only the default branch deploys`);
  }
  if (input.eventName === "workflow_run") return workflowRun(input);
  if (HEAD_EVENTS.includes(input.eventName)) {
    if (!onDefault) return build(`The event ${input.eventName} of ${input.ref} builds its commit ${input.sha}, and only the default branch deploys`);
    return ciGate(input, `The default branch of the event ${input.eventName}`);
  }
  return { error: `This step does not know the event "${input.eventName}". Add it to build-ref with its rule.` };
}

/** This function gives the Markdown of the step summary: the decision and its reason. */
export function summary(result: RefResult): string {
  if ("error" in result) return `### Pages: no build\n\n${result.error}\n`;
  const yes = (value: boolean): string => (value ? "yes" : "no");
  return `### Pages: build ${yes(result.build)}, deploy ${yes(result.deploy)}\n\n${result.reason}.\n`;
}

/** This function operates the step: it reads the environment, writes the outputs and the summary, and gives the exit code. */
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
    ref: env["GITHUB_REF"] ?? "",
    defaultBranch: env["DEFAULT_BRANCH"] ?? "",
    state: env["STATE"] ?? "",
    pending: env["PENDING"] ?? "head",
  });
  const file = env["GITHUB_STEP_SUMMARY"];
  if (file !== undefined && file !== "") appendFileSync(file, summary(result));
  if ("error" in result) {
    console.log(`::error::${result.error}`);
    return 1;
  }
  console.log(result.deploy ? `${result.reason}.` : `::notice title=Pages::${result.reason}.`);
  appendFileSync(env["GITHUB_OUTPUT"] ?? "", `build=${result.build}\ndeploy=${result.deploy}\n`);
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
