// The rule security-gate on fixture repositories: a gate ci.yml with no security gate, the file that the fix writes, the
// cases that need a person, the cases that the rule skips, and the second run of the fix.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, runFix, type RuleResult } from "./index.ts";
import { scheduleMinute } from "./rules/runner-budget.ts";
import { SECURITY_FILE, isSecurityGate, securityWorkflow } from "./rules/security-gate.ts";
import { SECURITY_SCAN_COMMIT } from "./rules/security-one-job.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-security-gate-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

const ID = "security-gate";
const CI = ".github/workflows/ci.yml";
const COMMIT = "1111111111111111111111111111111111111111";

/** A gate ci.yml: a pull request trigger and one job. */
const ciGate = (trigger = "  pull_request:"): string =>
  ["name: CI", "", "on:", trigger, "  push:", "    branches: [main]", "", "permissions: {}", "", "jobs:", "  ci-ok:", "    name: CI OK", "    runs-on: ubuntu-latest", "    timeout-minutes: 10", "    steps:", "      - run: echo ok", ""].join("\n");

/** This function makes a git repository with the files, and gives its root. `remote` is the URL of the remote origin, or null for none. */
function repository(files: Readonly<Record<string, string>>, remote: string | null = "https://github.com/o/one.git"): string {
  const root = join(temp, String(fixtures++));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), '{ "name": "one" }\n');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const steps = [["init", "-q", "-b", "main"], ...(remote === null ? [] : [["remote", "add", "origin", remote]]), ["add", "-A"], ["commit", "-q", "-m", "first"]];
  for (const args of steps) {
    const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return root;
}

function check(root: string, env: Readonly<Record<string, string>> = {}): RuleResult {
  const result = runChecks({ root, only: [ID], env }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

describe("the rule security-gate", () => {
  it("writes the file of the template, as the stamp writes it: the action pinned, the minute of the template", () => {
    const template = readFileSync(new URL("../../../.github/workflows/security.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const stamped = template.replace("      - uses: ./.github/actions/security-scan\n", `      - uses: mark1russell7/template/.github/actions/security-scan@${COMMIT} # main\n`);
    expect(stamped).not.toBe(template);
    expect(securityWorkflow("mark1russell7/template", COMMIT)).toBe(stamped);
  });

  it("gives each repository the minute of its file, and pins the commit of security-one-job by default", () => {
    const text = securityWorkflow("o/one");
    expect(text).toContain(`    - cron: "${String(scheduleMinute("o/one", SECURITY_FILE))} 5 * * 1"`);
    expect(text).toContain(`security-scan@${SECURITY_SCAN_COMMIT} # main`);
  });

  it("knows a security gate: the job Security OK, the action security-scan, or the shared workflow of the scans", () => {
    expect(isSecurityGate(securityWorkflow("o/one"))).toBe(true);
    expect(isSecurityGate("jobs:\n  scan:\n    steps:\n      - uses: ./.github/actions/security-scan\n")).toBe(true);
    expect(isSecurityGate("jobs:\n  security:\n    uses: mark1russell7/template/.github/workflows/reusable-security.yml@abc # main\n")).toBe(true);
    expect(isSecurityGate('jobs:\n  security-ok:\n    name: "Security OK"\n')).toBe(true);
    expect(isSecurityGate(ciGate())).toBe(false);
  });

  it("breaks a gate ci.yml with no security gate, and the fix writes security.yml with the minute of the remote", () => {
    const root = repository({ [CI]: ciGate() });
    const result = check(root);
    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]?.file).toBe(SECURITY_FILE);
    expect(result.breaks[0]?.edits).toEqual([{ file: SECURITY_FILE, before: "", after: securityWorkflow("o/one") }]);
    expect(runFix({ root, only: [ID] }).changed).toEqual([SECURITY_FILE]);
    expect(readFileSync(join(root, SECURITY_FILE), "utf8")).toBe(securityWorkflow("o/one"));
    expect(check(root).breaks).toEqual([]);
    expect(runFix({ root, only: [ID] }).changed).toEqual([]);
  });

  it("takes the repository from GITHUB_REPOSITORY before the remote", () => {
    const root = repository({ [CI]: ciGate() });
    expect(check(root, { GITHUB_REPOSITORY: "o/two" }).breaks[0]?.edits?.[0]?.after).toBe(securityWorkflow("o/two"));
  });

  it("passes a repository with a security gate in any workflow file", () => {
    expect(check(repository({ [CI]: ciGate(), [SECURITY_FILE]: securityWorkflow("o/one") })).breaks).toEqual([]);
    expect(check(repository({ [CI]: ciGate(), ".github/workflows/scans.yml": securityWorkflow("o/one") })).breaks).toEqual([]);
  });

  it("needs a person when security.yml is there and is not a gate, or when no remote gives the minute", () => {
    const other = check(repository({ [CI]: ciGate(), [SECURITY_FILE]: "name: Security\non: push\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n" }));
    expect(other.breaks).toHaveLength(1);
    expect(other.breaks[0]?.edits).toBeUndefined();
    expect(other.breaks[0]?.fix).toMatch(/^A person must change it/u);
    const lone = check(repository({ [CI]: ciGate() }, null));
    expect(lone.breaks).toHaveLength(1);
    expect(lone.breaks[0]?.edits).toBeUndefined();
    expect(lone.breaks[0]?.fix).toMatch(/^A person must add it/u);
  });

  it("skips a repository with no gate ci.yml, and a private repository", () => {
    expect(check(repository({ "README.md": "# one\n" })).status).toBe("skipped");
    expect(check(repository({ [CI]: ciGate("  workflow_dispatch:") })).status).toBe("skipped");
    const event = join(temp, "private-event.json");
    writeFileSync(event, JSON.stringify({ repository: { private: true } }));
    const root = repository({ [CI]: ciGate() });
    const hidden = check(root, { GITHUB_EVENT_PATH: event });
    expect([hidden.status, hidden.note]).toEqual(["skipped", "the repository is private"]);
    writeFileSync(event, JSON.stringify({ repository: { private: false } }));
    expect(check(root, { GITHUB_EVENT_PATH: event }).breaks).toHaveLength(1);
  });
});
