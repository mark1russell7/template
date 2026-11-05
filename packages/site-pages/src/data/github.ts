/**
 * The GitHub sources: the open pull requests and issues (GraphQL), and the releases (REST). Each
 * function gives `{ available: false, reason }` without a token or after an error. A failure of GitHub
 * does not stop the build.
 */

import type { BoardIssue, BoardPullRequest, CheckState, GitHubOpenWork, GitHubRelease, GitHubReleases } from "./types.ts";

/** The GraphQL endpoint of GitHub. */
export const GITHUB_GRAPHQL = "https://api.github.com/graphql";
/** The REST endpoint of GitHub. */
export const GITHUB_API = "https://api.github.com";

const USER_AGENT = "site-pages";

/** The options of the GitHub functions. */
export interface GitHubOptions {
  owner: string;
  repo: string;
  /** A token with read access. Without it, the function sends no request. */
  token: string | undefined;
  /** The `fetch` function. The default is the global `fetch`. */
  fetch?: typeof fetch;
  /** The time limit of each request, in milliseconds. The default is 15000. */
  timeoutMs?: number;
}

const OPEN_WORK_QUERY = `query OpenWork($owner: String!, $repo: String!, $first: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: $first, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes {
        number title url isDraft createdAt updatedAt headRefName
        author { login }
        labels(first: 10) { nodes { name } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
    issues(states: OPEN, first: $first, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes {
        number title url createdAt updatedAt
        author { login }
        labels(first: 10) { nodes { name } }
      }
    }
  }
}`;

/** This function gives the combined check state of a commit: success, failure, pending or none. */
export function checkStateOf(rollup: { state?: string | null } | null | undefined): CheckState {
  switch (rollup?.state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

// The JSON of GitHub has no static type: these helpers read it with care.
type Json = Record<string, unknown>;
const object = (value: unknown): Json => (value !== null && typeof value === "object" ? (value as Json) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const labelsOf = (node: Json): string[] =>
  list(object(node["labels"])["nodes"])
    .map((label) => object(label)["name"])
    .filter((name): name is string => typeof name === "string");
const authorOf = (node: Json): string => text(object(node["author"])["login"], "ghost");

function failure(error: unknown, timeoutMs: number): { available: false; reason: string } {
  const named = object(error);
  if (named["name"] === "TimeoutError") return { available: false, reason: `GitHub did not answer in ${timeoutMs / 1000} s` };
  return { available: false, reason: `the request failed: ${error instanceof Error ? error.message : String(error)}` };
}

function precheck(options: GitHubOptions): { available: false; reason: string } | null {
  if (!options.owner || !options.repo) return { available: false, reason: "no repository was given" };
  if (!options.token) return { available: false, reason: "the build had no GitHub token" };
  if (typeof (options.fetch ?? globalThis.fetch) !== "function") return { available: false, reason: "this Node has no fetch" };
  return null;
}

/**
 * This function reads the open pull requests and issues of a repository with one GraphQL request,
 * the most recently updated first. It gives `{ available: false, reason }` without a token or after
 * an error. It does not throw.
 */
export async function githubOpenWork(options: GitHubOptions & { endpoint?: string; first?: number }): Promise<GitHubOpenWork> {
  const stop = precheck(options);
  if (stop) return stop;
  const { owner, repo, token, endpoint = GITHUB_GRAPHQL, first = 50, timeoutMs = 15_000 } = options;
  const fetcher = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { authorization: `bearer ${token}`, "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ query: OPEN_WORK_QUERY, variables: { owner, repo, first } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { available: false, reason: `GitHub answered with HTTP ${response.status}` };
    const body = object(await response.json());
    const errors = list(body["errors"]);
    if (errors.length > 0) {
      return { available: false, reason: `GitHub gave an error: ${text(object(errors[0])["message"], "no message")}` };
    }
    const repository = object(body["data"])["repository"];
    if (repository === null || typeof repository !== "object") return { available: false, reason: `GitHub has no repository ${owner}/${repo}` };
    const pulls = object((repository as Json)["pullRequests"]);
    const open = object((repository as Json)["issues"]);
    const pullRequests: BoardPullRequest[] = list(pulls["nodes"])
      .filter((node) => node !== null && typeof node === "object")
      .map((value) => {
        const node = object(value);
        const lastCommit = object(object(list(object(node["commits"])["nodes"])[0])["commit"]);
        return {
          number: Number(node["number"]),
          title: text(node["title"]),
          url: text(node["url"]),
          author: authorOf(node),
          branch: text(node["headRefName"]),
          draft: node["isDraft"] === true,
          createdAt: text(node["createdAt"]),
          updatedAt: text(node["updatedAt"]),
          labels: labelsOf(node),
          checks: checkStateOf(object(lastCommit["statusCheckRollup"]) as { state?: string }),
        };
      });
    const issues: BoardIssue[] = list(open["nodes"])
      .filter((node) => node !== null && typeof node === "object")
      .map((value) => {
        const node = object(value);
        return {
          number: Number(node["number"]),
          title: text(node["title"]),
          url: text(node["url"]),
          author: authorOf(node),
          createdAt: text(node["createdAt"]),
          updatedAt: text(node["updatedAt"]),
          labels: labelsOf(node),
        };
      });
    const total = (value: unknown, fallback: number): number => (typeof value === "number" ? value : fallback);
    return {
      available: true,
      pullRequests,
      issues,
      totals: { pullRequests: total(pulls["totalCount"], pullRequests.length), issues: total(open["totalCount"], issues.length) },
    };
  } catch (error) {
    return failure(error, timeoutMs);
  }
}

/** This function gives the URL of the page with the relation `rel` from a `Link` header of GitHub, or null. */
function linkedPage(link: string | null, rel: "next" | "last"): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="([a-z]+)"/.exec(part);
    if (match?.[1] && match[2] === rel) return match[1];
  }
  return null;
}

const restHeaders = (token: string): Record<string, string> => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "user-agent": USER_AGENT,
  "x-github-api-version": "2022-11-28",
});

/**
 * This function reads the published releases, the newest first, and stops after the first release for which `enough` is true.
 * It reads 100 releases on each page, and at most `maxPages` pages.
 */
async function readReleasePages(
  options: GitHubOptions & { endpoint?: string; maxPages?: number },
  enough: (release: GitHubRelease) => boolean,
): Promise<GitHubReleases> {
  const stop = precheck(options);
  if (stop) return stop;
  const { owner, repo, token = "", endpoint = GITHUB_API, maxPages = 10, timeoutMs = 15_000 } = options;
  const fetcher = options.fetch ?? globalThis.fetch;
  const releases: GitHubRelease[] = [];
  let url: string | null = `${endpoint}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=100`;
  try {
    for (let page = 0; url !== null && page < maxPages; page++) {
      const response: Response = await fetcher(url, { headers: restHeaders(token), signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 404) return { available: false, reason: `GitHub has no repository ${owner}/${repo}` };
      if (!response.ok) return { available: false, reason: `GitHub answered with HTTP ${response.status}` };
      const body: unknown = await response.json();
      if (!Array.isArray(body)) return { available: false, reason: "GitHub gave no list of releases" };
      for (const value of body) {
        const release = object(value);
        const tag = release["tag_name"];
        if (release["draft"] === true || typeof tag !== "string") continue;
        const entry: GitHubRelease = {
          tag,
          name: text(release["name"]) || tag,
          body: text(release["body"]),
          publishedAt: text(release["published_at"]) || text(release["created_at"]),
          url: text(release["html_url"]),
          prerelease: release["prerelease"] === true,
        };
        releases.push(entry);
        if (enough(entry)) return { available: true, releases };
      }
      url = linkedPage(response.headers.get("link"), "next");
    }
    return { available: true, releases };
  } catch (error) {
    return failure(error, timeoutMs);
  }
}

/**
 * This function reads the published releases of a repository with the REST API, the newest first.
 * It skips the drafts. It gives `{ available: false, reason }` without a token or after an error.
 * It does not throw.
 *
 * @remarks The function reads 100 releases on each page, and at most `maxPages` pages (default 10).
 */
export async function githubReleases(options: GitHubOptions & { endpoint?: string; maxPages?: number }): Promise<GitHubReleases> {
  return readReleasePages(options, () => false);
}

/** The result of `githubReleaseLag`. The field `at` is the time of the read, and `release` is the tag of the release. */
export type GitHubReleaseLag = { available: true; value: number; at: string; release: string } | { available: false; reason: string };

const DAY_MS = 86_400_000;

/**
 * This function gives the age in days of the oldest commit after a release, rounded to 2 decimals. It gives 0 when no commit
 * follows the release.
 *
 * @param oldest - The commit date of the oldest commit after the release, or undefined for no commit.
 * @param now - The time of the read, as an ISO date.
 */
export function releaseLagOf(oldest: string | undefined, now: string): number {
  if (oldest === undefined) return 0;
  const days = (Date.parse(now) - Date.parse(oldest)) / DAY_MS;
  return Number.isFinite(days) ? Math.max(0, Math.round(days * 100) / 100) : Number.NaN;
}

/**
 * This function reads how many days a branch is ahead of its newest release. That is the age of the oldest commit of the branch
 * after the newest release whose tag starts with `tagPrefix`. It skips drafts and pre-releases, because a pre-release is not the
 * version that most users get. It gives `{ available: false, reason }` without a token, after an error, or with no such release.
 *
 * @remarks The function reads the releases until it finds one, at most `maxPages` pages of 100 (default 10). It then reads one
 * commit on each page of the branch since that release, and asks GitHub for the last page only.
 */
export async function githubReleaseLag(
  options: GitHubOptions & { tagPrefix: string; branch?: string; endpoint?: string; maxPages?: number; now?: string },
): Promise<GitHubReleaseLag> {
  const { owner, repo, token = "", tagPrefix, branch = "main", endpoint = GITHUB_API, timeoutMs = 15_000 } = options;
  const now = options.now ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const wanted = (release: GitHubRelease): boolean => !release.prerelease && release.tag.startsWith(tagPrefix);
  const releases = await readReleasePages(options, wanted);
  if (!releases.available) return releases;
  const release = releases.releases.find(wanted);
  if (release === undefined) return { available: false, reason: `no release has a tag that starts with ${tagPrefix}` };
  if (!Number.isFinite(Date.parse(release.publishedAt))) return { available: false, reason: `the release ${release.tag} has no date` };
  const fetcher = options.fetch ?? globalThis.fetch;
  const read = async (url: string): Promise<Response> => fetcher(url, { headers: restHeaders(token), signal: AbortSignal.timeout(timeoutMs) });
  const first = `${endpoint}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(release.publishedAt)}&per_page=1`;
  try {
    let response = await read(first);
    const last = response.ok ? linkedPage(response.headers.get("link"), "last") : null;
    if (last !== null) response = await read(last);
    if (response.status === 404) return { available: false, reason: `GitHub has no branch ${branch} in ${owner}/${repo}` };
    if (!response.ok) return { available: false, reason: `GitHub answered with HTTP ${response.status}` };
    const body: unknown = await response.json();
    if (!Array.isArray(body)) return { available: false, reason: "GitHub gave no list of commits" };
    const commit = body.length === 0 ? undefined : text(object(object(object(body.at(-1))["commit"])["committer"])["date"]);
    if (commit === "") return { available: false, reason: "the oldest commit has no date" };
    const value = releaseLagOf(commit, now);
    if (!Number.isFinite(value)) return { available: false, reason: "the time of the read is not a date" };
    return { available: true, value, at: now, release: release.tag };
  } catch (error) {
    return failure(error, timeoutMs);
  }
}

/** The result of `githubGreenRun`. The field `at` is the end of the newest scheduled run that ended. */
export type GitHubGreenRun = { available: true; value: number; at: string } | { available: false; reason: string };

/** One workflow run, with only the fields that `greenRunOf` reads. */
export interface WorkflowRunEnd {
  readonly status: string;
  readonly conclusion: string | null;
  readonly updated_at: string;
}

/**
 * This function counts the runs that passed in a row, from the newest run. A run that has not ended does not count and does not break the row.
 * Each other conclusion breaks the row, a cancelled run too. It gives null when no run ended.
 *
 * @param runs - The runs, the newest first.
 */
export function greenRunOf(runs: readonly WorkflowRunEnd[]): { value: number; at: string } | null {
  const ended = runs.filter((run) => run.status === "completed");
  const newest = ended[0];
  if (newest === undefined) return null;
  const broken = ended.findIndex((run) => run.conclusion !== "success");
  return { value: broken === -1 ? ended.length : broken, at: newest.updated_at };
}

/**
 * This function reads the scheduled runs of a workflow with the REST API, and counts the runs that passed in a row.
 * It gives `{ available: false, reason }` without a token, after an error, or when no scheduled run ended.
 * A caller then leaves the measure out, because 0 says that a run failed.
 *
 * @remarks The function reads at most `limit` runs (default 30), so the count stops at that limit.
 */
export async function githubGreenRun(options: GitHubOptions & { workflow: string; endpoint?: string; limit?: number }): Promise<GitHubGreenRun> {
  const stop = precheck(options);
  if (stop) return stop;
  const { owner, repo, token, workflow, endpoint = GITHUB_API, limit = 30, timeoutMs = 15_000 } = options;
  const fetcher = options.fetch ?? globalThis.fetch;
  const url = `${endpoint}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=schedule&per_page=${limit}`;
  try {
    const response = await fetcher(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": USER_AGENT,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return { available: false, reason: `GitHub has no workflow ${workflow} in ${owner}/${repo}` };
    if (!response.ok) return { available: false, reason: `GitHub answered with HTTP ${response.status}` };
    const runs = list(object(await response.json())["workflow_runs"]).map((value) => {
      const run = object(value);
      return { status: text(run["status"]), conclusion: typeof run["conclusion"] === "string" ? run["conclusion"] : null, updated_at: text(run["updated_at"]) };
    });
    const green = greenRunOf(runs);
    if (green === null) return { available: false, reason: `the workflow ${workflow} has no scheduled run that ended` };
    return { available: true, ...green };
  } catch (error) {
    return failure(error, timeoutMs);
  }
}

/** The progress of one workflow run: its state, and the newest end of one of its jobs. */
export interface RunProgress {
  /** The state of the run, as GitHub gives it: `queued`, `in_progress` or `completed`. */
  readonly status: string;
  /** The result of a run that ended, for example `success` or `cancelled`. It is null while the run has not ended. */
  readonly conclusion: string | null;
  /** The ISO time of the newest end of a job of the run. It is null when no job ended. */
  readonly lastJobEnd: string | null;
}

/** One job of a workflow run, with only the field that `runProgressOf` reads. */
export interface WorkflowJobEnd {
  readonly completed_at: string | null;
}

/** The result of `githubRunProgress`. */
export type GitHubRunProgress = ({ available: true } & RunProgress) | { available: false; reason: string };

/** This function gives the progress of a run from its state and its jobs. A job that has not ended does not count. */
export function runProgressOf(run: { readonly status: string; readonly conclusion: string | null }, jobs: readonly WorkflowJobEnd[]): RunProgress {
  const ends = jobs.map((job) => job.completed_at).filter((at): at is string => typeof at === "string" && Number.isFinite(Date.parse(at)));
  const lastJobEnd = ends.reduce<string | null>((newest, at) => (newest === null || Date.parse(at) > Date.parse(newest) ? at : newest), null);
  return { status: run.status, conclusion: run.conclusion, lastJobEnd };
}

/**
 * This function reads the state of a workflow run and the ends of its jobs with the REST API.
 * It gives `{ available: false, reason }` without a token or after an error. It does not throw.
 *
 * @remarks The function reads 100 jobs on each page, and at most `maxPages` pages (default 10). It reads only the newest try of each job.
 */
export async function githubRunProgress(options: GitHubOptions & { runId: string; endpoint?: string; maxPages?: number }): Promise<GitHubRunProgress> {
  const stop = precheck(options);
  if (stop) return stop;
  const { owner, repo, token, runId, endpoint = GITHUB_API, maxPages = 10, timeoutMs = 15_000 } = options;
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": USER_AGENT, "x-github-api-version": "2022-11-28" };
  const base = `${endpoint}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}`;
  try {
    const response = await fetcher(base, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 404) return { available: false, reason: `GitHub has no run ${runId} in ${owner}/${repo}` };
    if (!response.ok) return { available: false, reason: `GitHub answered with HTTP ${response.status}` };
    const run = object(await response.json());
    if (typeof run["status"] !== "string") return { available: false, reason: `GitHub gave no state of the run ${runId}` };
    const jobs: WorkflowJobEnd[] = [];
    let url: string | null = `${base}/jobs?filter=latest&per_page=100`;
    for (let page = 0; url !== null; page++) {
      if (page === maxPages) return { available: false, reason: `the run ${runId} has more than ${maxPages} pages of jobs` };
      const jobsResponse: Response = await fetcher(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!jobsResponse.ok) return { available: false, reason: `GitHub answered with HTTP ${jobsResponse.status} for the jobs of the run ${runId}` };
      for (const value of list(object(await jobsResponse.json())["jobs"])) {
        const at = object(value)["completed_at"];
        jobs.push({ completed_at: typeof at === "string" ? at : null });
      }
      url = linkedPage(jobsResponse.headers.get("link"), "next");
    }
    const conclusion = typeof run["conclusion"] === "string" ? run["conclusion"] : null;
    return { available: true, ...runProgressOf({ status: run["status"], conclusion }, jobs) };
  } catch (error) {
    return failure(error, timeoutMs);
  }
}
