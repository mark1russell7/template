// The step "Wait for an open release" of the action release-check (action.yml). pack.ts compares the packages of the
// commit with npm. A release run of the repository that is still open can publish a version after that comparison. For
// example, on 2026-11-24 a check read version 0.4.0 as a new version while the release of the pull request before it
// published 0.4.0. The check passed, and the release after the merge refused the version. So this step reads the runs of
// the release workflow. While a run is queued or running, it reads again, up to a limit. Then pack.ts compares with the
// npm that the release has updated.
//   - No open run, or all open runs end in the limit: the step passes.
//   - A run is still open at the limit: the step fails. The check cannot decide, so it does not pass. Run it again
//     after the release ends.
//   - The step cannot read the runs: it gives a notice or a warning and passes. The check then compares with npm as it
//     is now, as before this step. The release itself still refuses a version that npm has. A token of a private
//     repository cannot read the runs: release.yml calls ci.yml with "contents: read" only, and a called job cannot
//     get more permissions than its caller. A public repository needs no permission for this read.
// A gap: a release run that starts after the last read is not seen. A push to main starts its release run in some
// seconds, and the job starts later than that, so the gap is small.
// The function waitForReleases takes the fetch and the clock as parameters, so the tests give fakes
// (.github/actions/release-runs.test.ts). main() reads the environment of the step. It uses only node: modules,
// because the step starts before the install.
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A function with the shape of `fetch`, for the tests. */
export type Fetch = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;

/** The facts of the read. */
export interface RunsInput {
  /** The URL of the REST API, from `GITHUB_API_URL`. */
  readonly api: string;
  /** The token of the job. An empty token sends no Authorization header. */
  readonly token: string;
  /** The repository, `owner/name`, from `GITHUB_REPOSITORY`. */
  readonly repository: string;
  /** The file name of the release workflow, for example `release.yml`. */
  readonly workflow: string;
}

/** The clock of the step. The tests give a clock that does not wait. */
export interface RunsTiming {
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** The most time that the step waits for the open runs, in milliseconds. */
  readonly limitMs: number;
  /** The time before each read again, in milliseconds. */
  readonly waitMs: number;
}

/** An open run of the release workflow. */
export interface OpenRun {
  readonly id: number;
  readonly status: string;
  readonly url: string;
}

/** The result of the step. */
export type RunsResult =
  | { readonly kind: "clear"; readonly waitedMs: number; readonly ended: readonly number[] }
  | { readonly kind: "open"; readonly waitedMs: number; readonly runs: readonly OpenRun[] }
  | { readonly kind: "unread"; readonly level: "notice" | "warning"; readonly reason: string };

/** The reads again after a failed read (HTTP 429 or 5xx, or no answer), before the step gives up. */
export const TRANSIENT_RETRIES = 3;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** This function gives the runs of a list of runs that are not completed. It gives undefined for a body of another shape. */
export function openRuns(body: unknown): OpenRun[] | undefined {
  const runs = record(body)?.["workflow_runs"];
  if (!Array.isArray(runs)) return undefined;
  const open: OpenRun[] = [];
  for (const item of runs) {
    const run = record(item);
    const status = run?.["status"];
    const id = run?.["id"];
    if (typeof status !== "string" || typeof id !== "number") return undefined;
    const url = run?.["html_url"];
    if (status !== "completed") open.push({ id, status, url: typeof url === "string" ? url : "" });
  }
  return open;
}

type Read = { readonly runs: OpenRun[] } | { readonly level: "notice" | "warning"; readonly reason: string };

/** This function reads the newest runs of the workflow once, with the reads again of a failed read. */
async function readOnce(fetcher: Fetch, input: RunsInput, sleep: (ms: number) => Promise<void>, waitMs: number): Promise<Read> {
  const path = `repos/${input.repository.split("/").map(encodeURIComponent).join("/")}/actions/workflows/${encodeURIComponent(input.workflow)}/runs`;
  const url = `${input.api.replace(/\/+$/u, "")}/${path}?per_page=30&exclude_pull_requests=true`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (input.token !== "") headers["Authorization"] = `Bearer ${input.token}`;
  let last = "";
  for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
    if (attempt > 0) await sleep(waitMs);
    let status: number;
    let text: string;
    try {
      const response = await fetcher(url, { method: "GET", headers });
      status = response.status;
      text = await response.text();
    } catch (error) {
      last = `GET ${path} gave no answer: ${error instanceof Error ? error.message : String(error)}.`;
      continue;
    }
    if (status === 429 || (status >= 500 && status <= 599)) {
      last = `GET ${path} gave HTTP ${String(status)}.`;
      continue;
    }
    if (status === 404) return { level: "notice", reason: `The repository has no workflow ${input.workflow}, or the token cannot read its runs (GET ${path} gave HTTP 404).` };
    if (status === 401 || status === 403) return { level: "notice", reason: `The token cannot read the runs of ${input.workflow} (GET ${path} gave HTTP ${String(status)}). A private repository needs the permission "actions: read", and its release.yml does not give it.` };
    if (status < 200 || status > 299) return { level: "warning", reason: `GET ${path} gave HTTP ${String(status)}.` };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { level: "warning", reason: `GET ${path} gave a body that is not JSON.` };
    }
    const runs = openRuns(body);
    return runs === undefined ? { level: "warning", reason: `GET ${path} gave a body with no list workflow_runs.` } : { runs };
  }
  return { level: "warning", reason: `${last} The step read it ${String(TRANSIENT_RETRIES + 1)} times.` };
}

/**
 * This function waits while a run of the release workflow is open, up to the limit of the timing. Each read lists the
 * 30 newest runs of the workflow. A run that a read sees open and a later read sees completed is in `ended`.
 */
export async function waitForReleases(fetcher: Fetch, input: RunsInput, timing: RunsTiming): Promise<RunsResult> {
  const start = timing.now();
  const seen = new Set<number>();
  for (;;) {
    const read = await readOnce(fetcher, input, timing.sleep, timing.waitMs);
    if ("reason" in read) return { kind: "unread", level: read.level, reason: read.reason };
    const waitedMs = timing.now() - start;
    if (read.runs.length === 0) return { kind: "clear", waitedMs, ended: [...seen] };
    for (const run of read.runs) seen.add(run.id);
    if (waitedMs + timing.waitMs > timing.limitMs) return { kind: "open", waitedMs, runs: read.runs };
    await timing.sleep(timing.waitMs);
  }
}

/** This function gives the log line and the exit code of a result. */
export function reportOf(result: RunsResult, workflow: string, limitMinutes: number): { readonly line: string; readonly code: number } {
  if (result.kind === "unread") return { line: `::${result.level} title=Release runs::${result.reason} The check compares with npm as it is now.`, code: 0 };
  const seconds = String(Math.round(result.waitedMs / 1000));
  if (result.kind === "clear") {
    const ended = result.ended.length === 0 ? `No run of ${workflow} is open.` : `The open runs of ${workflow} ended (${result.ended.join(", ")}) after ${seconds} s.`;
    return { line: `${ended} The check compares with npm now.`, code: 0 };
  }
  const runs = result.runs.map((run) => `${String(run.id)} (${run.status})${run.url === "" ? "" : ` ${run.url}`}`).join(", ");
  return {
    line: `::error title=Release runs::A run of ${workflow} is still open after ${String(limitMinutes)} minutes: ${runs}. That run can publish a version after the comparison with npm, so the check cannot decide. Run the check again after the run ends.`,
    code: 1,
  };
}

/** The time before each read again: 20 seconds. */
export const WAIT_MS = 20_000;

export async function main(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: Fetch = fetch,
  timing: Pick<RunsTiming, "sleep" | "now"> = { sleep: (ms) => new Promise((done) => setTimeout(done, ms)), now: () => Date.now() },
): Promise<number> {
  const workflow = env["RELEASE_WORKFLOW"] ?? "release.yml";
  const minutes = Number(env["WAIT_MINUTES"] ?? "10");
  if (!Number.isFinite(minutes) || minutes < 0) {
    console.log(`::error title=Release runs::The input wait-minutes is "${env["WAIT_MINUTES"] ?? ""}", and it must be a number of 0 or more.`);
    return 1;
  }
  if (minutes === 0) {
    console.log(`The input wait-minutes is 0, so the step does not read the runs of ${workflow}.`);
    return 0;
  }
  const input: RunsInput = { api: env["GITHUB_API_URL"] ?? "https://api.github.com", token: env["GH_TOKEN"] ?? "", repository: env["GITHUB_REPOSITORY"] ?? "", workflow };
  const result = await waitForReleases(fetcher, input, { ...timing, limitMs: minutes * 60_000, waitMs: WAIT_MS });
  const report = reportOf(result, workflow, minutes);
  console.log(report.line);
  const summary = env["GITHUB_STEP_SUMMARY"];
  if (report.code !== 0 && summary !== undefined && summary !== "") appendFileSync(summary, `### Release check\n\n${report.line.replace(/^::\w+ title=[^:]+::/u, "")}\n`);
  return report.code;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
