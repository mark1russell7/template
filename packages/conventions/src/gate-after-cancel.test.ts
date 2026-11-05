// The rule gate-after-cancel on fixture repositories: the forms of a summary job, the jobs it leaves, the fix and its second run.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, runFix, type RuleResult } from "./index.ts";
import { alwaysGates, withNotCancelled } from "./rules/gate-after-cancel.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-gate-cancel-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

const ID = "gate-after-cancel";
const FILE = ".github/workflows/ci.yml";

/** This function gives a workflow with one job of work and one more job. */
const workflow = (job: readonly string[]): string =>
  ["on: pull_request", "jobs:", "  work:", "    runs-on: ubuntu-latest", "    steps:", "      - run: echo work", ...job.map((line) => `  ${line}`), ""].join("\n");

const summary = (condition: string): string[] => ["ci-ok:", "  name: CI OK", `  if: ${condition}`, "  needs: [work]", "  runs-on: ubuntu-latest", "  steps:", "    - run: echo done"];

/** This function makes a git repository with the workflow, and gives its root. */
function repository(text: string): string {
  const root = join(temp, String(fixtures++));
  mkdirSync(dirname(join(root, FILE)), { recursive: true });
  writeFileSync(join(root, "package.json"), '{ "name": "one" }\n');
  writeFileSync(join(root, FILE), text);
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

describe("the rule gate-after-cancel", () => {
  it("finds each form of always() in a summary job", () => {
    expect(alwaysGates(workflow(summary("always()"))).map((gate) => gate.only)).toEqual([true]);
    expect(alwaysGates(workflow(summary("${{ always() }}"))).map((gate) => gate.only)).toEqual([true]);
    expect(alwaysGates(workflow(summary("always() && inputs.on"))).map((gate) => gate.only)).toEqual([false]);
  });

  it("finds a job by the action gate-summary, with a name that does not end with OK", () => {
    const job = ["gate:", "  if: always()", "  needs: [work]", "  runs-on: ubuntu-latest", "  steps:", "    - uses: mark1russell7/template/.github/actions/gate-summary@abc # main"];
    expect(alwaysGates(workflow(job)).length).toBe(1);
  });

  it("does not read another job, a step or a condition with no always()", () => {
    const report = ["report:", "  name: The report", "  if: always()", "  runs-on: ubuntu-latest", "  steps:", "    - run: echo report"];
    const step = ["ci-ok:", "  name: CI OK", "  if: ${{ !cancelled() }}", "  runs-on: ubuntu-latest", "  steps:", "    - run: echo done", "      if: always()"];
    expect(alwaysGates(workflow(report))).toEqual([]);
    expect(alwaysGates(workflow(step))).toEqual([]);
    expect(alwaysGates(workflow(summary("${{ !cancelled() }}")))).toEqual([]);
    expect(alwaysGates("on: push\n")).toEqual([]);
  });

  it("does not read a comment", () => {
    const job = ["ci-ok:", "  name: CI OK", "  # if: always()", "  runs-on: ubuntu-latest", "  steps:", "    - run: echo done"];
    expect(alwaysGates(workflow(job))).toEqual([]);
  });

  it("keeps the indent, the line endings and each other line", () => {
    const text = workflow(summary("always()")).replaceAll("\n", "\r\n");
    const after = withNotCancelled(text);
    expect(after).toContain("    if: ${{ !cancelled() }}\r\n");
    expect(after.replace("${{ !cancelled() }}", "always()")).toBe(text);
  });

  it("fails on always(), and the fix passes on its second run", () => {
    const root = repository(workflow(summary("always()")));
    const before = check(root).breaks;
    expect(before.map((each) => [each.file, each.line])).toEqual([[FILE, 9]]);
    expect(runFix({ root, only: [ID] }).changed).toEqual([FILE]);
    expect(readFileSync(join(root, FILE), "utf8")).toContain("    if: ${{ !cancelled() }}\n");
    expect(check(root).breaks).toEqual([]);
    expect(runFix({ root, only: [ID] }).changed).toEqual([]);
  });

  it("leaves a condition with other parts to a person", () => {
    const text = workflow(summary("always() && inputs.on"));
    const root = repository(text);
    expect(check(root).breaks.length).toBe(1);
    expect(runFix({ root, only: [ID] }).changed).toEqual([]);
    expect(readFileSync(join(root, FILE), "utf8")).toBe(text);
  });
});
