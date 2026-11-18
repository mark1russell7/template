// Tests match.jq of the action "changes" and summary.jq of the action "gate-summary", with jq. The runners of GitHub
// have jq. A computer with no jq skips these tests, but CI does not.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

const here = import.meta.dirname;
const hasJq = spawnSync("jq", ["--version"]).status === 0;
const skip = !hasJq && process.env["CI"] === undefined ? "jq is not installed" : false;

/** This function starts jq with the arguments `args` and the input `input`, and gives its output. */
function jq(args: readonly string[], input: string): string {
  const result = spawnSync("jq", args, { input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const match = (files: readonly string[], paths: string, ignore = ""): string =>
  jq(["-R", "-s", "-r", "--arg", "paths", paths, "--arg", "ignore", ignore, "-f", join(here, "changes", "match.jq")], files.join("\n"));

const verdict = (needs: Record<string, unknown>, allow = "", last?: Record<string, unknown>): string =>
  jq(
    ["-r", "--arg", "changes", "changes", "--arg", "allow", allow, ...(last === undefined ? [] : ["--argjson", "last", JSON.stringify(last)]), "-f", join(here, "gate-summary", "summary.jq")],
    JSON.stringify(needs),
  );

/** This function gives the last result of the check `check` in the check runs `runs` of a commit, from last.jq. */
const lastOf = (runs: readonly unknown[], check: string): { result: string; run?: string; at?: string; checks?: number } =>
  JSON.parse(jq(["-c", "--arg", "check", check, "-f", join(here, "gate-summary", "last.jq")], JSON.stringify(runs))) as { result: string; run?: string; at?: string; checks?: number };

const failed = (out: string): boolean => out.split("\n").some((line) => line.startsWith("FAIL"));

describe("changes: the patterns of on.pull_request.paths", { skip }, () => {
  const cases: [boolean, string[], string, string?][] = [
    [true, ["packages/core/src/a.ts"], "packages/core/src/**"],
    [false, ["packages/core/README.md"], "packages/core/src/**"],
    [true, ["pilots/src/ireko-x.ts"], "pilots/src/ireko-*.ts"],
    [false, ["pilots/src/sub/ireko-x.ts"], "pilots/src/ireko-*.ts"],
    [true, ["a.js"], "*.js"],
    [false, ["lib/a.js"], "*.js"],
    [true, ["lib/deep/a.js"], "**.js"],
    [true, ["src/a.ts"], "**/*.ts"],
    [true, ["a.ts"], "**/*.ts"],
    [true, ["corpus/a(1)+b.json"], "corpus/**"],
    [false, ["x.yml"], ".github/workflows/x.yml"],
    [true, [".github/workflows/x.yml"], "  .github/workflows/x.yml  \n# a comment"],
    [false, ["src/a.test.ts"], "src/**\n!src/**/*.test.ts"],
    [true, ["src/a.test.ts", "src/b.ts"], "src/**\n!src/**/*.test.ts"],
    [true, ["src/a.test.ts"], "src/**\n!src/**/*.test.ts\nsrc/a.test.ts"],
    [false, ["docs/x.md"], "**", "docs/**"],
    [true, ["docs/x.md", "src/y.ts"], "**", "docs/**"],
    [false, ["packagesX/core/src/a.ts"], "packages/core/src/**"],
    [false, [], "**"],
  ];
  for (const [want, files, paths, ignore] of cases) {
    it(`${String(want)}: ${files.join(",")} | ${paths.replaceAll("\n", " ")} | ${ignore ?? ""}`, () => {
      assert.equal(match(files, paths, ignore), String(want));
    });
  }
});

describe("gate-summary: the verdict of the jobs", { skip }, () => {
  const job = (result: string): unknown => ({ result, outputs: {} });
  const changes = (value?: string): unknown => ({ result: "success", outputs: value === undefined ? {} : { match: value } });
  const cases: [boolean, Record<string, unknown>, string?][] = [
    [true, { changes: changes("true"), gate: job("success") }],
    [false, { changes: changes("true"), gate: job("failure") }],
    [false, { changes: changes("true"), gate: job("cancelled") }],
    [false, { changes: changes("true"), gate: job("skipped") }],
    [true, { changes: changes("true"), gate: job("skipped") }, "gate"],
    [true, { changes: changes("false"), gate: job("skipped") }],
    [false, { changes: changes("false"), gate: job("failure") }],
    [false, { changes: job("failure"), gate: job("skipped") }],
    [false, { changes: changes(), gate: job("skipped") }],
    [false, { gate: job("skipped") }],
    [true, { gate: job("success") }],
    [false, {}],
  ];
  for (const [pass, needs, allow] of cases) {
    it(`${pass ? "passes" : "fails"}: ${JSON.stringify(needs)}${allow === undefined ? "" : ` allow ${allow}`}`, () => {
      assert.equal(failed(verdict(needs, allow)), !pass);
    });
  }
});

describe("gate-summary: the verdict of a gate of reusable-gate.yml", { skip }, () => {
  const job = (result: string): unknown => ({ result, outputs: {} });
  const gate = (result: string, word: string): unknown => ({ result, outputs: { verdict: word, attempts: "2" } });

  it("names the verdict in the line of the job", () => {
    assert.equal(verdict({ gate: gate("success", "pass") }), "ok gate: success, verdict pass");
    assert.equal(verdict({ gate: gate("failure", "no-read") }), "FAIL gate: failure, verdict no-read");
    assert.equal(verdict({ gate: gate("failure", "block") }), "FAIL gate: failure, verdict block");
    assert.equal(verdict({ gate: gate("failure", "error") }), "FAIL gate: failure, verdict error");
  });

  it("fails a success with a verdict that is not pass, because the verdict and the result disagree", () => {
    for (const word of ["no-read", "block", "error"]) assert.equal(verdict({ gate: gate("success", word) }), `FAIL gate: success, but the verdict is ${word}`);
  });

  it("keeps the line of a job with no verdict or with an output verdict of another meaning", () => {
    assert.equal(verdict({ gate: job("success") }), "ok gate: success");
    assert.equal(verdict({ gate: { result: "success", outputs: { verdict: "findings" } } }), "ok gate: success");
    assert.equal(verdict({ gate: { result: "failure", outputs: { verdict: "pass" } } }), "FAIL gate: failure");
  });
});

describe("gate-summary: a skip reads the last result of its check on the commit", { skip }, () => {
  const run = (id: number, name: string, conclusion: string | null, at: string, status = "completed"): unknown => ({
    name,
    status,
    conclusion,
    completed_at: at,
    details_url: `https://github.com/o/r/actions/runs/${String(id)}/job/${String(id * 10)}`,
  });

  it("gives no result for a commit with no check of the job", () => {
    assert.deepEqual(lastOf([], "Speed gates"), { result: "none" });
    assert.deepEqual(lastOf([run(1, "Other", "failure", "2026-11-01T00:00:00Z")], "Speed gates"), { result: "none" });
  });

  it("reads each entry of a matrix in the newest run that decided", () => {
    const runs = [
      run(1, "Speed gates 1", "failure", "2026-11-01T00:00:00Z"),
      run(2, "Speed gates 1", "success", "2026-11-02T00:00:00Z"),
      run(2, "Speed gates 2", "success", "2026-11-02T00:01:00Z"),
    ];
    assert.deepEqual(lastOf(runs, "Speed gates"), { run: "2", at: "2026-11-02T00:01:00Z", checks: 2, result: "success" });
    const failed = [...runs, run(3, "Speed gates (1)", "success", "2026-11-03T00:00:00Z"), run(3, "Speed gates (2)", "failure", "2026-11-03T00:01:00Z")];
    assert.equal(lastOf(failed, "Speed gates").result, "failure");
  });

  it("goes back over a skip, a cancel and a run in progress, because they decide nothing", () => {
    const runs = [
      run(1, "Speed gates 1", "failure", "2026-11-01T00:00:00Z"),
      run(2, "Speed gates ${{ matrix.rep }}", "skipped", "2026-11-02T00:00:00Z"),
      run(3, "Speed gates 1", "cancelled", "2026-11-03T00:00:00Z"),
      run(4, "Speed gates 1", null, "2026-11-04T00:00:00Z", "in_progress"),
    ];
    assert.deepEqual(lastOf(runs, "Speed gates"), { run: "1", at: "2026-11-01T00:00:00Z", checks: 1, result: "failure" });
  });

  it("does not read the summary job <check> OK as an entry of the check", () => {
    const runs = [run(1, "gates", "success", "2026-11-01T00:00:00Z"), run(2, "gates OK", "failure", "2026-11-02T00:00:00Z")];
    assert.equal(lastOf(runs, "gates").result, "success");
  });

  const needs = { changes: { result: "success", outputs: { match: "true" } }, gates: { result: "skipped", outputs: {} } };
  const read = (result: string): Record<string, unknown> => ({ gates: { result, run: "7", sha: "0123456789abcdef", check: "Speed gates", why: "HTTP 403" } });
  it("passes a skip after a pass, and fails it after a failure or with no read of the checks", () => {
    assert.equal(failed(verdict(needs, "", read("success"))), false);
    assert.match(verdict(needs, "", read("success")), /^ok gates: skipped, and the last result of "Speed gates" on 0123456 passed \(run 7\)$/m);
    assert.equal(failed(verdict(needs, "", read("failure"))), true);
    assert.equal(failed(verdict(needs, "gates", read("failure"))), true);
    assert.equal(failed(verdict(needs, "", read("timed_out"))), true);
    assert.match(verdict(needs, "", read("error")), /^FAIL gates: skipped, and the check runs of 0123456 cannot be read: HTTP 403$/m);
  });

  it("gives a no read, not a pass, for a skip with no result on the commit", () => {
    const out = verdict(needs, "", read("none"));
    assert.equal(failed(out), false);
    assert.match(out, /^no read gates: skipped, and 0123456 has no result of "Speed gates"$/m);
    assert.doesNotMatch(out, /^ok gates/m);
  });

  it("keeps the pass of a pull request that changes no file of the gate", () => {
    const nomatch = { ...needs, changes: { result: "success", outputs: { match: "false" } } };
    assert.match(verdict(nomatch, "", read("none")), /^ok gates: skipped, the pull request changes no file of the gate$/m);
  });
});
