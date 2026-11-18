// Tests coverage.ts of the action coverage: the list of the packages with Vitest, the table and the floor.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { coverageTable, declaresProjects, vitestDirs, type Totals } from "./coverage/coverage.ts";

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
  const key = (dir: string): string => dir.replaceAll("\\", "/").replace(/^[A-Z]:/, "");
  const noProjects = (): boolean => false;

  it("gives the packages whose test script starts Vitest, with no root that only starts the packages", () => {
    assert.deepEqual(vitestDirs(list, "/r", (dir) => tests[key(dir)], noProjects), ["packages/a", "packages/c"]);
  });

  it("gives the root of a repository with one package", () => {
    assert.deepEqual(vitestDirs([{ path: "/r" }], "/r", () => "vitest run", noProjects), ["."]);
  });

  it("gives the root of a workspace when the root is a package with its own Vitest tests", () => {
    const own: Record<string, string> = { ...tests, "/r": "vitest run && pnpm --filter site run test" };
    assert.deepEqual(vitestDirs(list, "/r", (dir) => own[key(dir)], noProjects), [".", "packages/a", "packages/c"]);
  });

  it("does not give the root of a workspace when its Vitest config declares projects", () => {
    const own: Record<string, string> = { ...tests, "/r": "vitest run" };
    const projects = (dir: string): boolean => key(dir) === "/r";
    assert.deepEqual(vitestDirs(list, "/r", (dir) => own[key(dir)], projects), ["packages/a", "packages/c"]);
  });

  it("gives the root of a repository with one package, also with projects", () => {
    assert.deepEqual(vitestDirs([{ path: "/r" }], "/r", () => "vitest run", () => true), ["."]);
  });

  it("refuses a list that is not an array", () => {
    assert.throws(() => vitestDirs({}, "/r", () => undefined, noProjects), /not a JSON array/);
  });
});

describe("coverage: the projects of a root", () => {
  const folder = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "coverage-projects-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  };
  const cases: [string, Record<string, string>, boolean][] = [
    ["no config", {}, false],
    ["a config with no projects", { "vitest.config.ts": 'export default { test: { include: ["src/**/*.test.ts"] } };\n' }, false],
    ["a comment that names projects", { "vitest.config.ts": "// The tests run without projects.\nexport default {};\n" }, false],
    ["the key projects", { "vitest.config.ts": 'export default { test: { projects: [{ test: { name: "node" } }] } };\n' }, true],
    ["the key projects with a space before the colon", { "vitest.config.mts": "export default { test: { projects : [] } };\n" }, true],
    ["the key workspace of Vitest 3", { "vite.config.ts": 'export default { test: { workspace: ["packages/*"] } };\n' }, true],
    ["a workspace file of Vitest 3", { "vitest.workspace.ts": 'export default ["packages/*"];\n' }, true],
    ["projects only in vite.config, which Vitest does not read next to vitest.config", { "vitest.config.ts": "export default {};\n", "vite.config.ts": "export default { test: { projects: [] } };\n" }, false],
  ];
  for (const [name, files, expected] of cases) {
    it(`${expected ? "finds" : "does not find"} projects: ${name}`, () => {
      const dir = folder(files);
      try {
        assert.equal(declaresProjects(dir), expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
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
  it("reads the list of pnpm from a file, and refuses no file", () => {
    const root = mkdtempSync(join(tmpdir(), "coverage-"));
    try {
      mkdirSync(join(root, "packages", "a"), { recursive: true });
      mkdirSync(join(root, "packages", "b"), { recursive: true });
      writeFileSync(join(root, "packages", "a", "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
      writeFileSync(join(root, "packages", "b", "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
      const list = [root, join(root, "packages", "a"), join(root, "packages", "b")].map((path) => ({ path }));
      writeFileSync(join(root, "list.json"), JSON.stringify(list));
      const run = spawnSync(process.execPath, [script, "packages", "list.json"], { cwd: root, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, "packages/a\n");
      // A root with its own Vitest tests is a package of the list, until its config declares projects
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
      const own = spawnSync(process.execPath, [script, "packages", "list.json"], { cwd: root, encoding: "utf8" });
      assert.equal(own.stdout, ".\npackages/a\n", own.stderr);
      writeFileSync(join(root, "vitest.config.ts"), 'export default { test: { projects: ["packages/*"] } };\n');
      const projects = spawnSync(process.execPath, [script, "packages", "list.json"], { cwd: root, encoding: "utf8" });
      assert.equal(projects.stdout, "packages/a\n", projects.stderr);
      const none = spawnSync(process.execPath, [script, "packages"], { cwd: root, encoding: "utf8" });
      assert.notEqual(none.status, 0);
      assert.match(none.stderr, /needs the file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
