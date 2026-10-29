// The configuration, the output and the bin on fixture repositories.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig, RULES, runChecks, runCli, summaryMarkdown, type CliIo } from "./index.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-run-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

function fixture(files: Record<string, unknown>): string {
  const root = join(temp, String(fixtures++));
  mkdirSync(root, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof text === "string" ? text : `${JSON.stringify(text, null, 2)}\n`);
  }
  return root;
}

/** A workspace with one package that breaks the rule tsconfig-test. */
const broken = (conventions?: unknown): string =>
  fixture({
    "package.json": { name: "root", private: true, scripts: { "lint:ste": "ste-lint", typecheck: "pnpm -r typecheck" }, ...(conventions === undefined ? {} : { conventions }) },
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "packages/a/package.json": { name: "a", private: true, main: "./src/index.ts" },
    "packages/a/tsconfig.json": { extends: "@mark1russell7/cue/ts/config/node.json" },
  });

/** This function starts runCli in `cwd`, and gives the exit code and the output. */
function cli(cwd: string, args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const io: CliIo = { cwd, env, stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) };
  const code = runCli(args, io);
  return { code, stdout, stderr };
}

describe("the rules", () => {
  it("have unique ids, a reason, a fix and audit sources", () => {
    const ids = RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of RULES) {
      expect(rule.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(rule.reason.length).toBeGreaterThan(20);
      expect(rule.fix.length).toBeGreaterThan(10);
      // Each rule comes from a convention that 3 or more repositories tell
      expect(new Set(rule.sources.map((source) => source.repo)).size, rule.id).toBeGreaterThanOrEqual(rule.id === "no-build-output" || rule.sources.some((source) => source.doc.startsWith("docs/STRATEGY.md")) ? 1 : 3);
    }
  });
});

describe("the configuration", () => {
  it("gives the defaults when the field does not exist", () => {
    const config = parseConfig(undefined, RULES);
    expect(config.rules["source-main"]).toEqual({ ignore: [], options: { main: "src/index.ts", publishConfig: true } });
  });

  it("refuses an exception without a reason, an unknown rule, an unknown option and a wrong type", () => {
    expect(() => parseConfig({ rules: { "no-build-output": { off: "" } } }, RULES)).toThrow(/off must be the reason/);
    expect(() => parseConfig({ rules: { "no-build-output": false } }, RULES)).toThrow(/must be an object/);
    expect(() => parseConfig({ rules: { nope: { off: "x" } } }, RULES)).toThrow(/unknown rule: nope/);
    expect(() => parseConfig({ rules: { "cue-preset": { ignore: ["packages/web/**"] } } }, RULES)).toThrow(/needs a reason/);
    expect(() => parseConfig({ rules: { "cue-preset": { prefx: "x" } } }, RULES)).toThrow(/unknown field: prefx/);
    expect(() => parseConfig({ rules: { "required-scripts": { scripts: ["typecheck"] } } }, RULES)).toThrow(/changes the option scripts, and needs a reason/);
    expect(() => parseConfig({ rules: { "release-files": { paths: [], trailer: "X" } } }, RULES)).toThrow(/changes the options paths, trailer, and needs a reason/);
    expect(() => parseConfig({ rules: { "no-build-output": { folders: "dist" } } }, RULES)).toThrow(/must be an array of strings/);
    expect(() => parseConfig({ other: 1 }, RULES)).toThrow(/unknown fields: other/);
    expect(() => parseConfig([], RULES)).toThrow(/must be an object/);
  });

  it("accepts a changed option with a reason, or on a rule that is off", () => {
    const config = parseConfig({ rules: { "required-scripts": { scripts: ["typecheck", "test"], reason: "the tests are a gate" }, "no-build-output": { off: "git installs", folders: ["dist"] } } }, RULES);
    expect(config.rules["required-scripts"]).toEqual({ ignore: [], reason: "the tests are a gate", options: { scripts: ["typecheck", "test"], steScripts: ["lint:ste"] } });
    expect(config.rules["no-build-output"]?.off).toBe("git installs");
  });

  it("drops the breaks in the files of ignore, and counts them", () => {
    const root = broken({ rules: { "tsconfig-test": { ignore: ["packages/a/**"], reason: "a has no tests" } } });
    const result = runChecks({ root, only: ["tsconfig-test"] });
    expect(result.rules[0]).toMatchObject({ status: "pass", ignored: 1, note: "a has no tests" });
    expect(result.failed).toBe(false);
  });
});

describe("the bin", () => {
  it("fails with the file, the rule and the fix of each break", () => {
    const { code, stdout } = cli(broken(), ["check"]);
    expect(code).toBe(1);
    expect(stdout).toMatch(/BREAK {2}tsconfig-test: 1 break\(s\)/);
    expect(stdout).toContain("packages/a/tsconfig.test.json  The package has a tsconfig.json and no tsconfig.test.json.");
    expect(stdout).toMatch(/fix: Add `tsconfig.test.json`/);
    expect(stdout).toMatch(/pass {3}required-scripts/);
  });

  it("passes when the only break is in a rule that is off", () => {
    const { code, stdout } = cli(broken({ rules: { "tsconfig-test": { off: "a migration in progress" } } }), ["check"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/off +tsconfig-test \(a migration in progress\)/);
  });

  it("writes annotations and the summary in GitHub Actions", () => {
    const root = broken();
    const summary = join(root, "summary.md");
    const { stdout } = cli(root, ["check"], { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary });
    expect(stdout).toMatch(/^::error file=packages\/a\/tsconfig.test.json,title=conventions tsconfig-test::The package/m);
    const text = readFileSync(summary, "utf8");
    expect(text).toContain("### Conventions");
    expect(text).toContain("| `tsconfig-test` | 1 break(s) |  |");
    expect(text).toContain("- `packages/a/tsconfig.test.json`: The package has a tsconfig.json and no tsconfig.test.json.");
  });

  it("writes JSON, and starts only the rules of --rule", () => {
    const { code, stdout } = cli(broken(), ["check", "--json", "--rule", "required-scripts"]);
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { rules: { id: string; status: string }[] };
    expect(result.rules).toEqual([expect.objectContaining({ id: "required-scripts", status: "pass" })]);
  });

  it("lists each rule with its state, options and audit sources", () => {
    const { code, stdout } = cli(broken({ rules: { "no-build-output": { off: "a reason" } } }), ["--list"]);
    expect(code).toBe(0);
    for (const rule of RULES) expect(stdout).toContain(`${rule.id} (`);
    expect(stdout).toContain("no-build-output (off: a reason)");
    expect(stdout).toContain('option folders = ["dist","build"]');
    expect(stdout).toContain("from: coeval pinned-deps (CLAUDE.md:41)");
  });

  it("gives exit code 2 for wrong arguments and 1 for a wrong configuration", () => {
    expect(cli(broken(), []).code).toBe(2);
    expect(cli(broken(), ["check", "--root"]).code).toBe(2);
    expect(cli(broken(), ["check", "--nope"]).code).toBe(2);
    expect(cli(broken(), ["check", "--rule", "nope"])).toMatchObject({ code: 1, stderr: expect.stringMatching(/Unknown rule: nope/) as unknown });
    expect(cli(broken({ rules: { x: {} } }), ["check"]).code).toBe(1);
    expect(cli(broken(), ["--help"])).toMatchObject({ code: 0, stdout: expect.stringMatching(/^Usage: conventions check/) as unknown });
  });

  it("gives a summary table with each rule", () => {
    const text = summaryMarkdown(runChecks({ root: broken(), only: ["required-scripts", "source-main"] }));
    expect(text).toContain("| `source-main` | pass |  |");
    expect(text).toContain("| `required-scripts` | pass |  |");
  });
});
