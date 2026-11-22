// The tests of scripts/stamp/settings.ts: the summary checks of a workflow, the four settings of a new repository and
// their order, and a start with a fake gh. Start them with "pnpm test:stamp". They make no request to GitHub.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ACTIONS_APP } from "../workflows/ruleset-ci-ok.ts";
import { birthSteps, type RepoState, setSettings, summaryChecks } from "./settings.ts";

const template = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = (name: string): string => readFileSync(join(template, ".github", "workflows", name), "utf8");
const STAMPED = ["ci.yml", "security.yml", "pages.yml"].map(workflow);
const NEW: RepoState = { branch: true, required: [], alerts: false, hasPages: false, autoMerge: false };

describe("summaryChecks", () => {
  it("gives CI OK and Security OK from the workflows of the template that the stamp copies", () => {
    assert.deepEqual(summaryChecks(workflow("ci.yml")), ["CI OK"]);
    assert.deepEqual(summaryChecks(workflow("security.yml")), ["Security OK"]);
  });

  it("gives no check for a workflow that does not start on a pull request", () => {
    assert.deepEqual(summaryChecks(workflow("pages.yml")), []);
    assert.deepEqual(summaryChecks("on:\n  push:\njobs:\n  ok:\n    name: Push OK\n"), []);
    assert.deepEqual(summaryChecks("on:\n  pull_request_target:\njobs:\n  ok:\n    name: Target OK\n"), []);
  });

  it("reads the short forms of on, a quoted name, and only names of the form <Name> OK", () => {
    assert.deepEqual(summaryChecks("on: pull_request\njobs:\n  a:\n    name: Lint OK\n  b:\n    name: build\n"), ["Lint OK"]);
    assert.deepEqual(summaryChecks("on: [push, pull_request]\njobs:\n  a:\n    name: \"Joint bench OK\"\n"), ["Joint bench OK"]);
    assert.deepEqual(summaryChecks("\"on\":\n  pull_request:\njobs:\n  a:\n    name: ${{ matrix.os }} OK\n"), []);
  });
});

describe("birthSteps", () => {
  it("gives the four settings of a new repository in order: the dependency graph, the ruleset, Pages, auto-merge", () => {
    const steps = birthSteps("o/new", STAMPED, true, NEW);
    assert.deepEqual(
      steps.map((s) => [s.setting, s.state]),
      [
        ["the dependency graph", "do"],
        ["the ruleset", "do"],
        ["the Pages source", "do"],
        ["auto-merge", "do"],
      ],
    );
    assert.deepEqual(steps[0]?.args, ["api", "-X", "PUT", "repos/o/new/vulnerability-alerts"]);
    assert.deepEqual(steps[2]?.args, ["api", "-X", "POST", "repos/o/new/pages", "-f", "build_type=workflow"]);
    assert.deepEqual(steps[3]?.args, ["api", "-X", "PATCH", "repos/o/new", "-F", "allow_auto_merge=true"]);
  });

  it("asks the ruleset for each summary check, CI OK first, only from GitHub Actions, with no bypass", () => {
    const body = birthSteps("o/new", STAMPED, true, NEW)[1]?.body as { name: string; conditions: unknown; rules: { parameters: { required_status_checks: unknown } }[]; bypass_actors?: unknown };
    assert.equal(body.name, "CI OK");
    assert.deepEqual(body.conditions, { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } });
    assert.deepEqual(body.rules[0]?.parameters.required_status_checks, [
      { context: "CI OK", integration_id: ACTIONS_APP },
      { context: "Security OK", integration_id: ACTIONS_APP },
    ]);
    assert.equal(body.bypass_actors, undefined);
  });

  it("keeps each setting that the repository has, and adds only the checks that no ruleset names", () => {
    const have = birthSteps("o/a", STAMPED, true, { branch: true, required: ["CI OK", "Security OK"], alerts: true, hasPages: true, autoMerge: true });
    assert.deepEqual(have.map((s) => s.state), ["have", "have", "have", "have"]);
    const part = birthSteps("o/a", STAMPED, true, { ...NEW, required: ["CI OK"] });
    assert.deepEqual(part[1]?.body?.["name"], "Security OK");
  });

  it("skips the Pages source with no pages.yml, and the ruleset with no summary check", () => {
    const steps = birthSteps("o/a", ["on: push\njobs:\n  a:\n    name: build\n"], false, NEW);
    assert.deepEqual(steps.map((s) => s.state), ["do", "skip", "skip", "do"]);
  });
});

describe("setSettings", () => {
  const folder = mkdtempSync(join(tmpdir(), "settings-test-"));
  after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, ".github", "workflows"), { recursive: true });
  for (const name of ["ci.yml", "security.yml", "pages.yml"]) writeFileSync(join(folder, ".github", "workflows", name), workflow(name));

  /** A fake gh: each read of a new repository, and a record of each call. An unknown path gives HTTP 404. */
  function fakeGh(branch: boolean): { calls: string[][]; exec: (args: readonly string[]) => Promise<string> } {
    const calls: string[][] = [];
    const notFound = (): Error => Object.assign(new Error("Command failed: gh api"), { stderr: "gh: Not Found (HTTP 404)" });
    return {
      calls,
      exec: async (args) => {
        calls.push([...args]);
        const path = args.find((a) => a.startsWith("repos/")) ?? "";
        if (args.includes("-X")) return "";
        if (path === "repos/o/new") return JSON.stringify({ default_branch: "main", has_pages: false, allow_auto_merge: false });
        if (path === "repos/o/new/branches/main" && branch) return "";
        if (path === "repos/o/new/rules/branches/main") return "[]";
        throw notFound();
      },
    };
  }

  it("changes nothing without --apply", async () => {
    const { calls, exec } = fakeGh(true);
    const out: string[] = [];
    assert.equal(await setSettings({ repo: "o/new", folder, apply: false, exec, log: (line) => out.push(line) }), 0);
    assert.equal(calls.filter((c) => c.includes("-X")).length, 0);
    assert.equal(out.filter((line) => line.startsWith("would")).length, 4);
  });

  it("sets the four settings in order with --apply, and gives the ruleset its body as a file", async () => {
    const { calls, exec } = fakeGh(true);
    assert.equal(await setSettings({ repo: "o/new", folder, apply: true, exec, log: () => undefined }), 0);
    const writes = calls.filter((c) => c.includes("-X"));
    assert.deepEqual(
      writes.map((c) => `${c[2] ?? ""} ${c[3] ?? ""}`),
      ["PUT repos/o/new/vulnerability-alerts", "POST repos/o/new/rulesets", "POST repos/o/new/pages", "PATCH repos/o/new"],
    );
    assert.ok(writes[1]?.includes("--input"));
  });

  it("refuses a repository with no commit on its default branch, and changes nothing", async () => {
    const { calls, exec } = fakeGh(false);
    const out: string[] = [];
    assert.equal(await setSettings({ repo: "o/new", folder, apply: true, exec, log: (line) => out.push(line) }), 2);
    assert.equal(calls.filter((c) => c.includes("-X")).length, 0);
    assert.match(out.join("\n"), /Push the first commit first/);
  });
});
