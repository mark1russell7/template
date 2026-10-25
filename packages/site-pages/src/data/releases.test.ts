/**
 * The release data: the changelog parser (ported from the client site), the merge of the sources by
 * version, the GitHub releases and the npm times.
 */

import { describe, expect, it } from "vitest";
import { firstSentence, headingAnchor, parseChangelog, releaseBodyEntries } from "./changelog.ts";
import { githubReleases } from "./github.ts";
import { npmPublishTimes } from "./npm.ts";
import { mergeReleases, ReleaseDataError, type ChangelogSource } from "./releases.ts";
import type { GitHubRelease } from "./types.ts";
import { compareVersions, kindOf, versionOfTag } from "./versions.ts";

const CLIENT = `# @procedures/client

## 0.3.1

### Patch Changes

- 3a235b9: New: the patch operations \`$remove\` and \`$insert\` (wave 2). \`$remove\` takes an element out
  of an array.
- Updated dependencies [3a235b9]
  - @procedures/store@0.3.1

## 0.3.0

### Minor Changes

- e2fe006: The expose rule applies to each pin (CLI-47):
  - New option \`alwaysOn\`.

  The second paragraph. It is not in the text.

### Patch Changes

- b89e3fe: The field \`partition\` reaches each collection procedure again. Before, \`withPartition()\` refused it.

## 0.2.0

No changes in this release.

## 0.1.0

The first release on npm.

- The core depends on no other package. It moved the storage.
`;

const STORE = `# @procedures/store

## 0.3.1

### Patch Changes

- 3a235b9: New: the patch operations \`$remove\` and \`$insert\` (wave 2). \`$remove\` takes an element out
  of an array.
- @procedures/client@0.3.1

## 0.3.0

### Minor Changes

- e2fe006: The expose rule applies to each pin (CLI-47):
- 0c627f8: \`HybridStorage\` keeps the queue in \`v1.2\` files.

## 0.0.9

- 1234567: A version that the group does not have.
`;

const TAGS = [
  { tag: "@procedures/client@0.3.1", date: "2026-10-18T15:34:06-04:00" },
  { tag: "@procedures/client@0.3.0", date: "2026-10-18T13:10:35-04:00" },
  { tag: "@procedures/store@0.3.0", date: "2026-10-18T13:10:36-04:00" },
  { tag: "@procedures/client@0.2.0", date: "2026-10-16T02:43:51Z" },
  { tag: "@procedures/client@0.1.0", date: "2026-10-11T23:36:16-04:00" },
];

const changelogs: ChangelogSource[] = [
  { name: "@procedures/store", file: "packages/store/CHANGELOG.md", markdown: STORE },
  { name: "@procedures/client", file: "packages/client/CHANGELOG.md", markdown: CLIENT },
];

describe("the changelog parser", () => {
  // Before 0.1.5, the regular expressions backtracked on these inputs (CodeQL js/polynomial-redos). The
  // time grew with the square of the length. Now each call takes a few milliseconds.
  it("reads a long run of spaces in linear time", () => {
    const spaces = " ".repeat(100_000);
    const start = performance.now();
    expect(releaseBodyEntries(`* Fix it${spaces}by @ann in https://github.com/o/r/pull/12`)).toEqual([
      { commit: null, text: "Fix it ([#12](https://github.com/o/r/pull/12))" },
    ]);
    expect(releaseBodyEntries(`*${spaces}x${String.fromCharCode(0x2028)}y`)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("reads the entries of each version, and skips the lines of new dependency versions", () => {
    const sections = parseChangelog(CLIENT);
    expect(sections.map((section) => section.version)).toEqual(["0.3.1", "0.3.0", "0.2.0", "0.1.0"]);
    expect(sections[0]!.entries).toEqual([{ commit: "3a235b9", text: "New: the patch operations `$remove` and `$insert` (wave 2)." }]);
    expect(sections[2]!.entries).toEqual([]);
    expect(sections[3]!.entries).toEqual([{ commit: null, text: "The core depends on no other package." }]);
  });

  it("stops the text of an entry at a nested list or an empty line", () => {
    const [, minor] = parseChangelog(CLIENT);
    expect(minor!.entries.map((entry) => entry.text)).toEqual([
      "The expose rule applies to each pin (CLI-47).",
      "The field `partition` reaches each collection procedure again.",
    ]);
  });

  it("joins the wrapped lines of an entry", () => {
    expect(parseChangelog("## 1.0.0\n\n- abcdef1: One long\n  sentence. Two.\n")[0]!.entries[0]!.text).toBe("One long sentence.");
  });

  it("knows the headings of Keep a Changelog and prereleases, and keeps the heading text", () => {
    const sections = parseChangelog("## [1.2.0] - 2026-10-01\n\n- Added a thing.\n\n## v1.1.0-rc.1\n\n- A candidate.\n");
    expect(sections.map((section) => [section.version, section.heading])).toEqual([
      ["1.2.0", "[1.2.0] - 2026-10-01"],
      ["1.1.0-rc.1", "v1.1.0-rc.1"],
    ]);
    expect(headingAnchor("0.13.2")).toBe("0132");
    expect(headingAnchor("[1.2.0] - 2026-10-01")).toBe("120---2026-10-01");
  });

  it("finds the first sentence outside the code spans", () => {
    expect(firstSentence("Use `a. B` here. Then more.")).toBe("Use `a. B` here.");
    expect(firstSentence("Version 0.4.0 of `x` and `y.z` works. Next.")).toBe("Version 0.4.0 of `x` and `y.z` works.");
    expect(firstSentence("Node 22. after a lowercase word the sentence goes on. End.")).toBe("Node 22. after a lowercase word the sentence goes on.");
    expect(firstSentence("A list follows:")).toBe("A list follows.");
    expect(firstSentence("No full stop")).toBe("No full stop");
  });

  it("reads the list items of a GitHub release text, with the generated notes of GitHub", () => {
    const body = [
      "## What's Changed",
      "* Fix the parser by @ann in https://github.com/acme/widgets/pull/12",
      "* abcdef1: A change of Changesets. More text.",
      "- Updated dependencies [abcdef1]",
      "```",
      "- not a change",
      "```",
      "## New Contributors",
      "* @ann made their first contribution in https://github.com/acme/widgets/pull/12",
      "",
      "**Full Changelog**: https://github.com/acme/widgets/compare/v1.0.0...v1.1.0",
    ].join("\n");
    expect(releaseBodyEntries(body)).toEqual([
      { commit: null, text: "Fix the parser ([#12](https://github.com/acme/widgets/pull/12))" },
      { commit: "abcdef1", text: "A change of Changesets." },
    ]);
  });
});

describe("the versions", () => {
  it("compare by the SemVer precedence", () => {
    expect(["0.10.0", "0.9.2", "0.13.1", "0.2.0", "1.0.0-rc.1", "1.0.0"].sort(compareVersions)).toEqual([
      "0.2.0",
      "0.9.2",
      "0.10.0",
      "0.13.1",
      "1.0.0-rc.1",
      "1.0.0",
    ]);
  });

  it("have a kind", () => {
    expect([kindOf("0.1.0", true), kindOf("2.0.0", false), kindOf("0.4.0", false), kindOf("1.2.0", false), kindOf("1.2.3", false)]).toEqual([
      "first",
      "major",
      "minor",
      "minor",
      "patch",
    ]);
  });

  it("come from the git tags", () => {
    expect(versionOfTag("v1.2.3")).toEqual({ version: "1.2.3", package: null });
    expect(versionOfTag("1.2.3-rc.1")).toEqual({ version: "1.2.3-rc.1", package: null });
    expect(versionOfTag("@procedures/client@0.13.2")).toEqual({ version: "0.13.2", package: "@procedures/client" });
    expect(versionOfTag("widgets@v2.0.0")).toEqual({ version: "2.0.0", package: "widgets" });
    expect(versionOfTag("nightly")).toBeNull();
  });
});

describe("the merge of the releases", () => {
  const releases = mergeReleases({ changelogs, tags: TAGS, group: "@procedures/client", repository: "acme/widgets", ref: "abc1234" });

  it("gives the versions of the group, newest first, with their kind and the date of the group tag", () => {
    expect(releases.map((release) => [release.version, release.kind, release.date])).toEqual([
      ["0.3.1", "patch", "2026-10-18T15:34:06-04:00"],
      ["0.3.0", "minor", "2026-10-18T13:10:35-04:00"],
      ["0.2.0", "minor", "2026-10-16T02:43:51Z"],
      ["0.1.0", "first", "2026-10-11T23:36:16-04:00"],
    ]);
  });

  it("gives one change for each commit, with the sorted packages that list it, the most packages first", () => {
    expect(releases[0]!.changes).toEqual([
      { commit: "3a235b9", text: "New: the patch operations `$remove` and `$insert` (wave 2).", packages: ["@procedures/client", "@procedures/store"] },
    ]);
    expect(releases[1]!.changes).toEqual([
      { commit: "e2fe006", text: "The expose rule applies to each pin (CLI-47).", packages: ["@procedures/client", "@procedures/store"] },
      { commit: "0c627f8", text: "`HybridStorage` keeps the queue in `v1.2` files.", packages: ["@procedures/store"] },
      { commit: "b89e3fe", text: "The field `partition` reaches each collection procedure again.", packages: ["@procedures/client"] },
    ]);
    expect(releases[2]!.changes).toEqual([]);
  });

  it("links the tag and the changelog section of the group", () => {
    expect(releases[0]!.links).toEqual([
      { label: "Tag", url: "https://github.com/acme/widgets/releases/tag/@procedures/client@0.3.1" },
      { label: "Changelog", url: "https://github.com/acme/widgets/blob/abc1234/packages/client/CHANGELOG.md#031" },
    ]);
  });

  it("stops when the group has no changelog", () => {
    expect(() => mergeReleases({ changelogs: [changelogs[0]!], group: "@procedures/client" })).toThrow(ReleaseDataError);
  });

  it("takes each version of each source without a group", () => {
    const all = mergeReleases({ changelogs, tags: TAGS, now: "2026-10-19T00:00:00Z" });
    expect(all.map((release) => release.version)).toEqual(["0.3.1", "0.3.0", "0.2.0", "0.1.0", "0.0.9"]);
    expect(all[4]!.kind).toBe("first");
    expect(all[3]!.kind).toBe("minor");
  });

  it("takes the date from the tag, else the GitHub release, else npm, else the changelog commit", () => {
    const warnings: string[] = [];
    const github: GitHubRelease[] = [
      { tag: "v1.2.0", name: "1.2.0", body: "", publishedAt: "2026-10-10T00:00:00Z", url: "https://github.com/acme/widgets/releases/tag/v1.2.0", prerelease: false },
      { tag: "v1.1.0", name: "1.1.0", body: "", publishedAt: "2026-10-05T00:00:00Z", url: "https://github.com/acme/widgets/releases/tag/v1.1.0", prerelease: false },
    ];
    const merged = mergeReleases({
      changelogs: [{ name: "widgets", file: "CHANGELOG.md", markdown: "## 1.3.0\n\n- A.\n\n## 1.2.0\n\n- B.\n\n## 1.1.0\n\n- C.\n\n## 1.0.0\n\n- D.\n\n## 0.9.0\n" }],
      githubReleases: github,
      tags: [{ tag: "v1.2.0", date: "2026-10-09T00:00:00Z" }],
      npm: [
        { name: "widgets", version: "1.1.0", date: "2026-10-04T00:00:00Z" },
        { name: "widgets", version: "1.0.0", date: "2026-10-01T00:00:00Z" },
      ],
      headingDate: (version) => (version === "1.3.0" ? "2026-10-12T00:00:00Z" : null),
      now: "2026-10-19T00:00:00Z",
      repository: "acme/widgets",
      warn: (message) => warnings.push(message),
    });
    expect(merged.map((release) => [release.version, release.date])).toEqual([
      ["1.3.0", "2026-10-12T00:00:00Z"],
      ["1.2.0", "2026-10-09T00:00:00Z"],
      ["1.1.0", "2026-10-05T00:00:00Z"],
      ["1.0.0", "2026-10-01T00:00:00Z"],
      ["0.9.0", "2026-10-01T00:00:00Z"],
    ]);
    expect(warnings).toEqual(["no source gives a date for 0.9.0. The page shows an approximate date."]);
    expect(merged[1]!.links.map((each) => each.label)).toEqual(["GitHub release", "Changelog"]);
    expect(merged[3]!.links).toContainEqual({ label: "npm", url: "https://www.npmjs.com/package/widgets/v/1.0.0" });
    expect(merged[3]!.kind).toBe("major");
  });

  it("takes the changes from the GitHub release text when no changelog has the version", () => {
    const merged = mergeReleases({
      githubReleases: [
        { tag: "v2.0.0", name: "Two", body: "- Breaking: the new API.\n- abcdef1: A fix.", publishedAt: "2026-10-10T00:00:00Z", url: "https://x.test/2", prerelease: false },
        { tag: "v1.0.0", name: "One", body: "Text without a list.", publishedAt: "2026-10-01T00:00:00Z", url: "https://x.test/1", prerelease: false },
        { tag: "nightly", name: "Nightly", body: "- No version.", publishedAt: "2026-10-11T00:00:00Z", url: "https://x.test/n", prerelease: true },
      ],
    });
    expect(merged.map((release) => [release.version, release.kind, release.changes.length])).toEqual([
      ["2.0.0", "major", 2],
      ["1.0.0", "first", 0],
    ]);
    expect(merged[0]!.changes).toEqual([
      { commit: "abcdef1", text: "A fix.", packages: [] },
      { commit: null, text: "Breaking: the new API.", packages: [] },
    ]);
  });

  it("gives no release without a source", () => {
    expect(mergeReleases({})).toEqual([]);
  });
});

describe("the releases from npm only (0.1.3)", () => {
  const TIMES = [
    { name: "@acme/service", version: "0.0.0-bootstrap.0", date: "2026-10-01T00:00:00Z" },
    { name: "@acme/service", version: "0.4.0", date: "2026-10-02T00:00:00Z" },
    { name: "@acme/service", version: "0.4.1", date: "2026-10-03T00:00:00Z" },
    { name: "@acme/service", version: "0.5.0", date: "2026-10-05T00:00:00Z" },
    { name: "@acme/service", version: "1.0.0", date: "2026-10-07T00:00:00Z" },
    { name: "@acme/algebra", version: "0.2.0", date: "2026-10-04T00:00:00Z" },
    { name: "@acme/algebra", version: "0.2.1-rc.1", date: "2026-10-05T12:00:00Z" },
    { name: "@acme/algebra", version: "0.2.1", date: "2026-10-06T00:00:00Z" },
  ];

  it("gives each npm version of each package, the newest first, when no changelog and no GitHub release names a version", () => {
    const releases = mergeReleases({ npm: TIMES, repository: "acme/systems" });
    expect(releases.map((release) => [release.version, release.kind, release.date])).toEqual([
      ["service@1.0.0", "major", "2026-10-07T00:00:00Z"],
      ["algebra@0.2.1", "patch", "2026-10-06T00:00:00Z"],
      ["service@0.5.0", "minor", "2026-10-05T00:00:00Z"],
      ["algebra@0.2.0", "first", "2026-10-04T00:00:00Z"],
      ["service@0.4.1", "patch", "2026-10-03T00:00:00Z"],
      ["service@0.4.0", "first", "2026-10-02T00:00:00Z"],
    ]);
    expect(releases[0]!.changes).toEqual([{ commit: null, text: "Version 1.0.0 of `@acme/service` on npm.", packages: ["@acme/service"] }]);
    expect(releases[0]!.links).toEqual([{ label: "npm", url: "https://www.npmjs.com/package/@acme/service/v/1.0.0" }]);
  });

  it("gives the plain version for one package, and only the group with a group", () => {
    const one = mergeReleases({ npm: TIMES.filter((time) => time.name === "@acme/algebra") });
    expect(one.map((release) => [release.version, release.kind])).toEqual([
      ["0.2.1", "patch"],
      ["0.2.0", "first"],
    ]);
    expect(mergeReleases({ npm: TIMES, group: "@acme/algebra" }).map((release) => release.version)).toEqual(["0.2.1", "0.2.0"]);
  });

  it("keeps the full names when two scopes have one short name", () => {
    const releases = mergeReleases({
      npm: [
        { name: "@a/core", version: "1.0.0", date: "2026-10-01T00:00:00Z" },
        { name: "@b/core", version: "1.0.0", date: "2026-10-02T00:00:00Z" },
      ],
    });
    expect(releases.map((release) => release.version)).toEqual(["@b/core@1.0.0", "@a/core@1.0.0"]);
  });

  it("does not use npm when a changelog gives the versions", () => {
    const changelog = { name: "@acme/service", file: "CHANGELOG.md", markdown: "# @acme/service\n\n## 1.0.0\n\n- The first.\n" };
    const releases = mergeReleases({ changelogs: [changelog], npm: TIMES });
    expect(releases.map((release) => release.version)).toEqual(["1.0.0"]);
  });
});

// ---------------------------------------------------------------------------
// GitHub and npm, with a fake fetch
// ---------------------------------------------------------------------------

function fakeFetch(answer: (url: string) => Promise<Response>): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  return {
    calls,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return answer(String(url));
    }) as typeof fetch,
  };
}

const RELEASE_PAGE = [
  {
    tag_name: "v1.1.0",
    name: "Version 1.1.0",
    body: "- A change.",
    published_at: "2026-10-10T00:00:00Z",
    html_url: "https://github.com/acme/widgets/releases/tag/v1.1.0",
    draft: false,
    prerelease: false,
  },
  { tag_name: "v1.2.0", name: null, body: null, published_at: null, created_at: "2026-10-11T00:00:00Z", html_url: "", draft: true, prerelease: false },
];

describe("the GitHub releases", () => {
  it("reads the published releases with the REST API, and follows the next page", async () => {
    const { fetch, calls } = fakeFetch(async (url) =>
      url.includes("page=2")
        ? new Response(JSON.stringify([{ tag_name: "v1.0.0", name: "", body: "", published_at: "2026-10-01T00:00:00Z", html_url: "u", prerelease: true }]))
        : new Response(JSON.stringify(RELEASE_PAGE), { headers: { link: '<https://api.github.com/repos/acme/widgets/releases?per_page=100&page=2>; rel="next"' } }),
    );
    const result = await githubReleases({ owner: "acme", repo: "widgets", token: "t0ken", fetch });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/acme/widgets/releases?per_page=100",
      "https://api.github.com/repos/acme/widgets/releases?per_page=100&page=2",
    ]);
    expect((calls[0]!.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer t0ken");
    expect(result).toEqual({
      available: true,
      releases: [
        { tag: "v1.1.0", name: "Version 1.1.0", body: "- A change.", publishedAt: "2026-10-10T00:00:00Z", url: "https://github.com/acme/widgets/releases/tag/v1.1.0", prerelease: false },
        { tag: "v1.0.0", name: "v1.0.0", body: "", publishedAt: "2026-10-01T00:00:00Z", url: "u", prerelease: true },
      ],
    });
  });

  it("gives no data and sends no request without a token", async () => {
    const { fetch, calls } = fakeFetch(async () => new Response("[]"));
    expect(await githubReleases({ owner: "acme", repo: "widgets", token: undefined, fetch })).toEqual({
      available: false,
      reason: "the build had no GitHub token",
    });
    expect(calls).toHaveLength(0);
  });

  it("gives the reason of an error, and never throws", async () => {
    const run = (answer: () => Promise<Response>) => githubReleases({ owner: "a", repo: "b", token: "t", fetch: fakeFetch(answer).fetch });
    expect(await run(async () => new Response("no", { status: 401 }))).toEqual({ available: false, reason: "GitHub answered with HTTP 401" });
    expect(await run(async () => new Response("no", { status: 404 }))).toEqual({ available: false, reason: "GitHub has no repository a/b" });
    expect(await run(async () => new Response(JSON.stringify({ message: "x" })))).toEqual({ available: false, reason: "GitHub gave no list of releases" });
    expect(await run(async () => Promise.reject(new Error("getaddrinfo ENOTFOUND")))).toEqual({
      available: false,
      reason: "the request failed: getaddrinfo ENOTFOUND",
    });
    expect(await run(async () => new Response("not json"))).toMatchObject({ available: false });
  });
});

describe("the npm times", () => {
  it("reads the times of each version of a package, and of each package of a scope", async () => {
    const { fetch, calls } = fakeFetch(async (url) => {
      if (url.includes("/-/v1/search")) {
        return new Response(JSON.stringify({ objects: [{ package: { name: "@acme/a" } }, { package: { name: "@other/x" } }] }));
      }
      if (url.endsWith("/@acme%2fa")) {
        return new Response(JSON.stringify({ versions: { "1.0.0": {} }, time: { created: "x", modified: "y", "1.0.0": "2026-10-01T00:00:00Z", "0.9.0": "2026-09-01T00:00:00Z" } }));
      }
      if (url.endsWith("/widgets")) return new Response(JSON.stringify({ versions: { "2.0.0": {} }, time: { "2.0.0": "2026-10-02T00:00:00Z" } }));
      return new Response("missing", { status: 404 });
    });
    const result = await npmPublishTimes({ packages: ["@acme", "widgets", "gone"], fetch });
    expect(calls[0]!.url).toBe("https://registry.npmjs.org/-/v1/search?text=scope:acme&size=250");
    expect(result).toEqual({
      times: [
        { name: "@acme/a", version: "1.0.0", date: "2026-10-01T00:00:00Z" },
        { name: "widgets", version: "2.0.0", date: "2026-10-02T00:00:00Z" },
      ],
      problems: ["npm did not give the versions of gone: HTTP 404"],
    });
  });
});
