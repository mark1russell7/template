// Tests of the verdict of the action security-scan (.github/actions/security-scan). Start them with
// "pnpm test:workflows". The last step of the action fails when a scan fails, and names that scan.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { SCANS, type StepResult, evaluate } from "../../.github/actions/security-scan/verdict.ts";
import { choose, main as choiceMain, readPrivate } from "../../.github/actions/security-scan/choice.ts";
import { type Fetch, changedLines, main as newAlertsMain, newAlerts, normalizeMessage, readBaseAlerts, sarifResults } from "../../.github/actions/security-scan/new-alerts.ts";

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
  choice: ok,
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

describe("security-scan: a private repository", () => {
  const auto = { "dependency-review": "auto", codeql: "auto", "osv-upload": "auto" } as const;

  it("auto runs the dependency review, CodeQL and the upload in a public repository", () => {
    const choice = choose({ inputs: auto, isPrivate: false, event: "pull_request" });
    assert.deepEqual(choice.outputs, { "dependency-review": "true", codeql: "true", "osv-upload": "true" });
    assert.deepEqual(choice.skipped, []);
  });

  it("auto skips them in a private repository, and names the skipped scans that the event starts", () => {
    assert.deepEqual(choose({ inputs: auto, isPrivate: true, event: "pull_request" }), { outputs: { "dependency-review": "false", codeql: "false", "osv-upload": "false" }, skipped: ["dependency-review", "codeql"], errors: [] });
    // The dependency review starts only on a pull request, so a push does not name it
    assert.deepEqual(choose({ inputs: auto, isPrivate: true, event: "push" }).skipped, ["codeql"]);
  });

  it('"true" and "false" keep their meaning in a private repository, as before', () => {
    const choice = choose({ inputs: { "dependency-review": "true", codeql: "false", "osv-upload": "true" }, isPrivate: true, event: "pull_request" });
    assert.deepEqual(choice.outputs, { "dependency-review": "true", codeql: "false", "osv-upload": "true" });
    assert.deepEqual(choice.skipped, []);
  });

  it("an input that is not true, false or auto is an error", () => {
    assert.deepEqual(choose({ inputs: { ...auto, codeql: "yes" }, isPrivate: false, event: "push" }).errors, ['The input codeql is "yes". Use "true", "false" or "auto".']);
  });

  it("reads the visibility from the payload, and from the API when the payload has none (a schedule)", async () => {
    const never: Fetch = async () => {
      throw new Error("no request");
    };
    assert.equal(await readPrivate({ PRIVATE: "true" }, never), true);
    const urls: string[] = [];
    const api: Fetch = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ private: true }) };
    };
    assert.equal(await readPrivate({ PRIVATE: "", GITHUB_API_URL: "https://api.example", GITHUB_REPOSITORY: "owner/repo" }, api), true);
    assert.deepEqual(urls, ["https://api.example/repos/owner/repo"]);
    await assert.rejects(readPrivate({ PRIVATE: "" }, answer(403, { message: "no" })), /HTTP 403/);
  });

  it("the step writes the outputs, and fails when it cannot read the visibility", async () => {
    const folder = mkdtempSync(join(tmpdir(), "choice-"));
    const log = mock.method(console, "log", () => undefined);
    try {
      const output = join(folder, "output");
      const env = { DEPENDENCY_REVIEW: "auto", CODEQL: "auto", OSV_UPLOAD: "auto", PRIVATE: "true", EVENT: "pull_request", GITHUB_OUTPUT: output };
      assert.equal(await choiceMain(env, answer(500, {})), 0);
      assert.equal(readFileSync(output, "utf8"), "dependency-review=false\ncodeql=false\nosv-upload=false\nskipped=dependency-review,codeql\n");
      assert.equal(await choiceMain({ ...env, PRIVATE: "" }, answer(500, {})), 1);
      // No input is auto: the step needs no visibility and makes no request
      assert.equal(await choiceMain({ ...env, DEPENDENCY_REVIEW: "true", CODEQL: "true", OSV_UPLOAD: "false", PRIVATE: "" }, answer(500, {})), 0);
    } finally {
      log.mock.restore();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("a scan that auto skips is not a pass: the last step gives a warning that names it and tells why", () => {
    const steps = { ...pullRequest, "dependency-review_scan": skipped, codeql_languages: skipped, codeql_init: skipped, codeql_analyze: skipped, "codeql_new-alerts": skipped };
    const { status, out } = step(steps, { DEPENDENCY_REVIEW: "false", OSV_SCANNER: "true", CODEQL: "false", SKIPPED: "dependency-review,codeql" });
    console.log(out);
    assert.equal(status, 0);
    assert.match(out, /SKIP dependency-review: the repository is private/);
    assert.match(out, /::warning title=Security scan codeql skipped::The scan codeql did not run: the repository is private, and the scan needs GitHub Advanced Security\. Set the input codeql to "true" to start it\./);
    assert.doesNotMatch(out, /::error::/);
  });

  it("red: a failed choice fails the last step, because the expected scans are not known", () => {
    const verdict = evaluate({ steps: { ...pullRequest, choice: failed }, expected: { "dependency-review": false, "osv-scanner": true, codeql: false } });
    assert.deepEqual(verdict.failed, ["choice"]);
    assert.deepEqual(evaluate({ steps: Object.fromEntries(Object.entries(pullRequest).filter(([id]) => id !== "choice")), expected: all }).failed, ["choice"]);
  });

  it("the caller of the template checks out the folder of the actions only in the template, so a stamped private repository has no partial clone", () => {
    const caller = readFileSync(resolve(root, ".github/workflows/security.yml"), "utf8");
    const sparse = caller.replace(/\r\n/g, "\n").split(/\n {6}- /).filter((each) => each.includes("sparse-checkout:"));
    assert.equal(sparse.length, 1);
    assert.match(sparse[0] ?? "", /^if: github\.repository == 'mark1russell7\/template'\n/);
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
    const steps = Object.fromEntries(Object.entries(pullRequest).map(([id, each]) => [id, id === "checkout" ? failed : id === "choice" ? each : skipped]));
    assert.deepEqual(evaluate({ steps, expected: all }).failed, ["checkout", "dependency-review", "osv-scanner", "codeql"]);
  });

  it("reads an empty result as a step that did not run, as the expression of a missing step gives", () => {
    const empty: StepResult = { outcome: "", conclusion: "" };
    const steps = Object.fromEntries(Object.entries(pullRequest).map(([id, each]) => [id, id.startsWith("codeql_") ? empty : each]));
    assert.deepEqual(evaluate({ steps, expected: all }).failed, ["codeql"]);
    assert.deepEqual(evaluate({ steps, expected: { ...all, codeql: false } }).failed, []);
  });

  it("passes CodeQL when the first download of the bundle fails and the second start passes (HTTP 504, 2026-11-08)", () => {
    const verdict = evaluate({ steps: { ...pullRequest, codeql_init: soft, "codeql_init-retry": ok }, expected: all });
    assert.deepEqual(verdict.failed, []);
  });

  it("red: fails CodeQL when the second start also fails, and names that step", () => {
    const steps = { ...pullRequest, codeql_init: soft, "codeql_init-retry": failed, codeql_analyze: skipped, "codeql_new-alerts": skipped };
    const verdict = evaluate({ steps, expected: all });
    assert.deepEqual(verdict.failed, ["codeql"]);
    assert.match(verdict.rows.find((row) => row.name === "codeql")?.reason ?? "", /codeql_init-retry \(failure\)/);
  });

  it("a push run: the dependency review is off, and the other scans pass", () => {
    const steps: Record<string, StepResult> = { choice: ok, checkout: ok, "dependency-review_scan": skipped, "osv-scanner_args": ok, "osv-scanner_scan": soft, "osv-scanner_check": ok, "osv-scanner_upload": ok, codeql_languages: ok, codeql_init: ok, codeql_analyze: ok, "codeql_new-alerts": skipped };
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
    const ids = steps.map((each) => each.id).filter((id) => id !== undefined && id !== "checkout" && id !== "choice");
    assert.ok(ids.length >= 10, `The action has ${String(ids.length)} steps of scans.`);
    for (const each of steps) {
      if (each.id === undefined || each.id === "checkout" || each.id === "choice") continue;
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

  it("the first CodeQL init may fail, a second init starts only then after a wait, and the analysis runs after either", () => {
    /** This function gives the text of the step with the id, up to the next step. */
    const block = (id: string): string => {
      const start = action.indexOf(`\n      id: ${id}\n`);
      assert.ok(start >= 0, `The action has no step ${id}.`);
      return action.slice(start, action.indexOf("\n    - ", start));
    };
    assert.match(block("codeql_init"), /\n {6}continue-on-error: true\n/);
    assert.doesNotMatch(block("codeql_init"), /tools:/);
    assert.ok(block("codeql_init-retry").includes("if: ${{ !cancelled() && steps.codeql_init.outcome == 'failure' }}"));
    // codeql-action ignores "tools: toolcache" in a push or pull request run (seen in run 42471713951)
    assert.doesNotMatch(block("codeql_init-retry"), /tools:/);
    const wait = action.indexOf("\n    - name: Wait before the second CodeQL start\n");
    assert.ok(wait > action.indexOf("\n      id: codeql_init\n") && wait < action.indexOf("\n      id: codeql_init-retry\n"), "The wait is between the two starts.");
    assert.ok(
      action
        .slice(wait, action.indexOf("\n    - ", wait + 1))
        .includes("if: ${{ !cancelled() && steps.codeql_init.outcome == 'failure' }}\n      shell: bash\n      run: sleep 60"),
    );
    assert.doesNotMatch(block("codeql_init-retry"), /continue-on-error/);
    assert.ok(block("codeql_analyze").includes("steps.codeql_init.outcome == 'success' || steps.codeql_init-retry.outcome == 'success'"));
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

// The 4 alerts of cache poisoning that are open on main of the template since 2026-11-05, in the form of the local SARIF.
const POISON = "actions/cache-poisoning/poisonable-step";
const WORKFLOW = ".github/workflows/reusable-pages.yml";
const LINKED = "Potential cache poisoning in the context of the default branch due to privilege checkout of untrusted code from [steps.green.outputs.sha || github.event.workflow_run.head_sha || github.sha](1). ([workflow_dispatch](2)).";
const PLAIN = "Potential cache poisoning in the context of the default branch due to privilege checkout of untrusted code from steps.green.outputs.sha || github.event.workflow_run.head_sha || github.sha. (workflow_dispatch).";
const KNOWN_LINES = [219, 244, 249, 262];

/** This function gives a SARIF file of CodeQL with a result of each entry. */
function sarif(entries: readonly { rule: string; line: number; text?: string }[]): unknown {
  const rules = [...new Set(entries.map((entry) => entry.rule))].map((id) => ({ id, properties: { "security-severity": "9.0" } }));
  const results = entries.map((entry) => ({
    ruleId: entry.rule,
    message: { text: entry.text ?? LINKED },
    locations: [{ physicalLocation: { artifactLocation: { uri: WORKFLOW }, region: { startLine: entry.line, endLine: entry.line + 4 } } }],
  }));
  return { runs: [{ tool: { driver: { name: "CodeQL", rules } }, results }] };
}
/** A diff that changes the lines 210 to 300 of the workflow, as the site bar of #231 does. */
const DIFF = `diff --git a/${WORKFLOW} b/${WORKFLOW}\n--- a/${WORKFLOW}\n+++ b/${WORKFLOW}\n@@ -210,0 +210,91 @@\n+x\n`;
/** A fetch that gives one page of open alerts of the base branch. */
const answer =
  (status: number, body: unknown): Fetch =>
  async () => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
const known = KNOWN_LINES.map((line) => ({ rule: { id: POISON }, most_recent_instance: { location: { path: WORKFLOW, start_line: line }, message: { text: PLAIN } } }));

/** This function starts the step "Fail on new alerts" with a SARIF file, the diff and a fetch, and gives its exit code and output. */
async function newAlertsStep(file: unknown, fetcher: Fetch): Promise<{ status: number; out: string }> {
  const folder = mkdtempSync(join(tmpdir(), "new-alerts-"));
  const lines: string[] = [];
  const log = mock.method(console, "log", (line: unknown) => void lines.push(String(line)));
  try {
    writeFileSync(join(folder, "actions.sarif"), JSON.stringify(file));
    writeFileSync(join(folder, "pull-request.diff"), DIFF);
    const env = { SEVERITY: "high", RESULTS: folder, DIFF: join(folder, "pull-request.diff"), GITHUB_REPOSITORY: "owner/repo", BASE_REF: "main", GH_TOKEN: "token", GITHUB_API_URL: "https://api.example" };
    return { status: await newAlertsMain(env, fetcher), out: lines.join("\n") };
  } finally {
    log.mock.restore();
    rmSync(folder, { recursive: true, force: true });
  }
}

describe("security-scan: the new CodeQL alerts", () => {
  it("removes the links of SARIF from a message, so the message of the API matches", () => {
    assert.equal(normalizeMessage(LINKED), PLAIN);
    assert.equal(normalizeMessage(" a\n  b [c](12) "), "a b c");
  });

  it("green: the 4 alerts that are open on the base branch are not new, also on changed lines", async () => {
    const { status, out } = await newAlertsStep(sarif(KNOWN_LINES.map((line) => ({ rule: POISON, line }))), answer(200, known));
    assert.equal(status, 0, out);
    assert.doesNotMatch(out, /::error/);
  });

  it("red: a 5th alert of the same rule, file and message is new, because the group has more alerts than the base", async () => {
    const { status, out } = await newAlertsStep(sarif([...KNOWN_LINES, 280].map((line) => ({ rule: POISON, line }))), answer(200, known));
    assert.equal(status, 1);
    assert.match(out, /::error::The pull request adds 5 CodeQL alerts at or above high\./);
  });

  it("red: an alert of a new rule on a changed line is new", async () => {
    const entries = [...KNOWN_LINES.map((line) => ({ rule: POISON, line })), { rule: "actions/code-injection/critical", line: 230, text: "Code injection" }];
    const { status, out } = await newAlertsStep(sarif(entries), answer(200, known));
    assert.equal(status, 1);
    assert.match(out, /::error file=\.github\/workflows\/reusable-pages\.yml,line=230,title=CodeQL%3A actions\/code-injection\/critical/);
    assert.match(out, /adds 1 CodeQL alerts/);
  });

  it("red: the step fails when it cannot read the alerts of the base branch", async () => {
    const { status, out } = await newAlertsStep(sarif(KNOWN_LINES.map((line) => ({ rule: POISON, line }))), answer(403, { message: "Resource not accessible by integration" }));
    assert.equal(status, 1);
    assert.match(out, /::error::The step cannot read the open alerts of the base branch.*HTTP 403/);
    const broken: Fetch = async () => {
      throw new Error("network down");
    };
    assert.equal((await newAlertsStep(sarif([]), broken)).status, 1);
  });

  it("a base branch with no analysis has no open alert, so each alert on a changed line is new", async () => {
    const { status } = await newAlertsStep(sarif([{ rule: POISON, line: 219 }]), answer(404, { message: "no analysis found" }));
    assert.equal(status, 1);
  });

  it("an alert on a line that the pull request does not change is not new", () => {
    const { results } = sarifResults([sarif([{ rule: POISON, line: 10 }])], 7, changedLines(DIFF));
    assert.deepEqual(newAlerts(results, []), []);
  });

  it("reads each page of the alerts, with the ref, the state and the tool", async () => {
    const urls: string[] = [];
    const page = (count: number) => Array.from({ length: count }, () => known[0]);
    const fetcher: Fetch = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify(urls.length === 1 ? page(100) : page(3)) };
    };
    const alerts = await readBaseAlerts(fetcher, { api: "https://api.example", repository: "owner/repo", ref: "refs/heads/main", token: "t" });
    assert.equal(alerts.length, 103);
    assert.equal(urls.length, 2);
    assert.match(urls[1] ?? "", /^https:\/\/api\.example\/repos\/owner\/repo\/code-scanning\/alerts\?ref=refs%2Fheads%2Fmain&state=open&tool_name=CodeQL&per_page=100&page=2$/);
  });
});
