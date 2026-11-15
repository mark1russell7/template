// The tests of the decisions of scripts/workflows/ruleset-ci-ok.ts: which summary checks a ruleset misses, and the
// report and exit code of --check. Start them with "pnpm test:workflows". They make no request to GitHub.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkReport, missingChecks } from "./ruleset-ci-ok.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("missingChecks", () => {
  it("puts CI OK first and the other summary checks in name order", () => {
    const { wanted } = missingChecks(new Set(["Xplat OK", "Security OK", "CI OK"]), []);
    assert.deepEqual(wanted, ["CI OK", "Security OK", "Xplat OK"]);
  });

  it("gives each passed summary check that no rule names", () => {
    assert.deepEqual(missingChecks(new Set(["CI OK", "Security OK"]), ["CI OK"]).missing, ["Security OK"]);
    assert.deepEqual(missingChecks(new Set(["CI OK", "Security OK"]), []).missing, ["CI OK", "Security OK"]);
  });

  it("gives no missing check when the rules name each one, also with more checks in the rules", () => {
    assert.deepEqual(missingChecks(new Set(["CI OK"]), ["CI OK", "build"]).missing, []);
  });
});

describe("checkReport", () => {
  it("exits 0 when each repository has its checks or is a no read", () => {
    const { code, text } = checkReport([
      { repo: "o/a", state: "have", checks: ["CI OK", "Security OK"] },
      { repo: "o/new", state: "no read", reason: 'no "CI OK" that passed on the last 5 pull requests into main' },
    ]);
    assert.equal(code, 0);
    assert.match(text, /0 miss a check, 1 no read, 1 have each check\./);
    assert.doesNotMatch(text, /--apply/);
  });

  it("exits 1 when a repository misses a check, lists it first, and gives the command that adds the ruleset", () => {
    const { code, text } = checkReport([
      { repo: "o/a", state: "have", checks: ["CI OK"] },
      { repo: "o/z", state: "missing", missing: ["CI OK", "Security OK"] },
      { repo: "o/b", state: "missing", missing: ["Security OK"] },
    ]);
    assert.equal(code, 1);
    const rows = text.split("\n").filter((line) => line.startsWith("| o/"));
    assert.deepEqual(rows.map((row) => row.split(" | ")[0]), ["| o/b", "| o/z", "| o/a"]);
    assert.ok(rows[1]?.includes("no ruleset names CI OK, Security OK"));
    assert.match(text, /`node scripts\/workflows\/ruleset-ci-ok\.ts o\/b o\/z --only-summary --apply`/);
  });

  it("is a no read, not a pass, for a repository with no read", () => {
    const { text } = checkReport([{ repo: "o/x", state: "no read", reason: "the GitHub API gave an error (see the log)" }]);
    assert.match(text, /\| o\/x \| no read \| the GitHub API gave an error \(see the log\) \|/);
  });
});

describe("the workflow rulesets.yml", () => {
  const workflow = readFileSync(resolve(root, ".github/workflows/rulesets.yml"), "utf-8");

  it("runs the check each day and by hand, with a token that only reads", () => {
    assert.match(workflow, /\n {2}schedule:\n {4}- cron: "[^"]+"\n/);
    assert.match(workflow, /\n {2}workflow_dispatch:\n/);
    assert.match(workflow, /\npermissions: \{\}\n/);
    assert.match(workflow, /\n {6}contents: read\n/);
    assert.doesNotMatch(workflow, /: write\b/);
    assert.match(workflow, /node scripts\/workflows\/ruleset-ci-ok\.ts --check\n/);
  });
});
