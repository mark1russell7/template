// The globs of the workspace, the commands check and update, and the bin on fixture workspaces.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import * as home from "@mark1russell7/conventions/workspace";
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

describe("the functions of the workspace", () => {
  it("are the functions of @mark1russell7/conventions/workspace, not a copy", () => {
    expect(globFolders).toBe(home.globFolders);
    expect(globToRegExp).toBe(home.globToRegExp);
    expect(packageFolders).toBe(home.packageFolders);
    expect(workspaceGlobs).toBe(home.workspaceGlobs);
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
    expect(check.stdout).toContain("A report of a package that the command does not read:\n  packages/a/test/api/public-api.txt\n");
    expect(cli(root, ["update"]).code).toBe(0);
    expect(existsSync(join(root, "packages/a/test/api/public-api.txt"))).toBe(false);
  });

  it("passes a repository of private packages, in the two modes", () => {
    const root = fixture({
      "package.json": { name: "root", private: true },
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/hidden/package.json": { name: "hidden", private: true },
    });
    for (const mode of ["check", "update"]) {
      const result = cli(root, [mode]);
      expect(result.code, mode).toBe(0);
      expect(result.stdout).toContain("0 public packages with a report of the API, 1 private packages without a report.");
    }
  });

  it("passes a private package that is the whole repository", () => {
    expect(cli(fixture({ "package.json": { name: "one", private: true } }), ["check"]).code).toBe(0);
  });

  it("fails a run over no package folder at all", () => {
    const root = fixture({ "package.json": { name: "root", private: true }, "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n' });
    const result = cli(root, ["check"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Errors:\n  .: no package");
  });

  it("finds a report that the run does not read, and update removes it", () => {
    const root = workspace();
    expect(cli(root, ["update"]).code).toBe(0);
    const reports = ["hidden", "ignored", "removed"].map((folder) => join(root, "packages", folder, "test/api/public-api.txt"));
    for (const report of reports) {
      mkdirSync(dirname(report), { recursive: true });
      writeFileSync(report, "an old report\n");
    }
    const check = cli(root, ["check"]);
    expect(check.code).toBe(1);
    expect(check.stdout).toContain(
      "A report of a package that the command does not read:\n  packages/hidden/test/api/public-api.txt\n  packages/ignored/test/api/public-api.txt\n  packages/removed/test/api/public-api.txt\n",
    );
    for (const report of reports) expect(readFileSync(report, "utf8"), "check writes nothing").toBe("an old report\n");
    expect(cli(root, ["check", "packages/a"]).code, "a run of named folders examines only those folders").toBe(0);
    const update = cli(root, ["update"]);
    expect(update.code).toBe(0);
    expect(update.stdout).toContain("Removed (the command does not read the package):");
    for (const report of reports) expect(existsSync(report)).toBe(false);
    expect(cli(root, ["check"]).code).toBe(0);
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

  it("holds a page of the API against the report: a clean page passes, and a page that lost a name fails", () => {
    const root = workspace({ apiReport: { pages: [{ package: "packages/a", pages: ["api.md"] }] } });
    writeFileSync(join(root, "api.md"), "The constant `a`.\n");
    expect(cli(root, ["update"]).code).toBe(0);
    expect(cli(root, ["check"]).code).toBe(0);

    writeFileSync(join(root, "api.md"), "The constant a, with no code.\n");
    const failed = cli(root, ["check"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("The page of the API of packages/a differs from its report:");
    expect(failed.stdout).toContain("a: the package exports this name, and no code on the page shows it.");
    expect(summaryMarkdown(runReports({ mode: "check", root, pages: [{ package: "packages/a", pages: ["api.md"] }] }))).toContain("no code on the page shows it");
  });

  it("does not stop the command update for a page, because the report is the input of the check", () => {
    const root = workspace({ apiReport: { pages: [{ package: "packages/a", pages: ["api.md"] }] } });
    writeFileSync(join(root, "api.md"), "No code.\n");
    expect(cli(root, ["update"]).code).toBe(0);
    expect(cli(root, ["check"]).code).toBe(1);
  });

  it("fails on a page that does not exist, and on a page of a package that the command does not read", () => {
    const missing = workspace({ apiReport: { pages: [{ package: "packages/a", pages: ["gone.md"] }] } });
    cli(missing, ["update"]);
    const result = cli(missing, ["check"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("gone.md: the page does not exist.");

    const unread = workspace({ apiReport: { pages: [{ package: "packages/hidden", pages: ["api.md"] }] } });
    cli(unread, ["update"]);
    const other = cli(unread, ["check"]);
    expect(other.code).toBe(1);
    expect(other.stdout).toContain("the field pages names a package that the command does not read");
  });

  it("reads the exceptions of a page from the configuration, and refuses a wrong field", () => {
    const root = workspace({ apiReport: { pages: [{ package: "packages/a", pages: ["api.md"], except: { a: "Another page tells this name." } }] } });
    writeFileSync(join(root, "api.md"), "No code.\n");
    cli(root, ["update"]);
    expect(cli(root, ["check"]).code).toBe(0);
    expect(() => readConfig(workspace({ apiReport: { pages: "api.md" } }))).toThrow("apiReport.pages must be an array.");
    expect(() => readConfig(workspace({ apiReport: { pages: [{ package: "packages/a", pages: [] }] } }))).toThrow("must be an array of paths");
    expect(() => readConfig(workspace({ apiReport: { pages: [{ package: "packages/a", pages: ["a"], except: { a: 1 } }] } }))).toThrow("of names and reasons");
  });

  it("writes a page of each export with update, and fails on it when it differs from the report", () => {
    const pages = [{ package: "packages/a", pages: [], reference: "site/each-export.md" }];
    const root = workspace({ apiReport: { pages } });
    const first = cli(root, ["update"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Written (the page of each export):\n  site/each-export.md");
    const page = readFileSync(join(root, "site/each-export.md"), "utf8");
    expect(page).toContain('## `a`');
    expect(page).toContain("const a: 1;");
    expect(cli(root, ["check"]).code).toBe(0);
    expect(cli(root, ["update"]).stdout).not.toContain("each-export.md");

    writeFileSync(join(root, "site/each-export.md"), page.replace(/\n/g, "\r\n"));
    expect(cli(root, ["check"]).code).toBe(0);

    writeFileSync(join(root, "site/each-export.md"), `${page}A hand edit.\n`);
    const edited = cli(root, ["check"]);
    expect(edited.code).toBe(1);
    expect(edited.stdout).toContain("site/each-export.md: the page differs from the report.");

    cli(root, ["update"]);
    writeFileSync(join(root, "packages/a/index.d.ts"), "export declare const a: 1;\nexport declare const b: 2;\n");
    runReports({ mode: "update", root, pages: [] });
    const stale = cli(root, ["check"]);
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain("site/each-export.md: the page differs from the report.");

    rmSync(join(root, "site/each-export.md"));
    expect(cli(root, ["check"]).stdout).toContain("site/each-export.md: the page differs from the report.");
  });

  it("still holds the imports of a hand-written page next to a page of each export, and refuses a wrong path", () => {
    const pages = [{ package: "packages/a", pages: ["api.md"], reference: "each.md" }];
    const root = workspace({ apiReport: { pages } });
    writeFileSync(join(root, "api.md"), "Prose with no code.\n");
    cli(root, ["update"]);
    expect(cli(root, ["check"]).code).toBe(0);
    writeFileSync(join(root, "api.md"), '```ts\nimport { gone } from "a";\n```\n');
    const failed = cli(root, ["check"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("gone: the page imports this name from a, and that entry does not export it.");
    expect(() => readConfig(workspace({ apiReport: { pages: [{ package: "packages/a", pages: [], reference: "../out.md" }] } }))).toThrow("must be a path in the repository");
    expect(() => readConfig(workspace({ apiReport: { pages: [{ package: "packages/a", pages: [], reference: 1 }] } }))).toThrow("must be a path in the repository");
  });

  it("writes the fields of frontmatter into the page of each export, and holds them in the check", () => {
    const pages = [{ package: "packages/a", pages: [], reference: "each.mdx", frontmatter: { order: 42 } }];
    const root = workspace({ apiReport: { pages } });
    expect(cli(root, ["update"]).code).toBe(0);
    const page = readFileSync(join(root, "each.mdx"), "utf8");
    expect(page).toContain("declarations.\"\norder: 42\n---\n");
    expect(cli(root, ["check"]).code).toBe(0);
    writeFileSync(join(root, "each.mdx"), page.replace("order: 42", "order: 7"));
    expect(cli(root, ["check"]).stdout).toContain("each.mdx: the page differs from the report.");

    const read = (frontmatter: unknown, reference: unknown = "each.mdx") => () =>
      readConfig(workspace({ apiReport: { pages: [{ package: "packages/a", pages: [], reference, frontmatter }] } }));
    expect(read({ order: 42 })).not.toThrow();
    expect(read({ order: 42 }, null)).toThrow("must be a path in the repository");
    expect(() => readConfig(workspace({ apiReport: { pages: [{ package: "packages/a", pages: ["a.md"], frontmatter: { order: 1 } }] } }))).toThrow("frontmatter needs the field reference");
    expect(read([1])).toThrow("must be an object of fields");
    expect(read({ "a b": 1 })).toThrow("is not a plain name");
    expect(read({ order: null })).toThrow("must be a text, a number or a boolean");
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
