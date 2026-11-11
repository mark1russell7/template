// Tests scripts/version-check/version-check.ts: the date that fails the step, the annotations and the exit code.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { drifts, evaluate, failsOn, type Drift } from "../version-check/version-check.ts";

const same: Drift = { name: "@scope/same", version: "1.0.0", differences: [] };
const changed: Drift = { name: "@scope/changed", version: "0.2.3", differences: ["dist/index.js (changed)", "README.md (changed)"] };

describe("failsOn", () => {
  it("fails from the date, not before it", () => {
    assert.equal(failsOn("2026-12-07", "2026-12-06"), false);
    assert.equal(failsOn("2026-12-07", "2026-12-07"), true);
    assert.equal(failsOn("2026-12-07", "2027-01-01"), true);
  });

  it("fails at once with an empty date", () => {
    assert.equal(failsOn("", "2026-11-09"), true);
  });

  it("refuses a value that is not a date", () => {
    assert.throws(() => failsOn("next week", "2026-11-09"), /is not a date/u);
    assert.throws(() => failsOn("2026-12-7", "2026-11-09"), /is not a date/u);
  });
});

describe("evaluate", () => {
  it("passes with no annotation when each package is the same as npm", () => {
    assert.deepEqual(evaluate([same], "2026-12-07", "2027-01-01"), { level: "notice", lines: [], exitCode: 0 });
    assert.deepEqual(evaluate([], "", "2026-11-09"), { level: "notice", lines: [], exitCode: 0 });
  });

  it("warns and passes before the date", () => {
    const result = evaluate([same, changed], "2026-12-07", "2026-11-09");
    assert.equal(result.level, "warning");
    assert.equal(result.exitCode, 0);
    assert.equal(result.lines.length, 1);
    assert.match(result.lines[0] ?? "", /^@scope\/changed@0\.2\.3 is on npm/u);
    assert.match(result.lines[0] ?? "", /dist\/index\.js \(changed\), README\.md \(changed\)/u);
    assert.match(result.lines[0] ?? "", /From 2026-12-07, this check fails\.$/u);
  });

  it("gives an error and fails from the date", () => {
    const result = evaluate([changed], "2026-12-07", "2026-12-07");
    assert.equal(result.level, "error");
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(result.lines[0] ?? "", /this check fails/u);
  });

  it("shows at most 20 files of a package", () => {
    const many: Drift = { name: "many", version: "1.0.0", differences: Array.from({ length: 23 }, (_, i) => `f${i}.js (added)`) };
    const line = evaluate([many], "", "2026-11-09").lines[0] ?? "";
    assert.match(line, /f19\.js \(added\) and 3 more\./u);
    assert.doesNotMatch(line, /f20\.js/u);
  });
});

describe("drifts", () => {
  it("gives no package for a repository with only a private package.json", async () => {
    const repo = mkdtempSync(join(tmpdir(), "version-check-test-"));
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", private: true, version: "0.0.0" }));
      assert.deepEqual(await drifts(repo), []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
