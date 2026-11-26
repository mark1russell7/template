// The rule runner-peak, its query of the peak jobs, and the reader of expressions that it uses.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, type RuleResult } from "./index.ts";
import { calledJobs, layeredPeak, matrixPeak, needsPeak, runsAtOnce, TEMPLATE_CALLED, workflowPeaks, type PeakOptions } from "./rules/runner-peak.ts";
import { evaluateExpression, groupParts, mayRun } from "./workflow-expression.ts";
import { parseWorkflow } from "./workflow.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-peak-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

/** This function makes a git repository with the files, and gives its root. */
function repository(files: Record<string, string>): string {
  const root = join(temp, String(fixtures++));
  mkdirSync(root, { recursive: true });
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

/** This function starts the rule on `root` with the options in the root `package.json`. */
const check = (root: string, options: Record<string, number | readonly string[]>): RuleResult => {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "one", conventions: { rules: { "runner-peak": { ...options, ...(Object.keys(options).length > 0 ? { reason: "the share of the test" } : {}) } } } }));
  const result = runChecks({ root, only: ["runner-peak"] }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
};

const OWN_GROUP = "${{ github.event_name == 'pull_request' && github.ref || github.sha }}";
const OPTIONS: PeakOptions = { burst: 5, called: {} };
const parse = (text: string, file = "ci.yml") => parseWorkflow(file, text);

describe("the reader of expressions", () => {
  it("reads the event name, the operators and the truthy value of each context", () => {
    expect(evaluateExpression("github.event_name == 'push'", "push")?.truthy).toBe(true);
    expect(evaluateExpression("github.event_name == 'PUSH'", "push")?.truthy).toBe(true);
    expect(evaluateExpression("github.event_name != 'push'", "push")?.truthy).toBe(false);
    expect(evaluateExpression("!(github.event_name == 'push') && true", "push")?.truthy).toBe(false);
    expect(evaluateExpression("contains(github.ref, 'main')", "push")?.truthy).toBeUndefined();
    expect(evaluateExpression("github.event_name == 'push' &&", "push")).toBeUndefined();
    expect(evaluateExpression("'it''s' == 'it''s'", "push")?.truthy).toBe(true);
  });

  it("gives the parts of a run that a group depends on, for each event", () => {
    expect([...groupParts(`ci-${OWN_GROUP}`, "push")]).toEqual(["commit"]);
    expect([...groupParts(`ci-${OWN_GROUP}`, "pull_request")]).toEqual(["ref"]);
    expect([...groupParts("${{ github.workflow }}-${{ github.head_ref || github.run_id }}", "push")]).toEqual(["run"]);
    expect([...groupParts("${{ github.workflow }}-${{ github.head_ref || github.run_id }}", "pull_request")]).toEqual(["ref"]);
    expect([...groupParts("${{ github.event_name == 'push' && 'lab-push' || format('lab-{0}', github.run_id) }}", "push")]).toEqual([]);
    expect([...groupParts("pages-deploy", "push")]).toEqual([]);
    expect([...groupParts("laws-${{ inputs.runs }}", "workflow_dispatch")]).toEqual(["input"]);
    // An expression that does not parse gives a group for each run.
    expect([...groupParts("x-${{ github.sha ]] }}", "push")]).toEqual(["run"]);
    // A long text with no end of an expression takes linear time (the scan uses no lazy regular expression).
    expect([...groupParts("${{".repeat(50_000), "push")]).toEqual([]);
    expect([...groupParts(`${"${{".repeat(50_000)} github.sha }}`, "push")]).toEqual(["run"]);
  });

  it("tells if a job can run on an event", () => {
    expect(mayRun("", "push")).toBe(true);
    expect(mayRun("github.event_name == 'pull_request'", "push")).toBe(false);
    expect(mayRun("${{ github.event_name == 'pull_request' }}", "pull_request")).toBe(true);
    expect(mayRun("always()", "push")).toBe(true);
    expect(mayRun("github.event_name == 'push' && failure()", "pull_request")).toBe(false);
  });
});

describe("the peak jobs of a workflow", () => {
  const ci = [
    "on:",
    "  push:",
    "    branches: [main]",
    "  pull_request:",
    "concurrency:",
    `  group: ci-${OWN_GROUP}`,
    "jobs:",
    "  test:",
    "    strategy:",
    "      max-parallel: 3",
    "      matrix:",
    "        os: [a, b, c, d]",
    "        node: [24, 26]",
    "  review:",
    "    if: github.event_name == 'pull_request'",
    "    runs-on: x",
    "  summary:",
    "    needs: [test]",
    "    runs-on: x",
    "",
  ].join("\n");

  it("gives the line of each job and each key", () => {
    const workflow = parse(ci);
    expect(workflow.lines["jobs"]).toBe(7);
    expect(workflow.lines["on.push"]).toBe(2);
    expect(workflow.jobs.map((job) => [job.id, job.line, job.lines["strategy.max-parallel"]])).toEqual([
      ["test", 8, 10],
      ["review", 14, undefined],
      ["summary", 17, undefined],
    ]);
  });

  it("counts the matrix to its max-parallel, the jobs of each event, and the runs of a burst", () => {
    const [peak] = workflowPeaks([parse(ci)], OPTIONS);
    // push: 5 merges, each with 3 matrix jobs. The summary needs the test, so it does not run at the same time as it.
    // The review runs only on a pull request, at the same time as the test.
    expect(peak?.classes.push?.peak).toBe(5 * 3);
    expect(peak?.classes.pull?.peak).toBe(5 * (3 + 1));
    expect(peak?.peak).toBe(15 + 20);
    expect(matrixPeak(parse(ci).jobs[0]!)).toBe(3);
  });

  it("gives one run for a group that all runs share, and one run of each other event", () => {
    expect(runsAtOnce({ group: "pages", cancelInProgress: false }, "push", 5)).toBe(1);
    expect(runsAtOnce({ group: "x-${{ github.ref }}", cancelInProgress: false }, "push", 5)).toBe(1);
    expect(runsAtOnce({ group: "x-${{ github.ref }}", cancelInProgress: true }, "pull_request", 5)).toBe(5);
    expect(runsAtOnce(null, "push", 5)).toBe(5);
    expect(runsAtOnce(null, "schedule", 5)).toBe(1);
    expect(runsAtOnce(null, "workflow_call", 5)).toBe(1);
  });

  it("counts the jobs of a called workflow: a local file, the list called, or 1", () => {
    const caller = ["on: [push]", "concurrency: c", "jobs:", "  local:", "    uses: ./.github/workflows/shared.yml", "  remote:", "    uses: o/r/.github/workflows/reusable-ci.yml@abc", "  other:", "    uses: o/r/.github/workflows/unknown.yml@abc", ""].join("\n");
    const shared = ["on: workflow_call", "jobs:", "  a:", "    strategy:", "      matrix:", "        n: [1, 2]", "  b:", "    if: github.event_name == 'pull_request'", "    runs-on: x", ""].join("\n");
    const peaks = workflowPeaks([parse(caller), parse(shared, "shared.yml")], { burst: 5, called: calledJobs(["reusable-ci.yml=7", "bad"]) });
    // A shared workflow has no peak of its own: its callers count its jobs.
    expect(peaks.map((item) => item.file)).toEqual(["ci.yml"]);
    expect(peaks[0]?.classes.push?.jobs.map((job) => [job.id, job.jobs, job.known])).toEqual([
      ["local", 2, true],
      ["remote", 7, true],
      ["other", 1, false],
    ]);
  });

  it("gives the jobs of each run of the shared workflows of the template, as the list TEMPLATE_CALLED", () => {
    const dir = join(import.meta.dirname, "../../../.github/workflows");
    const all = readdirSync(dir)
      .filter((file) => /\.ya?ml$/.test(file))
      .sort()
      .map((file) => parseWorkflow(file, readFileSync(join(dir, file), "utf8")));
    const counts = all
      .filter((workflow) => workflow.file.startsWith("reusable-"))
      .map((workflow) => {
        const caller = { ...workflow, triggers: ["push", "pull_request"] };
        const [peak] = workflowPeaks([caller, ...all.filter((other) => other !== workflow)], { burst: 1, called: {} });
        return `${workflow.file}=${String(Math.max(peak?.classes.push?.peak ?? 0, peak?.classes.pull?.peak ?? 0))}`;
      });
    expect(counts).toEqual([...TEMPLATE_CALLED]);
  });
});

describe("the peak of the graph of the needs", () => {
  const job = (id: string, jobs: number, needs: readonly string[] = [], runs = 1) => ({ id, jobs, needs, runs });
  /** This function gives a workflow on push with no group, and the jobs as YAML lines. */
  const workflow = (jobs: readonly string[]) => parse(["on: [push]", "jobs:", ...jobs, ""].join("\n"));
  const matrix = (id: string, count: number, extra: readonly string[] = []) => [
    `  ${id}:`,
    ...extra.map((line) => `    ${line}`),
    "    strategy:",
    "      matrix:",
    `        n: [${Array.from({ length: count }, (_, i) => String(i)).join(", ")}]`,
  ];

  it("gives the heaviest job of a chain", () => {
    expect(needsPeak([job("a", 2), job("b", 5, ["a"]), job("c", 1, ["b"])])).toBe(5);
    const [peak] = workflowPeaks([workflow([...matrix("a", 2), ...matrix("b", 5, ["needs: a"]), ...matrix("c", 1, ["needs: [b]"])])], { burst: 1, called: {} });
    expect(peak?.classes.push?.peak).toBe(5);
  });

  it("gives the three jobs of a fan-out after one job", () => {
    expect(needsPeak([job("build", 1), job("x", 1, ["build"]), job("y", 1, ["build"]), job("z", 1, ["build"])])).toBe(3);
  });

  it("gives the heavier of the two sides and the ends of a diamond", () => {
    const diamond = (top: number, left: number, right: number, bottom: number) =>
      needsPeak([job("top", top), job("left", left, ["top"]), job("right", right, ["top"]), job("bottom", bottom, ["left", "right"])]);
    expect(diamond(1, 2, 3, 1)).toBe(5);
    expect(diamond(6, 2, 3, 1)).toBe(6);
    expect(diamond(1, 2, 3, 7)).toBe(7);
  });

  it("ignores a name in needs that is not a job that can run on the event", () => {
    // The job gate runs only on a pull request. On push, the job b needs no job that runs, so a and b run at one time.
    const text = workflow(["  gate:", "    if: github.event_name == 'pull_request'", "    runs-on: x", "  a:", "    runs-on: x", "  b:", "    needs: [gate, a]", "    runs-on: x"]);
    expect(workflowPeaks([text], { burst: 1, called: {} })[0]?.classes.push?.peak).toBe(1);
    const both = workflow(["  gate:", "    if: github.event_name == 'pull_request'", "    runs-on: x", "  a:", "    runs-on: x", "  b:", "    needs: [gate]", "    runs-on: x"]);
    expect(workflowPeaks([both], { burst: 1, called: {} })[0]?.classes.push?.peak).toBe(2);
  });

  it("adds the antichain of each layer of runs, as the runs of different stages overlap", () => {
    // A has 2 jobs and 3 runs at one time. B needs A, with 3 jobs and 1 run at one time. Layer 1 has A and B: the heavier
    // is B, 3. Layers 2 and 3 have only A: 2 each. The peak is 3 + 2 + 2 = 7: one run at B and two runs at A. The old sum
    // gave 2 * 3 + 3 * 1 = 9.
    expect(layeredPeak([job("a", 2, [], 3), job("b", 3, ["a"], 1)])).toBe(7);
    // With equal runs, the peak is the runs times the antichain.
    expect(layeredPeak([job("a", 2, [], 4), job("b", 3, ["a"], 4)])).toBe(4 * 3);
    expect(layeredPeak([])).toBe(0);
    const text = workflow([
      ...matrix("a", 2, ["concurrency: a-${{ github.sha }}"]),
      ...matrix("b", 3, ["needs: a", "concurrency: b"]),
    ]);
    const [peak] = workflowPeaks([text], { burst: 3, called: {} });
    expect(peak?.classes.push?.jobs.map((item) => [item.id, item.jobs, item.runs])).toEqual([
      ["a", 2, 3],
      ["b", 3, 1],
    ]);
    expect(peak?.classes.push?.peak).toBe(7);
  });

  it("gives the sum for a cycle of needs, which GitHub refuses", () => {
    expect(needsPeak([job("a", 2, ["b"]), job("b", 3, ["a"])])).toBe(5);
  });

  it("counts the antichain of a called local workflow as the jobs of its caller job", () => {
    const caller = parse(["on: [push]", "concurrency: c", "jobs:", "  call:", "    uses: ./.github/workflows/shared.yml", ""].join("\n"));
    const shared = parse(["on: workflow_call", "jobs:", ...matrix("a", 2), ...matrix("b", 4, ["needs: a"]), ""].join("\n"), "shared.yml");
    expect(workflowPeaks([caller, shared], { burst: 5, called: {} })[0]?.classes.push?.jobs.map((item) => item.jobs)).toEqual([4]);
  });
});

describe("runner-peak", () => {
  const workflow = ["on: [push, pull_request]", "concurrency:", `  group: ci-${OWN_GROUP}`, "jobs:", "  test:", "    strategy:", "      max-parallel: 2", "      matrix:", "        n: [1, 2, 3]", ""].join("\n");

  it("is off with no share, and passes a repository under its share", () => {
    const root = repository({ ".github/workflows/ci.yml": workflow });
    expect(check(root, {}).status).toBe("skipped");
    expect(check(root, { share: 20 }).breaks).toEqual([]);
  });

  it("reports a repository over its share, with the peak of each workflow", () => {
    const root = repository({ ".github/workflows/ci.yml": workflow, ".github/workflows/pages.yml": "on: [push]\nconcurrency: pages\njobs:\n  a:\n    runs-on: x\n" });
    const result = check(root, { share: 19 });
    expect(result.breaks.map((item) => [item.file, item.message])).toEqual([
      [
        ".github/workflows/ci.yml",
        "The workflows can hold 21 jobs at one time in a busy minute, and the share of the repository is 19. ci.yml 20: push 10 on push (up to 5 runs at one time); pull 10 on pull_request (up to 5 runs at one time). pages.yml 1: push 1 on push (up to 1 runs at one time).",
      ],
    ]);
    // A smaller burst brings the repository under its share.
    expect(check(root, { share: 19, burst: 4 }).breaks).toEqual([]);
  });
});
