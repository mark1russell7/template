import { describe, expect, it } from "vitest";
import { githubReleaseLag, githubReleases, releaseLagOf } from "./github.ts";

const NOW = "2026-11-05T12:00:00Z";

describe("the age of the oldest commit after a release", () => {
  it("gives the days from the oldest commit to the read, rounded to 2 decimals", () => {
    expect(releaseLagOf("2026-11-04T00:00:00Z", NOW)).toBe(1.5);
    expect(releaseLagOf("2026-11-05T11:00:00Z", NOW)).toBe(0.04);
  });

  it("gives 0 with no commit after the release, and NaN for a time that is not a date", () => {
    expect(releaseLagOf(undefined, NOW)).toBe(0);
    expect(releaseLagOf("no date", NOW)).toBeNaN();
  });
});

type Answer = { body: unknown; status?: number; link?: string };

/** This fake GitHub answers each URL from a table, and records the URLs in their order. */
function fakeGitHub(table: Record<string, Answer>): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    const answer = table[url];
    if (answer === undefined) return new Response("{}", { status: 404 });
    const headers: Record<string, string> = answer.link === undefined ? {} : { link: answer.link };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers });
  }) as unknown as typeof fetch;
  return { fetch: fetcher, urls };
}

const API = "https://api.github.com/repos/o/r";
const release = (tag: string, published_at: string, more: Record<string, unknown> = {}) => ({ tag_name: tag, published_at, ...more });
const commit = (date: string) => ({ commit: { committer: { date } } });
/** The comparison of the tag of a release with main, with one commit on each page. */
const compareOf = (tag: string): string => `${API}/compare/${encodeURIComponent(tag)}...main?per_page=1`;
const COMPARE = compareOf("pkg@1.0.0");

describe("the read from GitHub", () => {
  const options = { owner: "o", repo: "r", token: "t", tagPrefix: "pkg@", now: NOW };

  it("takes the newest release of the prefix, skips a pre-release, and reads the oldest commit that the tag does not contain", async () => {
    const github = fakeGitHub({
      [`${API}/releases?per_page=100`]: {
        body: [release("other@2.0.0", "2026-11-04T00:00:00Z"), release("pkg@1.1.0-rc.0", "2026-11-03T00:00:00Z", { prerelease: true }), release("pkg@1.0.0", "2026-11-01T00:00:00Z")],
        link: `<${API}/releases?per_page=100&page=2>; rel="next"`,
      },
      // 350 commits after the tag: the first page of one commit holds the oldest of them
      [COMPARE]: { body: { ahead_by: 350, commits: [commit("2026-11-02T12:00:00Z")] }, link: `<${COMPARE}&page=2>; rel="next", <${COMPARE}&page=350>; rel="last"` },
    });
    expect(await githubReleaseLag({ ...options, fetch: github.fetch })).toEqual({ available: true, value: 3, at: NOW, release: "pkg@1.0.0" });
    expect(github.urls).toEqual([`${API}/releases?per_page=100`, COMPARE]);
  });

  it("counts a commit merged after the tag and before the release was published", async () => {
    // The tag was made at 02:51, a pull request merged at 02:54, and the release was published at 03:14 (coeval v0.22.0, 2026-11-04).
    const github = fakeGitHub({
      [`${API}/releases?per_page=100`]: { body: [release("v0.22.0", "2026-11-04T03:14:58Z")] },
      [compareOf("v0.22.0")]: { body: { ahead_by: 32, commits: [commit("2026-11-04T02:54:31Z")] } },
    });
    expect(await githubReleaseLag({ ...options, tagPrefix: "v", fetch: github.fetch })).toEqual({ available: true, value: 1.38, at: NOW, release: "v0.22.0" });
  });

  it("takes the newest release in the order of GitHub, not the highest version, and encodes a tag with a scope", async () => {
    // A fix of an older line, released after a newer version, is the newest release.
    const github = fakeGitHub({
      [`${API}/releases?per_page=100`]: { body: [release("@s/pkg@1.0.5", "2026-11-04T00:00:00Z"), release("@s/pkg@2.0.0", "2026-11-03T00:00:00Z")] },
      [compareOf("@s/pkg@1.0.5")]: { body: { ahead_by: 0, commits: [] } },
    });
    expect(await githubReleaseLag({ ...options, tagPrefix: "@s/pkg@", fetch: github.fetch })).toEqual({ available: true, value: 0, at: NOW, release: "@s/pkg@1.0.5" });
    expect(github.urls[1]).toBe(`${API}/compare/%40s%2Fpkg%401.0.5...main?per_page=1`);
  });

  it("gives 0 when no commit follows the release", async () => {
    const github = fakeGitHub({ [`${API}/releases?per_page=100`]: { body: [release("pkg@1.0.0", "2026-11-01T00:00:00Z")] }, [COMPARE]: { body: { ahead_by: 0, commits: [] } } });
    expect(await githubReleaseLag({ ...options, fetch: github.fetch })).toEqual({ available: true, value: 0, at: NOW, release: "pkg@1.0.0" });
  });

  it("is not available with no token, no release of the prefix, or an error of GitHub", async () => {
    expect((await githubReleaseLag({ ...options, token: undefined })).available).toBe(false);
    const none = fakeGitHub({ [`${API}/releases?per_page=100`]: { body: [release("other@1.0.0", "2026-11-01T00:00:00Z")] } });
    expect(await githubReleaseLag({ ...options, fetch: none.fetch })).toEqual({ available: false, reason: "no release has a tag that starts with pkg@" });
    const broken = fakeGitHub({ [`${API}/releases?per_page=100`]: { body: [release("pkg@1.0.0", "2026-11-01T00:00:00Z")] }, [COMPARE]: { body: {}, status: 500 } });
    expect(await githubReleaseLag({ ...options, fetch: broken.fetch })).toEqual({ available: false, reason: "GitHub answered with HTTP 500" });
    const gone = fakeGitHub({ [`${API}/releases?per_page=100`]: { body: [release("pkg@1.0.0", "2026-11-01T00:00:00Z")] } });
    expect(await githubReleaseLag({ ...options, fetch: gone.fetch })).toEqual({ available: false, reason: "GitHub has no tag pkg@1.0.0 or no branch main in o/r" });
  });

  it("leaves githubReleases as it was: it reads each page and skips only the drafts", async () => {
    const github = fakeGitHub({
      [`${API}/releases?per_page=100`]: { body: [release("a@1.0.0", "2026-11-02T00:00:00Z"), release("b@1.0.0", "2026-11-01T00:00:00Z", { draft: true })], link: `<${API}/releases?page=2>; rel="next"` },
      [`${API}/releases?page=2`]: { body: [release("c@1.0.0", "2026-10-01T00:00:00Z", { prerelease: true })] },
    });
    const read = await githubReleases({ owner: "o", repo: "r", token: "t", fetch: github.fetch });
    expect(read.available && read.releases.map((entry) => entry.tag)).toEqual(["a@1.0.0", "c@1.0.0"]);
  });
});
