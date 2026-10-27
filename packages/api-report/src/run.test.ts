// The globs of the workspace, the commands check and update, and the bin on fixture workspaces.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { globFolders, globToRegExp, packageFolders, readConfig, runCli, runReports, summaryMarkdown, workspaceGlobs, type CliIo } from "./index.ts";

const temp = mkdtempSync(join(tmpdir(), "api-report-run-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

function fixture(files: Record<string, unknown>): string {
  const root = join(temp, String(fixtures++));
  mkdirSync(root, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof text === "string" ? text : JSON.stringify(text, null, 2));
  }
  return root;
}

/** A workspace with a public package, a package with no types, a private package and an excluded package. */
const workspace = (rootManifest: Record<string, unknown> = {}): string =>
  fixture({
    "package.json": { name: "root", private: true, ...rootManifest },
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  # a comment\n  - "!packages/ignored"\n\nother: 1\n',
    "packages/a/package.json": { name: "a", types: "./index.d.ts" },
    "packages/a/index.d.ts": "export declare const a: 1;\n",
    "packages/b/package.json": { name: "b", exports: { "./x.css": "./x.css" } },
    "packages/hidden/package.json": { name: "hidden", private: true },
    "packages/ignored/package.json": { name: "ignored" },
  });

/** This function starts runCli in `cwd`, and gives the exit code and the output. */
function cli(cwd: string, args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const io: CliIo = { cwd, env, stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) };
  const code = runCli(args, io);
  return { code, stdout, stderr };
}

describe("the globs", () => {
  it("escapes the special characters, and knows *, ?, ** and braces", () => {
    expect(globToRegExp("packages/*").test("packages/a")).toBe(true);
    expect(globToRegExp("packages/*").test("packages/a/b")).toBe(false);
    expect(globToRegExp("packages/**").test("packages/a/b")).toBe(true);
    expect(globToRegExp("a/**/z").test("a/z")).toBe(true);
    expect(globToRegExp("a/**/z").test("a/b/c/z")).toBe(true);
    expect(globToRegExp("a.b/?").test("a.b/c")).toBe(true);
    expect(globToRegExp("a.b/?").test("axb/c")).toBe(false);
    expect(globToRegExp("{apps,libs}/*").test("libs/x")).toBe(true);
    expect(globToRegExp("(x)+[y]$").test("(x)+[y]$")).toBe(true);
    expect(() => globToRegExp("{a,b")).toThrow(/no "}"/);
  });

  it("finds the folders of a glob, without node_modules and dot folders", () => {
    const root = fixture({ "apps/x/y/f": "", "apps/x/node_modules/m/f": "", "apps/.cache/f": "", "libs/z/f": "" });
    expect(globFolders(root, "apps/*")).toEqual(["apps/x"]);
    expect(globFolders(root, "apps/**")).toEqual(["apps", "apps/x", "apps/x/y"]);
    expect(globFolders(root, "{apps,libs}/*")).toEqual(["apps/x", "libs/z"]);
    expect(globFolders(root, "./libs/z/")).toEqual(["libs/z"]);
    expect(globFolders(root, "none/*")).toEqual([]);
  });

  it("reads the globs of pnpm-workspace.yaml and of the workspaces field", () => {
    expect(workspaceGlobs(workspace())).toEqual(["packages/*", "!packages/ignored"]);
    expect(workspaceGlobs(fixture({ "pnpm-workspace.yaml": "packages: ['a/*', \"b\"]\n" }))).toEqual(["a/*", "b"]);
    expect(workspaceGlobs(fixture({ "package.json": { workspaces: ["x/*"] } }))).toEqual(["x/*"]);
    expect(workspaceGlobs(fixture({ "package.json": { workspaces: { packages: ["y/*"] } } }))).toEqual(["y/*"]);
    expect(workspaceGlobs(fixture({ "package.json": {} }))).toBeUndefined();
  });

  it("finds the package folders, and a repository with no workspace is one package", () => {
    const root = workspace();
    expect(packageFolders(root)).toEqual(["a", "b", "hidden"].map((name) => join(root, "packages", name)));
    expect(packageFolders(root, ["!packages/a", "packages/*"])).toEqual(["b", "hidden", "ignored"].map((name) => join(root, "packages", name)));
    const single = fixture({ "package.json": { name: "solo" } });
    expect(packageFolders(single)).toEqual([single]);
  });
});

describe("the configuration", () => {
  it("reads the field apiReport, and refuses a wrong value", () => {
    expect(readConfig(fixture({ "package.json": {} }))).toEqual({});
    expect(readConfig(fixture({ "package.json": { apiReport: { packages: ["libs/*"], report: "api.txt", includePrivate: true } } }))).toEqual({
      packages: ["libs/*"],
      report: "api.txt",
      includePrivate: true,
    });
    expect(() => readConfig(fixture({ "package.json": { apiReport: { packages: "libs/*" } } }))).toThrow(/array of globs/);
    expect(() => readConfig(fixture({ "package.json": { apiReport: { reports: "x" } } }))).toThrow(/unknown fields: reports/);
  });

  it("refuses a report path outside the package folder", () => {
    expect(() => runReports({ mode: "check", root: workspace(), report: "../x.txt" })).toThrow(/no "\.\."/);
  });
});

describe("check and update", () => {
  it("fails a check without reports, writes them with update, then passes", () => {
    const root = workspace();
    const first = cli(root, ["check"]);
    expect(first.code).toBe(1);
    expect(first.stdout).toContain("No report:\n  packages/a (packages/a/test/api/public-api.txt)\n  packages/b (packages/b/test/api/public-api.txt)\n");
    expect(existsSync(join(root, "packages/a/test/api/public-api.txt"))).toBe(false);
    const update = cli(root, ["update"]);
    expect(update.code, update.stdout + update.stderr).toBe(0);
    expect(update.stdout).toContain("Written (new):\n  packages/a/test/api/public-api.txt\n");
    expect(readFileSync(join(root, "packages/a/test/api/public-api.txt"), "utf8")).toContain("a: index.d.ts#a");
    expect(existsSync(join(root, "packages/hidden/test/api/public-api.txt"))).toBe(false);
    expect(cli(root, ["check"]).code).toBe(0);
  });

  it("shows the diff of a changed API, in the log and in the summary of the run", () => {
    const root = workspace();
    cli(root, ["update"]);
    writeFileSync(join(root, "packages/a/index.d.ts"), "export declare const a: 2;\n");
    const summary = join(root, "summary.md");
    const changed = cli(root, ["check", "packages/a"], { GITHUB_STEP_SUMMARY: summary });
    expect(changed.code).toBe(1);
    expect(changed.stdout).toContain("The report differs from the built .d.ts files:\n  packages/a/test/api/public-api.txt\n");
    expect(changed.stdout).toContain("--- a/packages/a/test/api/public-api.txt\n+++ b/packages/a/test/api/public-api.txt\n");
    expect(changed.stdout).toContain("-export declare const a: 1;\n+export declare const a: 2;\n");
    expect(changed.stdout).toContain("`api-report update`");
    expect(readFileSync(summary, "utf8")).toContain("```diff\n");
  });

  it("finds a report of a private package, and update removes it", () => {
    const root = workspace();
    cli(root, ["update"]);
    writeFileSync(join(root, "packages/a/package.json"), JSON.stringify({ name: "a", private: true, types: "./index.d.ts" }));
    const check = cli(root, ["check"]);
    expect(check.code).toBe(1);
    expect(check.stdout).toContain("A report of a private package:\n  packages/a/test/api/public-api.txt\n");
    expect(cli(root, ["update"]).code).toBe(0);
    expect(existsSync(join(root, "packages/a/test/api/public-api.txt"))).toBe(false);
  });

  it("uses the globs, the report path and the private packages of the configuration", () => {
    const root = workspace({ apiReport: { packages: ["packages/*"], report: "api/public.txt", includePrivate: true, tool: "pnpm check:api" } });
    expect(cli(root, ["update"]).code).toBe(0);
    expect(readFileSync(join(root, "packages/ignored/api/public.txt"), "utf8")).toContain("# The public API of ignored");
    expect(readFileSync(join(root, "packages/hidden/api/public.txt"), "utf8")).toContain("`pnpm check:api check`");
    expect(cli(root, ["update", "--packages", "packages/a", "--report", "other.txt"]).stdout).toContain("packages/a/other.txt");
  });

  it("reports an error of one package, and still writes the others", () => {
    const root = workspace();
    writeFileSync(join(root, "packages/a/index.d.ts"), "something unknown;\n");
    const result = runReports({ mode: "update", root });
    expect(result.failed).toBe(true);
    expect(result.packages.find((item) => item.folder === "packages/a")?.error).toMatch(/A statement that the report does not know/);
    expect(readFileSync(join(root, "packages/b/test/api/public-api.txt"), "utf8")).toContain("no type declarations");
    expect(summaryMarkdown(result)).toContain("A statement that the report does not know");
  });

  it("gives exit code 2 and the help for wrong arguments", () => {
    expect(cli(temp, []).code).toBe(2);
    expect(cli(temp, ["check", "--bad"]).stderr).toContain("An unknown option: --bad");
    expect(cli(temp, ["check", "--report"]).stderr).toContain("needs a value");
    expect(cli(temp, ["--help"]).stdout).toContain("Usage: api-report");
  });
});

describe("the bin", () => {
  it("runs from its source with Node", () => {
    const bin = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const root = workspace();
    const result = spawnSync(process.execPath, [bin, "update"], { cwd: root, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(spawnSync(process.execPath, [bin, "check"], { cwd: root, encoding: "utf8" }).status).toBe(0);
  });
});
