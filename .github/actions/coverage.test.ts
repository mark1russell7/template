// Tests coverage.ts of the action coverage: the list of the packages with Vitest, the table and the floor.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { coverageTable, vitestDirs, type Totals } from "./coverage/coverage.ts";

const script = join(import.meta.dirname, "coverage", "coverage.ts");

const totals = (statements: number, branches: number, functions: number, lines: number): Totals => ({
  statements: { total: 100, covered: statements, pct: statements },
  branches: { total: 100, covered: branches, pct: branches },
  functions: { total: 100, covered: functions, pct: functions },
  lines: { total: 100, covered: lines, pct: lines },
});

describe("coverage: the packages with Vitest", () => {
  const tests: Record<string, string> = { "/r": "pnpm -r test", "/r/packages/a": "vitest run", "/r/packages/b": "node --test", "/r/packages/c": "vitest run --project unit" };
  const list = Object.keys(tests).map((path) => ({ path }));

  it("gives the packages whose test script starts Vitest, with no root", () => {
    assert.deepEqual(vitestDirs(list, "/r", (dir) => tests[dir.replaceAll("\\", "/").replace(/^[A-Z]:/, "")]), ["packages/a", "packages/c"]);
  });

  it("gives the root of a repository with one package", () => {
    assert.deepEqual(vitestDirs([{ path: "/r" }], "/r", () => "vitest run"), ["."]);
  });

  it("refuses a list that is not an array", () => {
    assert.throws(() => vitestDirs({}, "/r", () => undefined), /not a JSON array/);
  });
});

describe("coverage: the table and the floor", () => {
  it("passes each package with no floor", () => {
    const { markdown, failures } = coverageTable([{ dir: "packages/a", totals: totals(50, 40, 30, 20) }], 0);
    assert.deepEqual(failures, []);
    assert.match(markdown, /### Coverage \(no floor\)/);
    assert.match(markdown, /\| packages\/a \| 50\.00 % \(50\/100\) \| 40\.00 % \(40\/100\) \| 30\.00 % \(30\/100\) \| 20\.00 % \(20\/100\) \| pass \|/);
  });

  // The flip: the same totals pass at the floor 80 and fail at 81, and the failure names the package and the measure.
  it("fails a package with a measure under the floor, and names it", () => {
    const rows = [{ dir: "packages/a", totals: totals(90, 80, 95, 90) }];
    assert.deepEqual(coverageTable(rows, 80).failures, []);
    const { markdown, failures } = coverageTable(rows, 81);
    assert.deepEqual(failures, ["packages/a: branches 80.00 % is under the floor 81 %"]);
    assert.match(markdown, /under the floor: branches \|/);
  });

  it("fails a package with no summary, also with no floor", () => {
    const { failures } = coverageTable([{ dir: "packages/b", totals: undefined }], 0);
    assert.equal(failures.length, 1);
    assert.match(failures[0] ?? "", /^packages\/b: no coverage summary/);
  });

  it("counts a measure with nothing to cover as 100 %", () => {
    const t = { ...totals(90, 90, 90, 90), branches: { total: 0, covered: 0, pct: "Unknown" as const } };
    assert.deepEqual(coverageTable([{ dir: "a", totals: t }], 90).failures, []);
  });
});

describe("coverage: the script", () => {
  it("reads the summaries of the folders, and exits with 1 under the floor", () => {
    const root = mkdtempSync(join(tmpdir(), "coverage-"));
    try {
      mkdirSync(join(root, "a", "coverage"), { recursive: true });
      writeFileSync(join(root, "a", "coverage", "coverage-summary.json"), JSON.stringify({ total: totals(70, 70, 70, 70) }));
      const run = (floor: string) => spawnSync(process.execPath, [script, "summary", floor, "a", "missing"], { cwd: root, encoding: "utf8" });
      const low = run("0");
      assert.equal(low.status, 1, low.stderr);
      assert.match(low.stdout, /\| a \| 70\.00 %/);
      assert.match(low.stderr, /::error::missing: no coverage summary/);
      const bad = run("x");
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /not a percent/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
