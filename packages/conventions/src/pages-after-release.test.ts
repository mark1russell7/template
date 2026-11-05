// The rule pages-after-release on fixture repositories: each form of the triggers, the fix, its second run, and what the rule leaves alone.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, runFix, type RuleResult } from "./index.ts";
import { isDaily, pagesTriggers } from "./rules/pages-after-release.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-pages-release-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

const ID = "pages-after-release";
const FILE = ".github/workflows/pages.yml";
const ENV = { GITHUB_REPOSITORY: "acme/widgets" };
const RELEASE = "name: Release\non:\n  push:\n    branches: [main]\njobs: {}\n";
const CALL = "jobs:\n  pages:\n    uses: mark1russell7/template/.github/workflows/reusable-pages.yml@0123abc # main\n    with:\n      roadmap: docs/ROADMAP.md\n";

const pages = (on: readonly string[], jobs: string = CALL): string => ["name: Pages", "", "on:", ...on, "", jobs].join("\n");

/** This function makes a git repository with the files, and gives its root. */
function repository(files: Record<string, unknown>): string {
  const root = join(temp, String(fixtures++));
  mkdirSync(root, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof text === "string" ? text : `${JSON.stringify(text, null, 2)}\n`);
  }
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "first"]]) {
    const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return root;
}

const one = (text: string, more: Record<string, unknown> = {}): string =>
  repository({ "package.json": { name: "one" }, ".github/workflows/release.yml": RELEASE, [FILE]: text, ...more });

function check(root: string): RuleResult {
  const result = runChecks({ root, only: [ID], env: ENV }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

/** This function checks the text of the fix, and that a second fix changes nothing. */
function fixes(on: readonly string[], want: readonly string[]): void {
  const root = one(pages(on));
  expect(check(root).breaks.map((item) => (item.edits ?? []).length), on.join(" | ")).toEqual([1]);
  expect(runFix({ root, only: [ID], env: ENV }).changed).toEqual([FILE]);
  expect(readFileSync(join(root, FILE), "utf8")).toBe(pages(want));
  expect(check(root).breaks).toEqual([]);
  expect(runFix({ root, only: [ID], env: ENV }).changed).toEqual([]);
}

const PUSH = ["  push:", "    branches: [main]"];
const DAILY = ["  schedule:", '    - cron: "10 6 * * *"'];
const AFTER = ["  # After a release, so that the Releases page has the new version", "  workflow_run:", "    workflows: [Release]", "    types: [completed]", "    branches: [main]"];

describe("the reader of the triggers", () => {
  it("knows a daily schedule", () => {
    expect(isDaily("10 6 * * *")).toBe(true);
    expect(isDaily("13 * * * *")).toBe(true);
    expect(isDaily("30 */3 * * *")).toBe(true);
    expect(isDaily("40 6 * * 1")).toBe(false);
    expect(isDaily("40 6 1 * *")).toBe(false);
    expect(isDaily("40 6")).toBe(false);
  });

  it("reads the release in each form of the list, and only that name", () => {
    expect(pagesTriggers(pages([...PUSH, "  workflow_run:", "    workflows: [CI, Release]"])).afterRelease).toBe(true);
    expect(pagesTriggers(pages(["  workflow_run:", "    workflows:", "      - CI", "      - Release"])).afterRelease).toBe(true);
    expect(pagesTriggers(pages(["  workflow_run:", '    workflows: ["Release"]'])).afterRelease).toBe(true);
    expect(pagesTriggers(pages(["  workflow_run:", "    workflows: [CI]"])).afterRelease).toBe(false);
    expect(pagesTriggers(pages(PUSH)).afterRelease).toBe(false);
    expect(pagesTriggers(pages(["  workflow_run:", "    workflows: [Publish]"]), "Publish").afterRelease).toBe(true);
  });
});

describe("pages-after-release", () => {
  it("passes a site that starts after a release and on each day", () => {
    const root = one(pages([...PUSH, ...AFTER, ...DAILY]));
    expect(check(root).breaks).toEqual([]);
  });

  it("names each missing trigger", () => {
    expect(check(one(pages([...PUSH, ...DAILY]))).breaks.map((item) => item.message)).toEqual([`${FILE} deploys a site, and it does not start after the workflow Release.`]);
    expect(check(one(pages([...PUSH, ...AFTER]))).breaks.map((item) => item.message)).toEqual([`${FILE} deploys a site, and it has no schedule with a start on each day.`]);
    expect(check(one(pages(PUSH))).breaks.map((item) => item.message)).toEqual([`${FILE} deploys a site, and it does not start after the workflow Release, and it has no schedule with a start on each day.`]);
  });

  it("adds the trigger after push, and keeps the other triggers", () => {
    fixes([...PUSH, ...DAILY, "  workflow_dispatch:"], [...PUSH, ...AFTER, ...DAILY, "  workflow_dispatch:"]);
  });

  it("adds the release to the list of a trigger after CI", () => {
    fixes(["  workflow_run:", "    workflows: [CI]", "    types: [completed]", ...DAILY], ["  workflow_run:", "    workflows: [CI, Release]", "    types: [completed]", ...DAILY]);
    fixes(["  workflow_run:", "    workflows:", "      - CI", "    types: [completed]", ...DAILY], ["  workflow_run:", "    workflows:", "      - CI", "      - Release", "    types: [completed]", ...DAILY]);
  });

  it("adds a daily schedule at the minute of the repository and the file", () => {
    fixes([...PUSH, ...AFTER, "  workflow_dispatch:"], [...PUSH, ...AFTER, "  workflow_dispatch:", "  # Each day, in case a release fails after it publishes", "  schedule:", '    - cron: "17 5 * * *"']);
  });

  it("adds a daily line to a weekly schedule, and keeps the weekly line", () => {
    fixes([...PUSH, ...AFTER, "  schedule:", '    - cron: "40 6 * * 1"'], [...PUSH, ...AFTER, "  schedule:", '    - cron: "40 6 * * 1"', '    - cron: "17 5 * * *"']);
  });

  it("keeps the line ends of the file", () => {
    const text = pages([...PUSH, ...DAILY]).replace(/\n/g, "\r\n");
    const root = one(text);
    runFix({ root, only: [ID], env: ENV });
    const fixed = readFileSync(join(root, FILE), "utf8");
    expect(fixed).toContain("workflow_run:\r\n");
    expect(fixed.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("gives a person the break of a workflow with its own deploy, and no edit", () => {
    const own = pages(PUSH, "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/deploy-pages@abc\n");
    const breaks = check(one(own)).breaks;
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.edits).toBeUndefined();
    expect(breaks[0]?.fix).toContain("A person must change it");
  });

  it("gives no edit for a form of `on` on one line", () => {
    const breaks = check(one(pages([]).replace("on:\n", "on: [push]\n"))).breaks;
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.edits).toBeUndefined();
  });

  it("leaves alone a repository with no release, with only private packages, a test site, and a shared workflow", () => {
    expect(check(repository({ "package.json": { name: "one" }, [FILE]: pages(PUSH) })).breaks).toEqual([]);
    expect(check(one(pages(PUSH), { "package.json": { name: "one", private: true } })).breaks).toEqual([]);
    expect(check(one(pages(PUSH, "jobs:\n  a:\n    uses: ./.github/workflows/reusable-pages.yml\n    with:\n      deploy: false\n"))).breaks).toEqual([]);
    expect(check(one(pages([...PUSH, ...AFTER, ...DAILY]), { ".github/workflows/reusable-pages.yml": "on:\n  workflow_call:\njobs:\n  a:\n    steps:\n      - uses: actions/deploy-pages@abc\n" })).breaks).toEqual([]);
  });

  it("uses the name of the release workflow", () => {
    const root = one(pages([...PUSH, ...DAILY]), { ".github/workflows/release.yml": "name: Publish\njobs: {}\n" });
    runFix({ root, only: [ID], env: ENV });
    expect(readFileSync(join(root, FILE), "utf8")).toContain("workflows: [Publish]");
  });
});
