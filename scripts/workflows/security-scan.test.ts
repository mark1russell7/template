// Tests of the verdict of the action security-scan (.github/actions/security-scan). Start them with
// "pnpm test:workflows". The last step of the action fails when a scan fails, and names that scan.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SCANS, type StepResult, evaluate } from "../../.github/actions/security-scan/verdict.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const folder = resolve(root, ".github/actions/security-scan");
const action = readFileSync(resolve(folder, "action.yml"), "utf8");

const ok: StepResult = { outcome: "success", conclusion: "success" };
const skipped: StepResult = { outcome: "skipped", conclusion: "skipped" };
const failed: StepResult = { outcome: "failure", conclusion: "failure" };
/** A step with continue-on-error that failed: a scan with findings, which a later step reads. */
const soft: StepResult = { outcome: "failure", conclusion: "success" };

/** The steps of a pull request run where each scan passes. */
const pullRequest: Record<string, StepResult> = {
  checkout: ok,
  "dependency-review_scan": ok,
  "osv-scanner_args": ok,
  "osv-scanner_base-checkout": ok,
  "osv-scanner_base": soft,
  "osv-scanner_head-checkout": ok,
  "osv-scanner_head": soft,
  "osv-scanner_compare": ok,
  "osv-scanner_scan": skipped,
  "osv-scanner_check": skipped,
  "osv-scanner_upload": skipped,
  "osv-scanner_move": ok,
  codeql_languages: ok,
  codeql_init: ok,
  codeql_analyze: ok,
  "codeql_new-alerts": ok,
};
const all = { "dependency-review": true, "osv-scanner": true, codeql: true } as const;

/** This function starts the last step of the action, as action.yml starts it, and gives its exit code and output. */
function step(steps: Record<string, StepResult>, flags: Record<string, string>): { status: number | null; out: string } {
  const env = { PATH: process.env["PATH"], SYSTEMROOT: process.env["SYSTEMROOT"], STEPS: JSON.stringify(steps), ...flags };
  const result = spawnSync(process.execPath, [resolve(folder, "verdict.ts")], { env, encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}
const flagsOn = { DEPENDENCY_REVIEW: "true", OSV_SCANNER: "true", CODEQL: "true" };

describe("security-scan: the last step", () => {
  it("red: a failed scan fails the step, and the error names that scan", () => {
    const { status, out } = step({ ...pullRequest, "osv-scanner_compare": failed }, flagsOn);
    console.log(out);
    assert.equal(status, 1);
    assert.match(out, /::error::Security scan osv-scanner failed: the steps osv-scanner_compare \(failure\) did not pass/);
    assert.doesNotMatch(out, /::error::Security scan (dependency-review|codeql)/);
  });

  it("green: each scan passed, or its input turns it off", () => {
    const off = { ...pullRequest, "dependency-review_scan": skipped, codeql_languages: skipped, codeql_init: skipped, codeql_analyze: skipped, "codeql_new-alerts": skipped };
    const { status, out } = step(off, { DEPENDENCY_REVIEW: "false", OSV_SCANNER: "true", CODEQL: "false" });
    console.log(out);
    assert.equal(status, 0);
    assert.doesNotMatch(out, /::error::/);
    assert.match(out, /OFF  codeql/);
  });

  it("green: each scan passed", () => {
    assert.equal(step(pullRequest, flagsOn).status, 0);
  });

  it("fails on STEPS that is not JSON", () => {
    const result = spawnSync(process.execPath, [resolve(folder, "verdict.ts")], { env: { PATH: process.env["PATH"], STEPS: "" }, encoding: "utf8" });
    assert.equal(result.status, 1);
  });
});

describe("security-scan: evaluate", () => {
  it("names each failed scan, in the order of the job", () => {
    const verdict = evaluate({ steps: { ...pullRequest, "dependency-review_scan": failed, codeql_analyze: { outcome: "cancelled", conclusion: "cancelled" } }, expected: all });
    assert.deepEqual(verdict.failed, ["dependency-review", "codeql"]);
  });

  it("passes a scan step with continue-on-error that found something", () => {
    assert.deepEqual(evaluate({ steps: pullRequest, expected: all }).failed, []);
  });

  it("fails a scan that the inputs start when no step of it ran (a missing scan)", () => {
    const steps = Object.fromEntries(Object.entries(pullRequest).filter(([id]) => !id.startsWith("codeql_")));
    assert.deepEqual(evaluate({ steps, expected: all }).failed, ["codeql"]);
  });

  it("fails each expected scan after a failed checkout", () => {
    const steps = Object.fromEntries(Object.entries(pullRequest).map(([id]) => [id, id === "checkout" ? failed : skipped]));
    assert.deepEqual(evaluate({ steps, expected: all }).failed, ["checkout", "dependency-review", "osv-scanner", "codeql"]);
  });

  it("reads an empty result as a step that did not run, as the expression of a missing step gives", () => {
    const empty: StepResult = { outcome: "", conclusion: "" };
    const steps = Object.fromEntries(Object.entries(pullRequest).map(([id, each]) => [id, id.startsWith("codeql_") ? empty : each]));
    assert.deepEqual(evaluate({ steps, expected: all }).failed, ["codeql"]);
    assert.deepEqual(evaluate({ steps, expected: { ...all, codeql: false } }).failed, []);
  });

  it("a push run: the dependency review is off, and the other scans pass", () => {
    const steps: Record<string, StepResult> = { checkout: ok, "dependency-review_scan": skipped, "osv-scanner_args": ok, "osv-scanner_scan": soft, "osv-scanner_check": ok, "osv-scanner_upload": ok, codeql_languages: ok, codeql_init: ok, codeql_analyze: ok, "codeql_new-alerts": skipped };
    const verdict = evaluate({ steps, expected: { ...all, "dependency-review": false } });
    assert.deepEqual(verdict.failed, []);
    assert.equal(verdict.rows.find((row) => row.name === "dependency-review")?.state, "off");
  });
});

describe("security-scan: action.yml", () => {
  /** The steps of the action: the id and the condition of each step. */
  const steps = action
    .split(/\n    - /)
    .slice(1)
    .map((text) => ({ id: /\n      id: (\S+)/.exec(`\n      ${text}`)?.[1], condition: /\n      if: (.+)/.exec(text)?.[1] ?? "" }));

  it("each step of a scan has an id that starts with a scan and _, and has !cancelled() in its condition", () => {
    const ids = steps.map((each) => each.id).filter((id) => id !== undefined && id !== "checkout");
    assert.ok(ids.length >= 10, `The action has ${String(ids.length)} steps of scans.`);
    for (const each of steps) {
      if (each.id === undefined || each.id === "checkout") continue;
      assert.ok(SCANS.some((scan) => each.id?.startsWith(`${scan}_`)), `The id ${each.id} does not start with a scan.`);
      assert.match(each.condition, /^\$\{\{ !cancelled\(\) && /, `The step ${each.id} does not have !cancelled().`);
    }
  });

  it("each scan has a step, and the last step starts the verdict for each scan", () => {
    for (const scan of SCANS) assert.ok(steps.some((each) => each.id?.startsWith(`${scan}_`)), scan);
    const last = action.slice(action.lastIndexOf("\n    - "));
    for (const name of ["STEPS", "DEPENDENCY_REVIEW", "OSV_SCANNER", "CODEQL"]) assert.match(last, new RegExp(`\\n        ${name}: `));
    assert.match(last, /if: \$\{\{ !cancelled\(\) \}\}/);
    assert.match(last, /run: node "\$VERDICT"/);
  });

  it("STEPS has only the outcome and the conclusion of each step, so a large output does not go in the environment", () => {
    const last = action.slice(action.lastIndexOf("\n    - "));
    assert.doesNotMatch(last, /\n {8}STEPS: \$\{\{/);
    const block = /\n        STEPS: \|\n((?: {10}.*\n)+)/.exec(last)?.[1] ?? "";
    const ids = steps.map((each) => each.id).filter((id): id is string => id !== undefined);
    for (const id of ids) {
      const row = `"${id}": { "outcome": "\${{ steps.${id}.outcome }}", "conclusion": "\${{ steps.${id}.conclusion }}" }`;
      assert.ok(block.includes(row), `STEPS has no row for the step ${id}.`);
    }
    // The runner puts a value in each expression. The result must be the JSON that verdict.ts reads.
    const parsed = JSON.parse(block.replace(/\$\{\{ steps\.[\w-]+\.(outcome|conclusion) \}\}/g, "success")) as Record<string, StepResult>;
    assert.deepEqual(Object.keys(parsed), ids);
    assert.equal(evaluate({ steps: parsed, expected: all }).failed.length, 0);
  });
});
