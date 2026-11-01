// conventions fix on fixture repositories: each fix that a rule declares, an edit that is stale, and the bin.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { replaceLine, runChecks, runCli, runFix, scheduleMinute, type CliIo, type Rule } from "./index.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-fix-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

/** This function writes the files of a fixture repository, commits them, and gives its root. */
function repo(files: Record<string, unknown>): string {
  const root = join(temp, String(fixtures++));
  mkdirSync(root, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof text === "string" ? text : `${JSON.stringify(text, null, 2)}\n`);
  }
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "first"]]) {
    const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return root;
}

const read = (root: string, file: string): string => readFileSync(join(root, file), "utf8");
const env = { GITHUB_REPOSITORY: "o/one" };

describe("replaceLine", () => {
  it("replaces, adds and removes lines, and keeps the line ends", () => {
    expect(replaceLine("a\nb\nc\n", 2, ["x", "y"])).toBe("a\nx\ny\nc\n");
    expect(replaceLine("a\r\nb\r\n", 1, [])).toBe("b\r\n");
  });
});

describe("conventions fix", () => {
  it("writes the minute of each schedule, a max-parallel, and a concurrency group, and keeps the comments", () => {
    const minute = scheduleMinute("o/one", ".github/workflows/scan.yml");
    const other = minute === 59 ? 1 : minute + 1;
    const scan = [
      "on:",
      "  schedule:",
      `    - cron: "${String(other)} 5 * * 1" # weekly`,
      `    - cron: "${String(other)} 9 * * 3"`,
      "jobs:",
      "  a:",
      "    strategy: # the cells",
      "      matrix:",
      "        node: [24, 26]",
      "    runs-on: ubuntu-latest",
      "  b:",
      "    strategy:",
      "      max-parallel: 8",
      "      matrix:",
      "        os: [linux, mac]",
      "    runs-on: ubuntu-latest",
      "",
    ];
    const root = repo({ "package.json": { name: "one" }, ".github/workflows/scan.yml": scan.join("\r\n") });
    const fixed = runFix({ root, only: ["runner-budget"], env });
    expect(fixed.result.failed).toBe(false);
    expect(fixed.changed).toEqual([".github/workflows/scan.yml"]);
    expect(read(root, ".github/workflows/scan.yml").split("\r\n")).toEqual([
      "on:",
      "  schedule:",
      `    - cron: "${String(minute)} 5 * * 1" # weekly`,
      `    - cron: "${String(minute)} 9 * * 3"`,
      "concurrency:",
      "  group: ${{ github.workflow }}-${{ github.ref }}",
      "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
      "",
      "jobs:",
      "  a:",
      "    strategy: # the cells",
      "      max-parallel: 3",
      "      matrix:",
      "        node: [24, 26]",
      "    runs-on: ubuntu-latest",
      "  b:",
      "    strategy:",
      "      max-parallel: 3",
      "      matrix:",
      "        os: [linux, mac]",
      "    runs-on: ubuntu-latest",
      "",
    ]);
    // One edit of each file in each check: 5 edits and a last check that finds none
    expect(fixed.passes).toBe(6);
  });

  it("removes passWithNoTests where the package has tests, and leaves it where the package has none", () => {
    const root = repo({
      "package.json": { name: "root", private: true },
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/a/package.json": { name: "a", scripts: { test: "vitest run --passWithNoTests --reporter dot" } },
      "packages/a/vitest.config.ts": "export default {\n  test: {\n    passWithNoTests: true,\n    include: [\"src/**/*.test.ts\"],\n  },\n};\n",
      "packages/a/src/a.test.ts": "export {};\n",
      "packages/b/package.json": { name: "b" },
      "packages/b/vitest.config.ts": "export default { test: { passWithNoTests: true, globals: true } };\n",
      "packages/b/src/b.test.ts": "export {};\n",
      "packages/c/package.json": { name: "c" },
      "packages/c/vitest.config.ts": "export default { test: { passWithNoTests: true } };\n",
    });
    const fixed = runFix({ root, only: ["tests-required"] });
    expect(read(root, "packages/a/vitest.config.ts")).toBe('export default {\n  test: {\n    include: ["src/**/*.test.ts"],\n  },\n};\n');
    expect(JSON.parse(read(root, "packages/a/package.json")).scripts.test).toBe("vitest run --reporter dot");
    expect(read(root, "packages/b/vitest.config.ts")).toBe("export default { test: { globals: true } };\n");
    expect(read(root, "packages/c/vitest.config.ts")).toBe("export default { test: { passWithNoTests: true } };\n");
    expect(fixed.result.rules[0]?.breaks.map((item) => item.file)).toEqual(["packages/c/vitest.config.ts"]);
  });

  it("adds the config files of a package to its tsconfig.test.json, and not to a tsconfig with comments", () => {
    const tsconfig = { compilerOptions: { noEmit: true, allowImportingTsExtensions: true, module: "nodenext", rootDir: "src" }, include: ["src"] };
    const root = repo({
      "package.json": { name: "root", private: true },
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/a/package.json": { name: "a", scripts: { typecheck: "tsc -p tsconfig.test.json" } },
      "packages/a/tsconfig.test.json": tsconfig,
      "packages/a/src/a.ts": "export const a = 1;\n",
      "packages/a/vitest.config.ts": "export default {};\n",
      "packages/b/package.json": { name: "b", scripts: { typecheck: "tsc -p tsconfig.test.json" } },
      "packages/b/tsconfig.test.json": `// the tests\n${JSON.stringify(tsconfig, null, 2)}\n`,
      "packages/b/src/b.ts": "export const b = 1;\n",
      "packages/b/vitest.config.ts": "export default {};\n",
    });
    const fixed = runFix({ root, only: ["typed-files"] });
    expect(JSON.parse(read(root, "packages/a/tsconfig.test.json"))).toEqual({ compilerOptions: { ...tsconfig.compilerOptions, rootDir: "." }, include: ["src", "*.config.ts"] });
    expect(fixed.changed).toEqual(["packages/a/tsconfig.test.json"]);
    expect(fixed.result.rules[0]?.breaks.map((item) => item.file)).toEqual(["packages/b/vitest.config.ts"]);
  });

  it("adds only the include in the style of the tsconfig, and keeps a rootDir that is its folder", () => {
    const lines = [
      "{",
      '  "extends": "./tsconfig.json",',
      '  "compilerOptions": { "noEmit": true, "rootDir": "${configDir}" },',
      '  "include": ["${configDir}/src/**/*", "${configDir}/test/**/*"],',
      '  "exclude": ["${configDir}/dist"]',
      "}",
      "",
    ];
    const root = repo({
      "package.json": { name: "one", scripts: { typecheck: "tsc -p tsconfig.test.json" } },
      "tsconfig.json": { compilerOptions: { noEmit: true, allowImportingTsExtensions: true, module: "nodenext" } },
      "tsconfig.test.json": lines.join("\n"),
      "src/a.ts": "export const a = 1;\n",
      "vitest.config.ts": "export default {};\n",
    });
    const fixed = runFix({ root, only: ["typed-files"] });
    lines[3] = '  "include": ["${configDir}/src/**/*", "${configDir}/test/**/*", "${configDir}/*.config.ts"],';
    expect(read(root, "tsconfig.test.json")).toBe(lines.join("\n"));
    expect(fixed.result.failed).toBe(false);
  });

  it("adds the include on its own line in a list of lines", () => {
    const text = '{\r\n  "include": [\r\n    "src"\r\n  ]\r\n}\r\n';
    const root = repo({
      "package.json": { name: "one", scripts: { typecheck: "tsc -p tsconfig.test.json" } },
      "tsconfig.test.json": text,
      "src/a.ts": "export const a = 1;\n",
      "vitest.config.ts": "export default {};\n",
    });
    runFix({ root, only: ["typed-files"] });
    expect(read(root, "tsconfig.test.json")).toBe('{\r\n  "include": [\r\n    "src",\r\n    "*.config.ts"\r\n  ]\r\n}\r\n');
  });

  it("does not write an edit when the file changed after the check", () => {
    const root = repo({ "package.json": { name: "one" }, "a.txt": "old\n" });
    const stale: Rule = {
      id: "stale",
      title: "t",
      reason: "r",
      fix: "f",
      sources: [],
      options: {},
      check: () => (read(root, "a.txt") === "new\n" ? [] : [{ file: "a.txt", message: "m", edits: [{ file: "a.txt", before: "other\n", after: "new\n" }] }]),
    };
    const fixed = runFix({ root, rules: [stale] });
    expect(read(root, "a.txt")).toBe("old\n");
    expect(fixed).toMatchObject({ changed: [], passes: 1, result: { failed: true } });
    expect(runChecks({ root, rules: [stale] }).failed).toBe(true);
  });

  it("is a command of the bin, and its JSON has fixable and not the texts of the edits", () => {
    const root = repo({ "package.json": { name: "one" }, ".github/workflows/a.yml": "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n" });
    let stdout = "";
    const io: CliIo = { cwd: root, env, stdout: (text) => (stdout += text), stderr: () => undefined };
    expect(runCli(["check", "--rule", "runner-budget", "--json"], io)).toBe(1);
    const checked = JSON.parse(stdout) as { rules: { breaks: Record<string, unknown>[] }[] };
    expect(checked.rules[0]?.breaks[0]).toMatchObject({ fixable: true });
    expect(checked.rules[0]?.breaks[0]).not.toHaveProperty("edits");
    stdout = "";
    expect(runCli(["fix", "--rule", "runner-budget"], io)).toBe(0);
    expect(stdout).toContain("conventions fix: changed 1 file(s) in 2 check(s):\n  .github/workflows/a.yml\n");
    stdout = "";
    expect(runCli(["fix", "--rule", "runner-budget"], io)).toBe(0);
    expect(stdout).toContain("conventions fix: no break has a fix that applies.");
  });
});
