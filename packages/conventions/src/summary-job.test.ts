// The rule summary-job on fixture repositories: the triggers it reads, the job it adds, the gates it leaves, the fix and its second run.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, runFix, type RuleResult } from "./index.ts";
import { addSummaryJob, hasSummaryJob, startsOnPullRequest } from "./rules/summary-job.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-summary-job-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

const ID = "summary-job";
const CI = ".github/workflows/ci.yml";
const SECURITY = ".github/workflows/security.yml";
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** The form of ci.yml of most repositories: one job that calls the shared CI, and a concurrency of the workflow. */
const caller = [
  "name: CI",
  "on:",
  "  push:",
  "    branches: [main]",
  "  pull_request:",
  "concurrency:",
  "  group: ci-${{ github.ref }}",
  "jobs:",
  "  ci:",
  "    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@abc # main",
  "    with:",
  "      scripts: build typecheck test",
  "",
].join("\n");

/** This function makes a git repository with the files, and gives its root. */
function repository(files: Record<string, string>): string {
  const root = join(temp, String(fixtures++));
  writeFileSync(join((mkdirSync(root, { recursive: true }), root), "package.json"), '{ "name": "one" }\n');
  for (const [file, text] of Object.entries(files)) {
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

describe("the rule summary-job", () => {
  it("reads each form of a pull request trigger", () => {
    expect(startsOnPullRequest("on: pull_request\njobs: {}\n")).toBe(true);
    expect(startsOnPullRequest("on: [push, pull_request]\n")).toBe(true);
    expect(startsOnPullRequest('on:\n  "pull_request_target":\n')).toBe(true);
    expect(startsOnPullRequest(caller)).toBe(true);
    expect(startsOnPullRequest("on:\n  push:\n  # pull_request:\n  workflow_call:\n")).toBe(false);
    expect(startsOnPullRequest("on: push\n")).toBe(false);
  });

  it("adds CI OK after the last job, with the indent of the file, and no group when the workflow has one", () => {
    const added = addSummaryJob(caller, CI, SHA);
    if (!("text" in added)) throw new Error(added.reason);
    expect(added.text).toBe(
      [
        ...caller.split("\n").slice(0, -1),
        "",
        "  ci-ok:",
        "    name: CI OK",
        "    if: ${{ !cancelled() }}",
        "    needs: [ci]",
        "    runs-on: ubuntu-latest",
        "    timeout-minutes: 2",
        "    permissions: {}",
        "    steps:",
        `      - uses: mark1russell7/template/.github/actions/gate-summary@${SHA} # main`,
        "        with:",
        "          needs: ${{ toJSON(needs) }}",
        "",
      ].join("\n"),
    );
    expect(hasSummaryJob(added.text)).toBe(true);
  });

  it("lets a job with its own if, and each job that needs it, be skipped", () => {
    const text = ["name: Security", "on: pull_request", "jobs:", "  scan:", "    runs-on: ubuntu-latest", "  review:", "    if: github.event_name == 'pull_request'", "    runs-on: ubuntu-latest", "  report:", "    needs: review", "    runs-on: ubuntu-latest", ""].join("\n");
    const added = addSummaryJob(text, SECURITY, SHA);
    if (!("text" in added)) throw new Error(added.reason);
    expect(added.text).toContain("  security-ok:\n    name: Security OK\n");
    expect(added.text).toContain("    needs: [scan, review, report]\n");
    expect(added.text).toContain("    concurrency:\n      group: ${{ github.workflow }}-security-ok-");
    expect(added.text).toContain("          allow-skip: review report\n");
  });

  it("fails on a gate with no summary job, and the fix passes on its second run", () => {
    const root = repository({ [CI]: caller });
    expect(check(root).breaks.map((each) => each.file)).toEqual([CI]);
    expect(runFix({ root, only: [ID] }).changed).toEqual([CI]);
    expect(readFileSync(join(root, CI), "utf8")).toContain("    name: CI OK\n");
    expect(check(root).breaks).toEqual([]);
    expect(runFix({ root, only: [ID] }).changed).toEqual([]);
  });

  it("leaves a gate with a summary job, the deprecated scans, a workflow with no pull request, and other workflows", () => {
    const done = `${caller}  ci-ok:\n    name: CI OK\n    needs: [ci]\n    runs-on: ubuntu-latest\n`;
    const scans = "name: Security\non: pull_request\njobs:\n  security:\n    uses: mark1russell7/template/.github/workflows/reusable-security.yml@abc # main\n";
    const root = repository({ [CI]: done, [SECURITY]: scans, ".github/workflows/pages.yml": caller });
    expect(check(root).breaks).toEqual([]);
    const pushOnly = repository({ [CI]: "name: CI\non:\n  push:\njobs:\n  a:\n    runs-on: ubuntu-latest\n" });
    expect(check(pushOnly).breaks).toEqual([]);
  });

  it("leaves a gate to a person when it has a job with the id of the summary job", () => {
    const root = repository({ [CI]: `${caller}  ci-ok:\n    runs-on: ubuntu-latest\n` });
    const breaks = check(root).breaks;
    expect(breaks.length).toBe(1);
    expect(breaks[0]?.fix).toContain("already has a job ci-ok");
    expect(runFix({ root, only: [ID] }).changed).toEqual([]);
  });
});
