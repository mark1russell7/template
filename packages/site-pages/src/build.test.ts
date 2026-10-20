/**
 * The CLI: `site-pages build` against a fixture repository (a changelog, a roadmap and a git tag),
 * with a fake fetch for GitHub and npm.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HELP, parseBuildArgs, runCli } from "./build.ts";
import type { Release, StatusBoardData } from "./data/types.ts";

const CHANGELOG = `# @acme/widgets

## 0.3.0

### Minor Changes

- abcdef1: A new feature. More text.

## 0.2.1

### Patch Changes

- 1234567: A fix of the parser.

## 0.2.0

- The first release.
`;

const ROADMAP = `# Roadmap

| ID | Item | Status | Where |
|---|---|---|---|
| W1 | The widget page | in progress | PR #7 |
| W2 | The old page | done | \`abcdef1\` |
`;

const OPEN_WORK = {
  data: {
    repository: {
      pullRequests: {
        totalCount: 1,
        nodes: [
          {
            number: 7,
            title: "The widget page",
            url: "https://github.com/acme/widgets/pull/7",
            isDraft: false,
            createdAt: "2026-10-18T10:00:00Z",
            updatedAt: "2026-10-19T12:00:00Z",
            headRefName: "widget-page",
            author: { login: "ann" },
            labels: { nodes: [] },
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
          },
        ],
      },
      issues: { totalCount: 0, nodes: [] },
    },
  },
};

/** A fetch that answers like GitHub and npm, and records each URL. */
function fakeFetch(): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fake = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url === "https://api.github.com/graphql") return json(OPEN_WORK);
    if (url.startsWith("https://api.github.com/repos/acme/widgets/releases")) {
      return json([
        {
          tag_name: "v0.2.1",
          name: "0.2.1",
          body: "- 1234567: A fix of the parser.",
          published_at: "2026-10-12T08:00:00Z",
          html_url: "https://github.com/acme/widgets/releases/tag/v0.2.1",
          draft: false,
          prerelease: false,
        },
      ]);
    }
    if (url === "https://registry.npmjs.org/@acme%2fwidgets") {
      return json({ versions: { "0.3.0": {} }, time: { created: "x", "0.3.0": "2026-10-15T09:30:00Z" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: fake, urls };
}

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("site-pages build", () => {
  const repo = mkdtempSync(join(tmpdir(), "site-pages-repo-"));
  const git = hasGit();
  let head = "";

  beforeAll(() => {
    mkdirSync(join(repo, "packages", "widgets"), { recursive: true });
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "packages", "widgets", "package.json"), JSON.stringify({ name: "@acme/widgets", version: "0.3.0" }));
    writeFileSync(join(repo, "packages", "widgets", "CHANGELOG.md"), CHANGELOG);
    writeFileSync(join(repo, "docs", "ROADMAP.md"), ROADMAP);
    if (!git) return;
    // A git repository with one commit and one tag, without the configuration of this computer
    writeFileSync(join(repo, ".gitconfig-empty"), "");
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(repo, ".gitconfig-empty"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_AUTHOR_DATE: "2026-10-10T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-10T12:00:00Z",
    };
    const run = (...args: string[]): string => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    run("init", "-q", "-b", "main");
    run("add", "packages", "docs");
    run("commit", "-q", "-m", "fixture");
    run("tag", "@acme/widgets@0.2.0");
    head = run("rev-parse", "HEAD").trim();
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("writes the two JSON files and the two pages", async () => {
    const { fetch, urls } = fakeFetch();
    const out: string[] = [];
    const errors: string[] = [];
    const code = await runCli(["build", "--out", "site/dist", "--roadmap", "docs/ROADMAP.md", "--packages", "@acme/widgets"], {
      cwd: repo,
      env: { GITHUB_REPOSITORY: "acme/widgets", GITHUB_TOKEN: "t0ken" },
      stdout: (text) => out.push(text),
      stderr: (text) => errors.push(text),
      fetch,
      now: "2026-10-19T14:05:00Z",
    });
    expect(errors.join("")).toBe("");
    expect(code).toBe(0);
    expect(out.join("")).toContain("site-pages: 3 releases, 2 roadmap items (1 open), 1 open pull request and 0 open issues.");

    const dist = join(repo, "site", "dist");
    for (const file of ["data/releases.json", "data/status.json", "releases/index.html", "status/index.html"]) {
      expect(existsSync(join(dist, ...file.split("/"))), file).toBe(true);
    }
    expect(urls).toContain("https://api.github.com/graphql");
    expect(urls).toContain("https://registry.npmjs.org/@acme%2fwidgets");

    const releases = JSON.parse(readFileSync(join(dist, "data", "releases.json"), "utf8")) as Release[];
    expect(releases.map((release) => [release.version, release.kind])).toEqual([
      ["0.3.0", "minor"],
      ["0.2.1", "patch"],
      ["0.2.0", "first"],
    ]);
    expect(releases[0]).toEqual({
      version: "0.3.0",
      date: "2026-10-15T09:30:00Z",
      kind: "minor",
      changes: [{ commit: "abcdef1", text: "A new feature.", packages: ["@acme/widgets"] }],
      links: [
        { label: "Changelog", url: `https://github.com/acme/widgets/blob/${head || "HEAD"}/packages/widgets/CHANGELOG.md#030` },
        { label: "npm", url: "https://www.npmjs.com/package/@acme/widgets/v/0.3.0" },
      ],
    });
    expect(releases[1]!.date).toBe("2026-10-12T08:00:00Z");
    expect(releases[1]!.links[0]).toEqual({ label: "GitHub release", url: "https://github.com/acme/widgets/releases/tag/v0.2.1" });
    if (git) expect(Date.parse(releases[2]!.date)).toBe(Date.parse("2026-10-10T12:00:00Z"));

    const status = JSON.parse(readFileSync(join(dist, "data", "status.json"), "utf8")) as StatusBoardData;
    expect(status.generatedAt).toBe("2026-10-19T14:05:00Z");
    expect(status.commit).toBe(head || null);
    expect(status.source).toEqual({ roadmap: "docs/ROADMAP.md", github: "acme/widgets" });
    expect(status.items.map((item) => [item.id, item.statusClass])).toEqual([
      ["W1", "progress"],
      ["W2", "done"],
    ]);
    expect(status.pullRequests.map((pull) => [pull.number, pull.checks])).toEqual([[7, "pending"]]);
    expect(status.github).toEqual({ available: true, totals: { pullRequests: 1, issues: 0 } });

    const releasesPage = readFileSync(join(dist, "releases", "index.html"), "utf8");
    if (git) expect(releasesPage).toContain("3 versions from Oct 10 to Oct 15, 2026. 1 MINOR release and 1 PATCH release came after the first release.");
    expect(releasesPage).toContain('<a class="sp-home" href="/widgets/">widgets</a>');
    const statusPage = readFileSync(join(dist, "status", "index.html"), "utf8");
    expect(statusPage).toContain("1 open roadmap item, 1 open pull request and 0 open issues, read at Oct 19, 2026, 14:05 UTC");
    expect(statusPage).toContain("Checks run");
  });

  it("writes only the data with --data-only, and works without a token", async () => {
    const errors: string[] = [];
    const code = await runCli(["build", "--out", "data-only", "--data-only", "--repo", "acme/widgets"], {
      cwd: repo,
      env: {},
      stdout: () => {},
      stderr: (text) => errors.push(text),
      fetch: fakeFetch().fetch,
    });
    expect(code).toBe(0);
    expect(existsSync(join(repo, "data-only", "data", "releases.json"))).toBe(true);
    expect(existsSync(join(repo, "data-only", "releases"))).toBe(false);
    expect(errors.join("")).toContain("the status page has no GitHub data: the build had no GitHub token.");
  });

  it("stops with code 1 at an incorrect roadmap", async () => {
    writeFileSync(join(repo, "docs", "BROKEN.md"), "| ID | Status |\n|---|---|\n| X | open | extra |\n");
    const errors: string[] = [];
    const code = await runCli(["build", "--out", "broken", "--repo", "acme/widgets", "--roadmap", "docs/BROKEN.md"], {
      cwd: repo,
      env: {},
      stdout: () => {},
      stderr: (text) => errors.push(text),
      fetch: fakeFetch().fetch,
    });
    expect(code).toBe(1);
    expect(errors.join("")).toContain("docs/BROKEN.md:3: the row has 3 cells, and the header has 2");
  });

  it("reads the command line, and refuses an incorrect one with code 2", async () => {
    const io = { cwd: repo, env: { GITHUB_REPOSITORY: "acme/acme.github.io", GITHUB_TOKEN: "env-token" } };
    expect(parseBuildArgs(["build", "--out", "dist", "--packages", "a,b", "--packages", "@c"], io)).toMatchObject({
      repository: "acme/acme.github.io",
      base: "/",
      packages: ["a", "b", "@c"],
      token: "env-token",
      dataOnly: false,
    });
    expect(parseBuildArgs(["build", "--out", "dist", "--repo", "acme/widgets", "--base", "docs"], io)).toMatchObject({ base: "/docs/" });
    expect(parseBuildArgs(["--help"], io)).toBe("help");

    const errors: string[] = [];
    const run = (argv: string[]) => runCli(argv, { ...io, stdout: () => {}, stderr: (text) => errors.push(text) });
    expect(await run(["build"])).toBe(2);
    expect(errors.join("")).toContain("--out is necessary");
    expect(await run(["deploy", "--out", "x"])).toBe(2);
    expect(await run(["build", "--out", "x", "--nope"])).toBe(2);
    expect(await run(["build", "--out", "x", "--repo", "not-a-repo"])).toBe(2);
    expect(errors.join("")).toContain(HELP.split("\n")[0]);
  });
});
