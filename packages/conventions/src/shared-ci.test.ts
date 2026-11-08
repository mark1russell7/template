// The rule shared-ci on fixture repositories: a ci.yml that calls the shared CI, one with its own steps, a missing
// ci.yml, local copies of a shared workflow and of a shared action, and the template itself.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, type RuleResult } from "./index.ts";
import { SHARED_ACTIONS, SHARED_WORKFLOWS, callsSharedCi } from "./rules/shared-ci.ts";

// The lists of the rule are the files of the template: a new shared workflow or action without a change here fails.
describe("the shared lists", () => {
  const github = join(import.meta.dirname, "..", "..", "..", ".github");
  it("are the reusable workflows and the actions of the template", () => {
    const workflows = readdirSync(join(github, "workflows")).filter((name) => /^reusable-.*\.yml$/.test(name));
    expect([...SHARED_WORKFLOWS].sort()).toEqual(workflows.sort());
    const actions = readdirSync(join(github, "actions"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    expect([...SHARED_ACTIONS].sort()).toEqual(actions.sort());
  });
});

const temp = mkdtempSync(join(tmpdir(), "conventions-shared-ci-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

const ID = "shared-ci";
const CI = ".github/workflows/ci.yml";
const PIN = "1111111111111111111111111111111111111111";

const caller = (uses = `mark1russell7/template/.github/workflows/reusable-ci.yml@${PIN} # main`): string =>
  ["name: CI", "", "on:", "  pull_request:", "", "permissions: {}", "", "jobs:", "  ci:", `    uses: ${uses}`, "    permissions:", "      contents: read", ""].join("\n");

const ownSteps = ["name: CI", "", "on:", "  pull_request:", "", "jobs:", "  run:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v7", "      - run: pnpm test", ""].join("\n");

/** This function makes a git repository with the files, and gives its root. */
function repository(files: Readonly<Record<string, string>>, name = "one"): string {
  const root = join(temp, String(fixtures++));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), `{ "name": "${name}" }\n`);
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

const messages = (result: RuleResult): string[] => result.breaks.map((each) => each.file);

describe("the rule shared-ci", () => {
  it("finds the call of the shared CI, pinned, and no other workflow", () => {
    expect(callsSharedCi(CI, caller())).toBe(true);
    expect(callsSharedCi(CI, caller("mark1russell7/template/.github/workflows/reusable-ci.yml@main"))).toBe(true);
    expect(callsSharedCi(CI, caller(`mark1russell7/template/.github/workflows/reusable-security.yml@${PIN}`))).toBe(false);
    expect(callsSharedCi(CI, caller(`someone/template/.github/workflows/reusable-ci.yml@${PIN}`))).toBe(false);
    expect(callsSharedCi(CI, ownSteps)).toBe(false);
  });

  it("passes a repository whose ci.yml calls the shared CI", () => {
    const result = check(repository({ [CI]: caller() }));
    expect(result.breaks).toEqual([]);
    expect(result.status).toBe("pass");
  });

  it("breaks a ci.yml with its own steps, and a missing ci.yml", () => {
    expect(messages(check(repository({ [CI]: ownSteps })))).toEqual([CI]);
    expect(check(repository({ ".github/workflows/other.yml": caller() })).breaks.map((each) => each.message)).toEqual([`${CI} is missing, so no job calls the shared CI of the template.`]);
  });

  it("breaks a local copy of a shared workflow and of a shared action, once for each action", () => {
    const root = repository({
      [CI]: caller(),
      ".github/workflows/reusable-ci.yml": ownSteps,
      ".github/actions/gate-summary/action.yml": "name: gate\nruns:\n  using: composite\n  steps: []\n",
      ".github/actions/gate-summary/README.md": "the copy\n",
      ".github/actions/flip/action.yml": "name: flip\nruns:\n  using: composite\n  steps: []\n",
    });
    expect(messages(check(root))).toEqual([".github/workflows/reusable-ci.yml", ".github/actions/gate-summary"]);
  });

  it("does not examine the template, the home of the shared workflows", () => {
    const result = check(repository({ [CI]: ownSteps, ".github/workflows/reusable-ci.yml": ownSteps }, "template-monorepo"));
    expect(result.status).toBe("skipped");
    expect(result.note).toMatch(/home of the shared workflows/);
  });
});
