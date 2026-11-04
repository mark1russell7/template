// The rule push-main-only on fixture repositories: each form of `on`, the fix, its second run, and the exceptions.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, runFix, type CheckOptions, type RuleResult } from "./index.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-push-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

const ID = "push-main-only";
const FILE = ".github/workflows/ci.yml";
const DISPATCH_NOTE = "# A person starts a run on a branch with no pull request: gh workflow run ci.yml --ref <branch>";
const JOBS = ["permissions: {}", "", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", "      - run: echo a"];

const workflow = (on: readonly string[], jobs: readonly string[] = JOBS): string => [...on, "", ...jobs, ""].join("\n");

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

function check(root: string, options: Omit<CheckOptions, "root" | "only"> = {}): RuleResult {
  const result = runChecks({ root, only: [ID], ...options }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

const one = (text: string): string => repository({ "package.json": { name: "one" }, [FILE]: text });

/** This function checks that the rule passes on the workflow, and that the fix changes nothing. */
function passes(on: readonly string[], jobs?: readonly string[]): void {
  const text = workflow(on, jobs);
  const root = one(text);
  expect(check(root).breaks, on.join(" | ")).toEqual([]);
  expect(runFix({ root, only: [ID] }).changed).toEqual([]);
  expect(readFileSync(join(root, FILE), "utf8")).toBe(text);
}

/** This function checks the text of the fix, and that a second fix changes nothing. */
function fixes(on: readonly string[], want: readonly string[], jobs?: readonly string[], options: Omit<CheckOptions, "root" | "only"> = {}): void {
  const root = one(workflow(on, jobs));
  expect(check(root, options).breaks.map((item) => (item.edits ?? []).length), on.join(" | ")).toEqual([1]);
  expect(runFix({ root, only: [ID], ...options }).changed).toEqual([FILE]);
  const fixed = readFileSync(join(root, FILE), "utf8");
  expect(fixed).toBe(workflow(want, jobs));
  expect(check(root, options).breaks).toEqual([]);
  expect(runFix({ root, only: [ID], ...options }).changed).toEqual([]);
  expect(readFileSync(join(root, FILE), "utf8")).toBe(fixed);
}

/** This function checks that the rule reports the workflow with no edit, and that the fix text gives the reason. */
function needsPerson(on: readonly string[], reason: string, jobs?: readonly string[], files: Record<string, unknown> = {}, file = FILE): void {
  const text = workflow(on, jobs);
  const root = repository({ "package.json": { name: "one" }, [file]: text, ...files });
  const found = check(root).breaks;
  expect(found.map((item) => item.edits), on.join(" | ")).toEqual([undefined]);
  expect(found[0]?.fix).toContain(reason);
  expect(runFix({ root, only: [ID] }).changed).toEqual([]);
  expect(readFileSync(join(root, file), "utf8")).toBe(text);
}

describe("push-main-only", () => {
  it("passes a workflow that has the limit and workflow_dispatch", () => {
    passes(["on:", "  push:", "    branches: [main]", "  pull_request:", "  workflow_dispatch:"]);
    passes(["on:", "  push:", "    branches:", "      - main", "  pull_request:", "  workflow_dispatch:"]);
    passes(["on:", "  push:", '    branches: ["main"]', "    paths: [src/**]", "  pull_request:", "  workflow_dispatch:"]);
    passes(["on:", "  push:", "    branches: main", "  pull_request:", "  workflow_dispatch:"]);
    passes(["on: { push: { branches: [main] }, pull_request: {}, workflow_dispatch: {} }"]);
    passes(["on:", "  push: { branches: [main] }", "  pull_request:", "  workflow_dispatch:"]);
    passes(['"on":', "  push:", "    branches: [main]", "  pull_request:", "  workflow_dispatch:"]);
  });

  it("leaves a workflow alone that does not start on both events", () => {
    passes(["on: push"]);
    passes(["on: pull_request"]);
    passes(["on: [push, workflow_dispatch]"]);
    passes(["on:", "  push:", "    branches: [main]", '    paths: ["package.json"]', "  workflow_dispatch:"]);
    passes(["on:", "  push:", "  workflow_call:"]);
    passes(["on:", "  workflow_call:"]);
    passes(["on:", "  schedule:", '    - cron: "1 2 * * 1"', "  pull_request:"]);
    passes(["on:", "  release:", "    types: [published]", "  pull_request:"]);
    // pull_request_target runs the code of the base, so only the run for push tests the code of the branch
    passes(["on:", "  push:", "  pull_request_target:"]);
  });

  it("leaves a push with only a tag filter alone, because GitHub starts it on no branch", () => {
    passes(["on:", "  push:", '    tags: ["v*"]', "  pull_request:"]);
    passes(["on:", "  push:", '    tags-ignore: ["x*"]', "  pull_request:"]);
    passes(["on:", "  push:", '    tags: ["v*"]', "    paths: [src/**]", "  pull_request:"]);
    passes(["on:", "  push: { tags: [v*] }", "  pull_request:"]);
  });

  it("leaves a pull request trigger alone that does not start on a new commit, because each commit has only the run for push", () => {
    passes(["on:", "  push:", "  pull_request:", "    types: [opened, labeled]"]);
    passes(["on:", "  push:", "  pull_request:", "    types:", "      - closed"]);
  });

  it("reports a pull request trigger with synchronize", () => {
    fixes(
      ["on:", "  push:", "  pull_request:", "    types: [opened, synchronize]", "  workflow_dispatch:"],
      ["on:", "  push:", "    branches: [main]", "  pull_request:", "    types: [opened, synchronize]", "  workflow_dispatch:"],
    );
  });

  it("adds the limit and workflow_dispatch to the block form, next to workflow_call, and keeps each comment", () => {
    fixes(
      ["# The gates", "on:", "  # On each push", "  push: # all", "  pull_request:", "  # release.yml starts these gates", "  workflow_call:", "    inputs: # the inputs", "      a:", "        type: string", "", "# The token", "permissions:", "  contents: read"],
      ["# The gates", "on:", "  # On each push", "  push: # all", "    branches: [main]", "  pull_request:", "  # release.yml starts these gates", "  workflow_call:", "    inputs: # the inputs", "      a:", "        type: string", `  ${DISPATCH_NOTE}`, "  workflow_dispatch:", "", "# The token", "permissions:", "  contents: read"],
    );
  });

  it("adds only workflow_dispatch to a workflow that has the limit", () => {
    fixes(
      ["on:", "  pull_request:", "  push:", "    branches: [main]", '    paths: ["src/**"]', "  schedule:", '    - cron: "1 2 * * 1" # weekly'],
      ["on:", "  pull_request:", "  push:", "    branches: [main]", '    paths: ["src/**"]', "  schedule:", '    - cron: "1 2 * * 1" # weekly', `  ${DISPATCH_NOTE}`, "  workflow_dispatch:"],
    );
  });

  it("adds only the limit to a workflow that has workflow_dispatch, and keeps its inputs", () => {
    fixes(
      ["on:", "  workflow_dispatch:", "    inputs:", "      a:", "        type: string", "  push:", "  pull_request:"],
      ["on:", "  workflow_dispatch:", "    inputs:", "      a:", "        type: string", "  push:", "    branches: [main]", "  pull_request:"],
    );
  });

  it("keeps paths and paths-ignore next to the new limit", () => {
    fixes(
      ["on:", "  push:", "    paths:", "      - src/**", "  pull_request:", "  workflow_dispatch:"],
      ["on:", "  push:", "    branches: [main]", "    paths:", "      - src/**", "  pull_request:", "  workflow_dispatch:"],
    );
    fixes(
      ["on:", "    push:", "        paths-ignore: [docs/**]", "    pull_request:", "    workflow_dispatch:"],
      ["on:", "    push:", "        branches: [main]", "        paths-ignore: [docs/**]", "    pull_request:", "    workflow_dispatch:"],
    );
    fixes(
      ["on:", "  push: { paths: [src/**] }", "  pull_request:", "  workflow_dispatch:"],
      ["on:", "  push: { branches: [main], paths: [src/**] }", "  pull_request:", "  workflow_dispatch:"],
    );
  });

  it("keeps tags with a branch limit, and keeps the tag start of a workflow that reads the tag", () => {
    fixes(
      ["on:", "  push:", "    branches: ['**']", "    tags: [v*]", "  pull_request:", "  workflow_dispatch:"],
      ["on:", "  push:", "    branches: [main]", "    tags: [v*]", "  pull_request:", "  workflow_dispatch:"],
    );
    const tagged = ["jobs:", "  a:", "    if: startsWith(github.ref, 'refs/tags/')", "    runs-on: ubuntu-latest"];
    fixes(["on:", "  push:", "  pull_request:", "  workflow_dispatch:"], ["on:", "  push:", "    branches: [main]", '    tags: ["**"]', "  pull_request:", "  workflow_dispatch:"], tagged);
    fixes(["on: [push, pull_request, workflow_dispatch]"], ["on:", "  push:", "    branches: [main]", '    tags: ["**"]', "  pull_request:", "  workflow_dispatch:"], ["jobs:", "  a:", "    if: github.ref_type == 'tag'", "    runs-on: ubuntu-latest"]);
    fixes(["on:", "  push: { paths: [a] }", "  pull_request:", "  workflow_dispatch:"], ["on:", "  push: { branches: [main], tags: [\"**\"], paths: [a] }", "  pull_request:", "  workflow_dispatch:"], tagged);
  });

  it("reads the tag in a workflow of the repository that a job calls", () => {
    const on = ["on:", "  push:", "  pull_request:", "  workflow_dispatch:"];
    const jobs = ["jobs:", "  a:", "    uses: ./.github/workflows/called.yml"];
    const root = repository({
      "package.json": { name: "one" },
      [FILE]: workflow(on, jobs),
      ".github/workflows/called.yml": workflow(["on:", "  workflow_call:"], ["jobs:", "  a:", "    if: startsWith(github.ref, 'refs/tags/')", "    runs-on: ubuntu-latest"]),
    });
    runFix({ root, only: [ID] });
    expect(readFileSync(join(root, FILE), "utf8")).toBe(workflow(["on:", "  push:", "    branches: [main]", '    tags: ["**"]', "  pull_request:", "  workflow_dispatch:"], jobs));
  });

  it("a comment that names a tag does not keep the tag start", () => {
    fixes(["on:", "  push:", "  pull_request:", "  workflow_dispatch:", "# refs/tags go to release.yml"], ["on:", "  push:", "    branches: [main]", "  pull_request:", "  workflow_dispatch:", "# refs/tags go to release.yml"]);
  });

  it("changes a list of each branch to the limit", () => {
    fixes(["on:", "  push:", '    branches: ["**"] # each one', "  pull_request:", "  workflow_dispatch:"], ["on:", "  push:", "    branches: [main] # each one", "  pull_request:", "  workflow_dispatch:"]);
    fixes(["on:", "  push:", "    branches:", '      - "*"', "    paths: [a]", "  pull_request:", "  workflow_dispatch:"], ["on:", "  push:", "    branches: [main]", "    paths: [a]", "  pull_request:", "  workflow_dispatch:"]);
  });

  it("writes the block form for the flow form of on", () => {
    fixes(["on: [push, pull_request]"], ["on:", "  push:", "    branches: [main]", "  pull_request:", `  ${DISPATCH_NOTE}`, "  workflow_dispatch:"]);
    fixes(['"on": [pull_request, "push", workflow_call] # the gates'], ['"on": # the gates', "  pull_request:", "  push:", "    branches: [main]", "  workflow_call:", `  ${DISPATCH_NOTE}`, "  workflow_dispatch:"]);
  });

  it("writes the block form for a block list of on", () => {
    fixes(["on:", "  - push # each one", "  # the checks", "  - pull_request", "  - workflow_dispatch"], ["on:", "  push: # each one", "    branches: [main]", "  # the checks", "  pull_request:", "  workflow_dispatch:"]);
    fixes(["on:", "- pull_request", "- push"], ["on:", "  pull_request:", "  push:", "    branches: [main]", `  ${DISPATCH_NOTE}`, "  workflow_dispatch:"]);
  });

  it("writes the keys for an empty value of push", () => {
    fixes(["on:", "  push: {} # each one", "  pull_request: {}", "  workflow_dispatch: {}"], ["on:", "  push: # each one", "    branches: [main]", "  pull_request: {}", "  workflow_dispatch: {}"]);
    fixes(["on:", "  push: ~", "  pull_request: null", "  workflow_dispatch:"], ["on:", "  push:", "    branches: [main]", "  pull_request: null", "  workflow_dispatch:"]);
    fixes(["on:", "  pull_request:", "  push:"], ["on:", "  pull_request:", "  push:", "    branches: [main]", `  ${DISPATCH_NOTE}`, "  workflow_dispatch:"]);
  });

  it("keeps the line ends of the file", () => {
    const root = one(["on:", "  push:", "  pull_request:", "", "jobs:", "  a:", "    runs-on: ubuntu-latest", ""].join("\r\n"));
    runFix({ root, only: [ID] });
    expect(readFileSync(join(root, FILE), "utf8")).toBe(["on:", "  push:", "    branches: [main]", "  pull_request:", `  ${DISPATCH_NOTE}`, "  workflow_dispatch:", "", "jobs:", "  a:", "    runs-on: ubuntu-latest", ""].join("\r\n"));
  });

  it("changes a caller of a shared workflow as each other workflow, and leaves the job", () => {
    const jobs = ["jobs:", "  ci:", "    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@0123456789012345678901234567890123456789 # main"];
    fixes(["on: [push, pull_request]"], ["on:", "  push:", "    branches: [main]", "  pull_request:", `  ${DISPATCH_NOTE}`, "  workflow_dispatch:"], jobs);
  });

  it("does not rewrite a repository of a template that names a branch in format()", () => {
    fixes(["on:", "  push:", "  pull_request:", "  workflow_dispatch:"], ["on:", "  push:", "    branches: [main]", "  pull_request:", "  workflow_dispatch:"], ["jobs:", "  a:", "    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch) || github.ref == 'refs/heads/main'", "    runs-on: ubuntu-latest"]);
  });

  it("gives a break with no edit where a person must choose", () => {
    needsPerson(["on:", "  push:", "    branches-ignore: [wip/**]", "  pull_request:", "  workflow_dispatch:"], "branches-ignore");
    needsPerson(["on:", "  push:", "    branches: [main, develop]", "  pull_request:", "  workflow_dispatch:"], "names develop");
    needsPerson(["on:", "  push:", "    branches: [master]", "  pull_request:", "  workflow_dispatch:"], "names master");
    needsPerson(["on:", "  push:", "    branches: ['**', '!wip/**']", "  pull_request:", "  workflow_dispatch:"], "names !wip/**");
    needsPerson(["on:", "  push:", "    branches: [", "      main,", "    ]", "  pull_request:", "  workflow_dispatch:"], "cannot read");
    needsPerson(["on: { push: {}, pull_request: {} }"], "flow form of a map");
    needsPerson(["on:", "  push: { branches: ['**'] }", "  pull_request:", "  workflow_dispatch:"], "flow form of a map");
    needsPerson(["on: [", "  push,", "  pull_request", "]"], "more than one line");
    needsPerson(["on:", "  push:", "  pull_request:", "  workflow_dispatch:"], "reads the branch develop", ["jobs:", "  a:", "    if: github.ref == 'refs/heads/develop'", "    runs-on: ubuntu-latest"]);
    needsPerson(["on:", "  push:", "  pull_request:", "  workflow_dispatch:"], "reads the branch next", ["jobs:", "  a:", "    if: github.ref_name == 'next'", "    runs-on: ubuntu-latest"]);
  });

  it("never edits release.yml", () => {
    needsPerson(["on:", "  push:", "  pull_request:"], "release.yml belongs to the release flow", undefined, {}, ".github/workflows/release.yml");
  });

  it("reads the default branch from the event file of a run", () => {
    const event = join(temp, "event.json");
    writeFileSync(event, JSON.stringify({ repository: { default_branch: "trunk" } }));
    const env = { GITHUB_EVENT_PATH: event };
    fixes(["on:", "  push:", "  pull_request:", "  workflow_dispatch:"], ["on:", "  push:", "    branches: [trunk]", "  pull_request:", "  workflow_dispatch:"], undefined, { env });
    const root = one(workflow(["on:", "  push:", "    branches: [trunk]", "  pull_request:", "  workflow_dispatch:"]));
    expect(check(root, { env }).breaks).toEqual([]);
    expect(check(root).breaks.map((item) => item.message)).toEqual([expect.stringContaining("more branches than main")]);
    expect(check(root, { env: { GITHUB_EVENT_PATH: join(temp, "missing.json") } }).breaks).toHaveLength(1);
  });

  it("reads the default branch from the HEAD of the remote", () => {
    const root = one(workflow(["on:", "  push:", "    branches: [master]", "  pull_request:", "  workflow_dispatch:"]));
    spawnSync("git", ["update-ref", "refs/remotes/origin/master", "HEAD"], { cwd: root });
    spawnSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"], { cwd: root });
    expect(check(root).breaks).toEqual([]);
  });

  it("obeys the field conventions of package.json", () => {
    const text = workflow(["on:", "  push:", "    branches: [main, next]", "  pull_request:", "  workflow_dispatch:"]);
    const manifest = (rules: unknown): unknown => ({ name: "one", conventions: { rules: { [ID]: rules } } });
    const allowed = repository({ "package.json": manifest({ branches: ["next"], reason: "next is a long-lived branch" }), [FILE]: text });
    expect(check(allowed).breaks).toEqual([]);
    const ignored = repository({ "package.json": manifest({ ignore: [FILE], reason: "this workflow is a test" }), [FILE]: text });
    expect(check(ignored).breaks).toEqual([]);
    expect(runFix({ root: ignored, only: [ID] }).changed).toEqual([]);
    const off = repository({ "package.json": manifest({ off: "no CI load here" }), [FILE]: text });
    expect(check(off).status).toBe("off");
    const stale = repository({ "package.json": manifest({ ignore: [FILE], reason: "this workflow is a test" }), [FILE]: workflow(["on: push"]) });
    expect(check(stale).breaks.map((item) => item.message)).toEqual([expect.stringContaining(FILE)]);
    expect(() => check(repository({ "package.json": manifest({ branches: ["next"] }), [FILE]: text }))).toThrow(/needs a reason/);
  });

  it("gives the message, the line and the fix text of a break", () => {
    const [found] = check(one(workflow(["on:", "  pull_request:", "  push:"]))).breaks;
    expect(found?.line).toBe(3);
    expect(found?.file).toBe(FILE);
    expect(found?.message).toBe(`${FILE} starts on push and on pull_request: push starts on more branches than main, so a commit of a pull request starts it two times, and it has no workflow_dispatch, so a person cannot start a run on a branch.`);
    const [only] = check(one(workflow(["on:", "  pull_request:", "  push:", "    branches: [main]"]))).breaks;
    expect(only?.message).toBe(`${FILE} starts on push and on pull_request: it has no workflow_dispatch, so a person cannot start a run on a branch.`);
  });

  it("skips a repository with no workflow, and a folder out of git", () => {
    expect(check(repository({ "package.json": { name: "one" } }))).toMatchObject({ status: "skipped", note: "the repository has no workflow" });
    const plain = join(temp, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "package.json"), '{ "name": "one" }');
    expect(check(plain).status).toBe("skipped");
  });
});
