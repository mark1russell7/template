// The rule workflow-parses on fixture repositories: a workflow, a composite action, and the files that GitHub does not read.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, type RuleResult } from "./index.ts";
import { GITHUB_YAML, yamlFaults } from "./rules/workflow-parses.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-yaml-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

const ID = "workflow-parses";

/** This function makes a git repository with the files, and gives its root. */
function repository(files: Readonly<Record<string, string>>): string {
  const root = join(temp, String(fixtures++));
  for (const [file, text] of Object.entries({ "package.json": '{ "name": "one" }\n', ...files })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "first"]]) {
    const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return root;
}

function check(root: string): RuleResult {
  const result = runChecks({ root, only: [ID] }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

const GOOD = ["on: workflow_dispatch", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", "      - run: |", "          echo one", "", "          echo two", ""].join("\n");

// The form of memory-probe.yml of layout-contract in run 42172612147: a script wrote the `\n` of a printf as real line
// breaks, so the rest of the string starts at column 1 and ends the block `run: |`.
const BROKEN = [
  "on:",
  "  schedule:",
  '    - cron: "17 3 * * 1"',
  "jobs:",
  "  a:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: |",
  "          printf '%s",
  "",
  `' "$line" >> "$GITHUB_STEP_SUMMARY"`,
  "          echo done",
  "",
].join("\n");

const ACTION = ["name: Stamp", "runs:", "  using: composite", "  steps:", "    - shell: bash", "      run: echo stamp", ""].join("\n");

describe("the rule workflow-parses", () => {
  it("reads the workflows and the action files of .github, and no other file", () => {
    for (const file of [".github/workflows/ci.yml", ".github/workflows/pages.yaml", ".github/actions/data-stamps/action.yml", ".github/actions/a/b/action.yaml"]) expect(GITHUB_YAML.test(file), file).toBe(true);
    for (const file of [".github/dependabot.yml", ".github/workflows/sub/ci.yml", ".github/actions/data-stamps/other.yml", "action.yml", "docs/.github/workflows/ci.yml"]) expect(GITHUB_YAML.test(file), file).toBe(false);
  });

  it("gives the line and the column of a fault, and no fault for good YAML", () => {
    expect(yamlFaults(GOOD)).toEqual([]);
    const faults = yamlFaults(BROKEN);
    expect(faults[0]).toEqual({ line: 11, column: 1, message: "Implicit keys need to be on a single line at line 11, column 1" });
  });

  it("passes on good files", () => {
    expect(check(repository({ ".github/workflows/ci.yml": GOOD, ".github/actions/stamp/action.yml": ACTION })).breaks).toEqual([]);
  });

  it("fails on a workflow that starts only on a schedule, with one break at the line of the first fault", () => {
    const breaks = check(repository({ ".github/workflows/probe.yml": BROKEN, ".github/workflows/ci.yml": GOOD })).breaks;
    expect(breaks.map((each) => [each.file, each.line])).toEqual([[".github/workflows/probe.yml", 11]]);
    expect(breaks[0]?.message).toBe(".github/workflows/probe.yml does not parse as YAML, so GitHub starts no job of it: Implicit keys need to be on a single line at line 11, column 1. The parser finds 2 more faults after it.");
  });

  it("fails on a composite action that does not parse", () => {
    const action = ACTION.replace("      run: echo stamp", "      run: echo stamp\n   bad: [");
    const breaks = check(repository({ ".github/actions/stamp/action.yml": action })).breaks;
    expect(breaks.map((each) => each.file)).toEqual([".github/actions/stamp/action.yml"]);
  });

  it("does not read a file that git does not keep", () => {
    const root = repository({ ".github/workflows/ci.yml": GOOD });
    writeFileSync(join(root, ".github/workflows/local.yml"), BROKEN);
    expect(check(root).breaks).toEqual([]);
  });
});
