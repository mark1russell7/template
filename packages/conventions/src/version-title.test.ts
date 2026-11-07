// The rule version-title on fixture repositories: the titles of template #212 (5933b34) and #215 (e077054), on a push and on a pull request.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, type CheckOptions, type RuleResult } from "./index.ts";
import { namedVersions } from "./rules/version-title.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-version-title-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

const ID = "version-title";
const PACKAGE = "packages/site-pages/package.json";
/** The titles of the squash commits of template #212 and #215. */
const TITLE_212 = "site-pages check: a probe for each page (0.3.3) (#212)";
const TITLE_215 = "fix(site-pages): githubReleaseLag follows the first-parent line (0.3.3) (#215)";

/** This function starts git in `root`, and gives its output. */
function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** This function writes each file, commits the change with the title, and gives the commit. */
function commit(root: string, title: string, files: Record<string, unknown>): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof text === "string" ? text : `${JSON.stringify(text, null, 2)}\n`);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", title);
  return git(root, "rev-parse", "HEAD");
}

const manifest = (version: string): Record<string, unknown> => ({ name: "@x/site-pages", version });

/** This function makes a workspace with the package `site-pages` at 0.3.2 on `main`, and gives its root and first commit. */
function repository(): { root: string; first: string } {
  const root = join(temp, String(fixtures++));
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  const first = commit(root, "first", {
    "package.json": { name: "root", private: true },
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    [PACKAGE]: manifest("0.3.2"),
    "packages/site-pages/src/github.ts": "export const lag = 1;\n",
  });
  return { root, first };
}

/** This function writes an event file, and gives its environment. */
function event(name: string, data: unknown): Record<string, string> {
  const file = join(temp, `event-${String(fixtures++)}.json`);
  writeFileSync(file, JSON.stringify(data));
  return { GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: file };
}

const pushed = (before: string): Record<string, string> => event("push", { before, ref: "refs/heads/main", repository: { default_branch: "main" } });

function check(root: string, options: Omit<CheckOptions, "root" | "only">): RuleResult {
  const result = runChecks({ root, only: [ID], ...options }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

describe("namedVersions", () => {
  it("finds a version in parentheses at the end, and after Release at the start", () => {
    expect(namedVersions(TITLE_212)).toEqual(["0.3.3"]);
    expect(namedVersions(TITLE_215)).toEqual(["0.3.3"]);
    expect(namedVersions("feat(conventions): rule workflow-parses (0.34.0)")).toEqual(["0.34.0"]);
    expect(namedVersions("Release 0.23.0")).toEqual(["0.23.0"]);
    expect(namedVersions("chore(release): release v1.2.0-rc.1 (#9)")).toEqual(["1.2.0-rc.1"]);
  });

  it("finds no version in a title that only tells of one", () => {
    expect(namedVersions("fix(site-pages): githubReleaseLag follows the first-parent line (#215)")).toEqual([]);
    expect(namedVersions("docs: the notes of release 0.23.0")).toEqual([]);
    expect(namedVersions("feat: support Node (22.0.0) in the docs")).toEqual([]);
    expect(namedVersions("Merge pull request #214 from mark1russell7/release-train/update")).toEqual([]);
    expect(namedVersions("chore(deps): bump yaml to 2.9.1")).toEqual([]);
  });
});

describe("version-title on a push", () => {
  it("passes the commit of #212, which sets 0.3.3", () => {
    const { root, first } = repository();
    commit(root, TITLE_212, { [PACKAGE]: manifest("0.3.3"), "packages/site-pages/src/probe.ts": "export const probe = 1;\n" });
    const result = check(root, { env: pushed(first) });
    expect(result.status).toBe("pass");
  });

  it("fails the commit of #215, which names 0.3.3 but sets no version, and passes a title with no version", () => {
    const { root, first } = repository();
    commit(root, TITLE_212, { [PACKAGE]: manifest("0.3.3") });
    const lost = commit(root, TITLE_215, { "packages/site-pages/src/github.ts": "export const lag = 2;\n" });
    commit(root, "docs: a note on the lag", { "packages/site-pages/README.md": "# site-pages\n" });
    const result = check(root, { env: pushed(first) });
    expect(result.status).toBe("break");
    expect(result.breaks.map((item) => `${item.file}: ${item.message}`)).toEqual([
      `package.json: The commit ${lost.slice(0, 7)} has the title "${TITLE_215}", which names 0.3.3, but it sets no version. The release workflow starts only on a change of a version, so the change gets no release.`,
    ]);
  });

  it("passes a title that names an other version than the version that the commit sets: the change gets a release", () => {
    const { root, first } = repository();
    commit(root, "fix(site-pages): a fixed box (0.2.17) (#184)", { [PACKAGE]: manifest("0.3.3") });
    expect(check(root, { env: pushed(first) }).status).toBe("pass");
  });

  it("passes Release at the start of a title, for a root package", () => {
    const root = join(temp, String(fixtures++));
    mkdirSync(root, { recursive: true });
    git(root, "init", "-q", "-b", "main");
    const first = commit(root, "first", { "package.json": manifest("0.22.0") });
    commit(root, "Release 0.23.0", { "package.json": manifest("0.23.0") });
    expect(check(root, { env: pushed(first) }).status).toBe("pass");
  });

  it("examines the range of --base too", () => {
    const { root, first } = repository();
    commit(root, TITLE_212, { [PACKAGE]: manifest("0.3.3") });
    commit(root, TITLE_215, { "packages/site-pages/src/github.ts": "export const lag = 2;\n" });
    expect(check(root, { base: first, env: {} }).breaks).toHaveLength(1);
  });

  it("skips with no push, no pull request and no base", () => {
    const { root } = repository();
    expect(check(root, { env: {} }).status).toBe("skipped");
  });
});

describe("version-title on a pull request", () => {
  /** This function makes the checkout of #215: main has #212, and HEAD is the merge of the branch `pr` into main. */
  function mergeOf215(branchVersion: string): string {
    const { root } = repository();
    git(root, "switch", "-q", "-c", "pr");
    commit(root, "the lag follows the first parent", { [PACKAGE]: manifest(branchVersion), "packages/site-pages/src/github.ts": "export const lag = 2;\n" });
    git(root, "switch", "-q", "main");
    commit(root, TITLE_212, { [PACKAGE]: manifest("0.3.3") });
    git(root, "switch", "-q", "--detach", "main");
    git(root, "merge", "-q", "--no-ff", "-X", "theirs", "-m", "merge pr", "pr");
    return root;
  }

  it("fails #215 before its merge: the branch sets 0.3.3, which main has already", () => {
    const root = mergeOf215("0.3.3");
    const result = check(root, { env: event("pull_request", { pull_request: { title: "fix(site-pages): githubReleaseLag follows the first-parent line (0.3.3)" } }) });
    expect(result.status).toBe("break");
    expect(result.breaks[0]?.message).toBe(
      'The pull request has the title "fix(site-pages): githubReleaseLag follows the first-parent line (0.3.3)", which names 0.3.3, but it sets no version. The release workflow starts only on a change of a version, so the change gets no release.',
    );
  });

  it("passes when the branch sets the next free version that its title names", () => {
    const root = mergeOf215("0.3.4");
    expect(check(root, { env: event("pull_request", { pull_request: { title: "fix(site-pages): the lag (0.3.4)" } }) }).status).toBe("pass");
    expect(check(root, { env: event("pull_request", { pull_request: { title: "fix(site-pages): the lag" } }) }).status).toBe("pass");
  });

  it("skips when the event file has no title", () => {
    const root = mergeOf215("0.3.4");
    expect(check(root, { env: event("pull_request", {}) }).status).toBe("skipped");
  });
});
