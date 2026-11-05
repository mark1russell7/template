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
const SINCE = `${API}/commits?sha=main&since=${encodeURIComponent("2026-11-01T00:00:00Z")}&per_page=1`;

describe("the read from GitHub", () => {
  const options = { owner: "o", repo: "r", token: "t", tagPrefix: "pkg@", now: NOW };

  it("takes the newest release of the prefix, skips a pre-release, and reads the last page of the commits", async () => {
    const github = fakeGitHub({
      [`${API}/releases?per_page=100`]: {
        body: [release("other@2.0.0", "2026-11-04T00:00:00Z"), release("pkg@1.1.0-rc.0", "2026-11-03T00:00:00Z", { prerelease: true }), release("pkg@1.0.0", "2026-11-01T00:00:00Z")],
        link: `<${API}/releases?per_page=100&page=2>; rel="next"`,
      },
      [SINCE]: { body: [commit("2026-11-05T00:00:00Z")], link: `<${SINCE}&page=2>; rel="next", <${SINCE}&page=3>; rel="last"` },
      [`${SINCE}&page=3`]: { body: [commit("2026-11-02T12:00:00Z")] },
    });
    expect(await githubReleaseLag({ ...options, fetch: github.fetch })).toEqual({ available: true, value: 3, at: NOW, release: "pkg@1.0.0" });
    expect(github.urls).toEqual([`${API}/releases?per_page=100`, SINCE, `${SINCE}&page=3`]);
  });

  it("gives 0 when no commit follows the release, with one page of commits", async () => {
    const github = fakeGitHub({ [`${API}/releases?per_page=100`]: { body: [release("pkg@1.0.0", "2026-11-01T00:00:00Z")] }, [SINCE]: { body: [] } });
    expect(await githubReleaseLag({ ...options, fetch: github.fetch })).toEqual({ available: true, value: 0, at: NOW, release: "pkg@1.0.0" });
  });

  it("is not available with no token, no release of the prefix, or an error of GitHub", async () => {
    expect((await githubReleaseLag({ ...options, token: undefined })).available).toBe(false);
    const none = fakeGitHub({ [`${API}/releases?per_page=100`]: { body: [release("other@1.0.0", "2026-11-01T00:00:00Z")] } });
    expect(await githubReleaseLag({ ...options, fetch: none.fetch })).toEqual({ available: false, reason: "no release has a tag that starts with pkg@" });
    const broken = fakeGitHub({ [`${API}/releases?per_page=100`]: { body: [release("pkg@1.0.0", "2026-11-01T00:00:00Z")] }, [SINCE]: { body: {}, status: 500 } });
    expect(await githubReleaseLag({ ...options, fetch: broken.fetch })).toEqual({ available: false, reason: "GitHub answered with HTTP 500" });
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
