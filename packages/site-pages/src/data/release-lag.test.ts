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
/** A commit of a comparison: its SHA, its parents (the first parent first) and its commit date. */
const commit = (sha: string, date: string, ...parents: string[]) => ({ sha, parents: parents.map((parent) => ({ sha: parent })), commit: { committer: { date } } });
/** A straight line of `count` commits after the tag commit `base`, one each hour from `first`, the oldest first. */
function line(base: string, first: string, count: number) {
  return Array.from({ length: count }, (_, index) =>
    commit(`c${index}`, new Date(Date.parse(first) + index * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z"), index === 0 ? base : `c${index - 1}`));
}
/** The comparison of the tag of a release with main, with 100 commits on each page. */
const compareOf = (tag: string): string => `${API}/compare/${encodeURIComponent(tag)}...main?per_page=100`;
const COMPARE = compareOf("pkg@1.0.0");
/** The answers of a comparison, in pages of 100. Each page has the status, the merge base and the count. */
function comparison(url: string, commits: unknown[], more: { status?: string; base?: string; ahead?: number } = {}): Record<string, Answer> {
  const pages: Record<string, Answer> = {};
  const count = Math.max(1, Math.ceil(commits.length / 100));
  for (let page = 1; page <= count; page++) {
    const here = page === 1 ? url : `${url}&page=${page}`;
    const body = {
      status: more.status ?? (commits.length === 0 ? "identical" : "ahead"),
      ahead_by: more.ahead ?? commits.length,
      merge_base_commit: { sha: more.base ?? "tag" },
      commits: commits.slice((page - 1) * 100, page * 100),
    };
    pages[here] = page < count ? { body, link: `<${url}&page=${page + 1}>; rel="next", <${url}&page=${count}>; rel="last"` } : { body };
  }
  return pages;
}
const releases = (...body: unknown[]): Record<string, Answer> => ({ [`${API}/releases?per_page=100`]: { body } });

describe("the read from GitHub", () => {
  const options = { owner: "o", repo: "r", token: "t", tagPrefix: "pkg@", now: NOW };

  it("takes the newest release of the prefix, skips a pre-release, and reads each page of the comparison", async () => {
    const github = fakeGitHub({
      [`${API}/releases?per_page=100`]: {
        body: [release("other@2.0.0", "2026-11-04T00:00:00Z"), release("pkg@1.1.0-rc.0", "2026-11-03T00:00:00Z", { prerelease: true }), release("pkg@1.0.0", "2026-11-01T00:00:00Z")],
        link: `<${API}/releases?per_page=100&page=2>; rel="next"`,
      },
      // 350 commits after the tag, on 4 pages
      ...comparison(COMPARE, line("tag", "2026-11-02T12:00:00Z", 350)),
    });
    expect(await githubReleaseLag({ ...options, fetch: github.fetch })).toEqual({ available: true, value: 3, at: NOW, release: "pkg@1.0.0" });
    expect(github.urls).toEqual([`${API}/releases?per_page=100`, COMPARE, `${COMPARE}&page=2`, `${COMPARE}&page=3`, `${COMPARE}&page=4`]);
  });

  it("gives the time of a merge commit, not the older dates of the commits that it brings", async () => {
    // A branch has commits of 10-31 and 11-01. Its merge commit lands on main at 11-04 12:00, after the release.
    const github = fakeGitHub({
      ...releases(release("pkg@1.0.0", "2026-11-03T00:00:00Z")),
      ...comparison(COMPARE, [
        commit("b1", "2026-10-31T00:00:00Z", "tag"),
        commit("b2", "2026-11-01T00:00:00Z", "b1"),
        commit("merge", "2026-11-04T12:00:00Z", "tag", "b2"),
        commit("next", "2026-11-05T00:00:00Z", "merge"),
      ]),
    });
    expect(await githubReleaseLag({ ...options, fetch: github.fetch })).toEqual({ available: true, value: 1, at: NOW, release: "pkg@1.0.0" });
  });

  it("gives the date of the oldest commit for a history of squashes only, as before", async () => {
    // The tag was made at 02:51, a pull request merged at 02:54, and the release was published at 03:14 (coeval v0.22.0, 2026-11-04).
    const github = fakeGitHub({
      ...releases(release("v0.22.0", "2026-11-04T03:14:58Z")),
      ...comparison(compareOf("v0.22.0"), line("tag", "2026-11-04T02:54:31Z", 32)),
    });
    expect(await githubReleaseLag({ ...options, tagPrefix: "v", fetch: github.fetch })).toEqual({ available: true, value: 1.38, at: NOW, release: "v0.22.0" });
  });

  it("takes the newest release in the order of GitHub, not the highest version, and encodes a tag with a scope", async () => {
    // A fix of an older line, released after a newer version, is the newest release.
    const github = fakeGitHub({
      ...releases(release("@s/pkg@1.0.5", "2026-11-04T00:00:00Z"), release("@s/pkg@2.0.0", "2026-11-03T00:00:00Z")),
      ...comparison(compareOf("@s/pkg@1.0.5"), []),
    });
    expect(await githubReleaseLag({ ...options, tagPrefix: "@s/pkg@", fetch: github.fetch })).toEqual({ available: true, value: 0, at: NOW, release: "@s/pkg@1.0.5" });
    expect(github.urls[1]).toBe(`${API}/compare/%40s%2Fpkg%401.0.5...main?per_page=100`);
  });

  it("gives 0 when the tag is the tip of the branch", async () => {
    const github = fakeGitHub({ ...releases(release("pkg@1.0.0", "2026-11-01T00:00:00Z")), ...comparison(COMPARE, []) });
    expect(await githubReleaseLag({ ...options, fetch: github.fetch })).toEqual({ available: true, value: 0, at: NOW, release: "pkg@1.0.0" });
  });

  it("is not available when the tag is not on the first-parent line of the branch", async () => {
    // A release from another branch: the comparison diverged.
    const other = fakeGitHub({
      ...releases(release("pkg@1.0.0", "2026-11-01T00:00:00Z")),
      ...comparison(COMPARE, line("base", "2026-11-02T00:00:00Z", 2), { status: "diverged", base: "base" }),
    });
    expect(await githubReleaseLag({ ...options, fetch: other.fetch })).toEqual({ available: false, reason: "the tag pkg@1.0.0 is not on main (the comparison is diverged)" });
    // The branch holds the tag only through the second parent of a merge commit, so the first-parent line does not reach the tag.
    const merged = fakeGitHub({
      ...releases(release("pkg@1.0.0", "2026-11-01T00:00:00Z")),
      ...comparison(COMPARE, [commit("side", "2026-11-02T00:00:00Z", "old"), commit("merge", "2026-11-03T00:00:00Z", "side", "tag")]),
    });
    expect(await githubReleaseLag({ ...options, fetch: merged.fetch })).toEqual({ available: false, reason: "the tag pkg@1.0.0 is not on the first-parent line of main" });
  });

  it("is not available when GitHub lists fewer commits than it counts, or more than 2,000 commits follow the tag", async () => {
    const short = fakeGitHub({ ...releases(release("pkg@1.0.0", "2026-11-01T00:00:00Z")), ...comparison(COMPARE, line("tag", "2026-11-02T00:00:00Z", 3), { ahead: 5 }) });
    expect(await githubReleaseLag({ ...options, fetch: short.fetch })).toEqual({ available: false, reason: "GitHub listed 3 of the 5 commits after pkg@1.0.0" });
    const long = fakeGitHub({ ...releases(release("pkg@1.0.0", "2026-11-01T00:00:00Z")), ...comparison(COMPARE, line("tag", "2026-08-01T00:00:00Z", 2001)) });
    expect(await githubReleaseLag({ ...options, fetch: long.fetch })).toEqual({ available: false, reason: "the branch has more than 2000 commits after pkg@1.0.0" });
    expect(long.urls).toHaveLength(21);
  });

  it("is not available when the commits have no single tip", async () => {
    const github = fakeGitHub({
      ...releases(release("pkg@1.0.0", "2026-11-01T00:00:00Z")),
      ...comparison(COMPARE, [commit("a", "2026-11-02T00:00:00Z", "tag"), commit("b", "2026-11-02T01:00:00Z", "tag")]),
    });
    expect(await githubReleaseLag({ ...options, fetch: github.fetch })).toEqual({ available: false, reason: "the commits after pkg@1.0.0 have no single tip" });
  });

  it("is not available with no token, no release of the prefix, or an error of GitHub", async () => {
    expect((await githubReleaseLag({ ...options, token: undefined })).available).toBe(false);
    const none = fakeGitHub({ [`${API}/releases?per_page=100`]: { body: [release("other@1.0.0", "2026-11-01T00:00:00Z")] } });
    expect(await githubReleaseLag({ ...options, fetch: none.fetch })).toEqual({ available: false, reason: "no release has a tag that starts with pkg@" });
    const broken = fakeGitHub({ ...releases(release("pkg@1.0.0", "2026-11-01T00:00:00Z")), [COMPARE]: { body: {}, status: 500 } });
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
