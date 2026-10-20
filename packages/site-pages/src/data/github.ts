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

/** This function gives the URL of the next page from a `Link` header of GitHub, or null. */
function nextPage(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * This function reads the published releases of a repository with the REST API, the newest first.
 * It skips the drafts. It gives `{ available: false, reason }` without a token or after an error.
 * It does not throw.
 *
 * @remarks The function reads 100 releases on each page, and at most `maxPages` pages (default 10).
 */
export async function githubReleases(options: GitHubOptions & { endpoint?: string; maxPages?: number }): Promise<GitHubReleases> {
  const stop = precheck(options);
  if (stop) return stop;
  const { owner, repo, token, endpoint = GITHUB_API, maxPages = 10, timeoutMs = 15_000 } = options;
  const fetcher = options.fetch ?? globalThis.fetch;
  const releases: GitHubRelease[] = [];
  let url: string | null = `${endpoint}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=100`;
  try {
    for (let page = 0; url !== null && page < maxPages; page++) {
      const response: Response = await fetcher(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": USER_AGENT,
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) return { available: false, reason: `GitHub has no repository ${owner}/${repo}` };
      if (!response.ok) return { available: false, reason: `GitHub answered with HTTP ${response.status}` };
      const body: unknown = await response.json();
      if (!Array.isArray(body)) return { available: false, reason: "GitHub gave no list of releases" };
      for (const value of body) {
        const release = object(value);
        const tag = release["tag_name"];
        if (release["draft"] === true || typeof tag !== "string") continue;
        releases.push({
          tag,
          name: text(release["name"]) || tag,
          body: text(release["body"]),
          publishedAt: text(release["published_at"]) || text(release["created_at"]),
          url: text(release["html_url"]),
          prerelease: release["prerelease"] === true,
        });
      }
      url = nextPage(response.headers.get("link"));
    }
    return { available: true, releases };
  } catch (error) {
    return failure(error, timeoutMs);
  }
}
