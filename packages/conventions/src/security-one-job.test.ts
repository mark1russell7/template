// The rule security-one-job on fixture repositories: the caller of reusable-security.yml, the one job of the fix, the
// inputs, the cases that need a person, and the second run of the fix.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, runFix, type RuleResult } from "./index.ts";
import { SECURITY_SCAN_COMMIT, securityCallers, withOneJob } from "./rules/security-one-job.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-security-one-job-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

const ID = "security-one-job";
const FILE = ".github/workflows/security.yml";
const OLD = "1111111111111111111111111111111111111111";

const HEAD = ["name: Security", "", "on:", "  pull_request:", "  push:", "    branches: [main]", "", "permissions: {}", "", "jobs:"];

/** The job of the shared workflow, with the lines of its `with` block. */
const scans = (inputs: readonly string[] = [], uses = `mark1russell7/template/.github/workflows/reusable-security.yml@${OLD} # main`): string[] => [
  "  security:",
  `    uses: ${uses}`,
  "    permissions:",
  "      contents: read",
  "      security-events: write",
  "      actions: read",
  ...(inputs.length > 0 ? ["    with:", ...inputs.map((line) => `      ${line}`)] : []),
];

/** The summary job of the template, with its needs and its name. */
const summary = (needs = "[security]", name = "Security OK"): string[] => [
  "  security-ok:",
  `    name: ${name}`,
  "    if: always()",
  `    needs: ${needs}`,
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 2",
  "    permissions: {}",
  "    steps:",
  "      - name: Each scan passed",
  "        env:",
  "          NEEDS: ${{ toJSON(needs) }}",
  "        run: |",
  '          echo "$NEEDS"',
  "          exit 0",
];

const file = (...jobs: (readonly string[])[]): string => [...HEAD, ...jobs.flatMap((job, at) => (at === 0 ? job : ["", ...job])), ""].join("\n");

/** The one job of the fix, with the lines of its `with` block. */
const oneJob = (timeout = "30", inputs: readonly string[] = []): string[] => [
  "  security-ok:",
  "    name: Security OK",
  "    runs-on: ubuntu-latest",
  `    timeout-minutes: ${timeout}`,
  "    permissions:",
  "      contents: read",
  "      security-events: write",
  "      actions: read",
  "    steps:",
  `      - uses: mark1russell7/template/.github/actions/security-scan@${SECURITY_SCAN_COMMIT} # main`,
  ...(inputs.length > 0 ? ["        with:", ...inputs.map((line) => `          ${line}`)] : []),
];

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

const reasonOf = (text: string): string => {
  const after = withOneJob(text);
  return "reason" in after ? after.reason : "";
};

describe("the rule security-one-job", () => {
  it("finds a job of reusable-security.yml, pinned or in the template itself", () => {
    expect(securityCallers(file(scans(), summary()))).toEqual([{ line: 10, id: "security" }]);
    expect(securityCallers(file(scans([], "./.github/workflows/reusable-security.yml"), summary())).map((each) => each.id)).toEqual(["security"]);
    expect(securityCallers(file(oneJob()))).toEqual([]);
    expect(securityCallers(file(scans([], "mark1russell7/template/.github/workflows/reusable-ci.yml@abc # main")))).toEqual([]);
    expect(securityCallers("on: push\n")).toEqual([]);
  });

  it("replaces the two jobs with one job Security OK", () => {
    expect(withOneJob(file(scans(), summary()))).toEqual({ text: file(oneJob()) });
  });

  it("gives the inputs to the action and timeout-minutes to the job", () => {
    const text = file(scans(["codeql: false", "timeout-minutes: 20", 'osv-lockfile: "pnpm-lock.yaml"']), summary());
    expect(withOneJob(text)).toEqual({ text: file(oneJob("20", ["codeql: false", 'osv-lockfile: "pnpm-lock.yaml"'])) });
  });

  it("keeps the other jobs, the line endings and a summary job before the scans", () => {
    const other = ["  other:", "    runs-on: ubuntu-latest", "    steps:", "      - run: echo other"];
    expect(withOneJob(file(other, scans(), summary()))).toEqual({ text: file(other, oneJob()) });
    expect(withOneJob(file(summary(), scans()))).toEqual({ text: file(oneJob()) });
    const crlf = file(scans(), summary()).replaceAll("\n", "\r\n");
    expect(withOneJob(crlf)).toEqual({ text: file(oneJob()).replaceAll("\n", "\r\n") });
  });

  it("reads each form of needs", () => {
    expect("text" in withOneJob(file(scans(), summary("security")))).toBe(true);
    expect("text" in withOneJob(file(scans(), summary('["security"]')))).toBe(true);
  });

  it("leaves each other form to a person, with the reason", () => {
    expect(reasonOf(file(scans(), summary("[security, build]")))).toContain("the summary job needs security, build");
    expect(reasonOf(file(scans(), summary("[security]", "Scans OK")))).toContain("not Security OK");
    expect(reasonOf(file(scans()))).toContain("0 jobs need the job security");
    expect(reasonOf(file(scans(["extra: true"]), summary()))).toContain("no input extra");
    expect(reasonOf(file(scans(["codeql-languages: >-", "  javascript-typescript"]), summary()))).toContain("more than one line");
    expect(reasonOf(file([...scans(), "    secrets: inherit"], summary()))).toContain("the key secrets");
  });

  it("fails on the shared workflow, and the fix passes on its second run", () => {
    const root = repository(file(scans(["codeql: false"]), summary()));
    expect(check(root).breaks.map((each) => [each.file, each.line])).toEqual([[FILE, 11]]);
    expect(runFix({ root, only: [ID] }).changed).toEqual([FILE]);
    expect(readFileSync(join(root, FILE), "utf8")).toBe(file(oneJob("30", ["codeql: false"])));
    expect(check(root).breaks).toEqual([]);
    expect(runFix({ root, only: [ID] }).changed).toEqual([]);
  });

  it("does not change a file that needs a person", () => {
    const text = file(scans(), summary("[security, build]"));
    const root = repository(text);
    const breaks = check(root).breaks;
    expect(breaks.length).toBe(1);
    expect(breaks[0]?.fix).toContain("A person must change it");
    expect(runFix({ root, only: [ID] }).changed).toEqual([]);
    expect(readFileSync(join(root, FILE), "utf8")).toBe(text);
  });
});
