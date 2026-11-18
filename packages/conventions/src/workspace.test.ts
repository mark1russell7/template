// The package folders of a repository: the globs, the workspace, and a public root that the globs leave out.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { globFolders, globToRegExp, isWorkspaceFolder, packageFolders, parseWorkspaceGlobs, reportFolders, workspaceGlobs } from "./workspace-entry.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-workspace-"));
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

  it("adds a public root that the globs of the workspace leave out, once", () => {
    const open = workspace({ private: false });
    expect(reportFolders(open)).toEqual([open, ...["a", "b", "hidden"].map((name) => join(open, "packages", name))]);
    // A private root, explicit globs and a repository of one package get no root of their own
    const closed = workspace();
    expect(reportFolders(closed)).toEqual(packageFolders(closed));
    expect(reportFolders(open, ["packages/*"])).toEqual(packageFolders(open, ["packages/*"]));
    const single = fixture({ "package.json": { name: "solo" } });
    expect(reportFolders(single)).toEqual([single]);
    // A root that a glob of the workspace names is read one time
    const named = fixture({ "package.json": { name: "root" }, "pnpm-workspace.yaml": 'packages:\n  - "."\n  - "site"\n', "site/package.json": { name: "site", private: true } });
    expect(reportFolders(named).filter((folder) => resolve(folder) === resolve(named))).toHaveLength(1);
    expect(reportFolders(named)).toHaveLength(2);
  });
});

describe("the text of pnpm-workspace.yaml and the folder rule", () => {
  it("reads a block list, also at the column of the key, and a flow list on one or more lines", () => {
    expect(parseWorkspaceGlobs('packages:\n  # the libraries\n  - "packages/*"\n  - \'apps/**\' # the apps\n\ncatalog:\n  vitest: ^4.0.0\n')).toEqual(["packages/*", "apps/**"]);
    expect(parseWorkspaceGlobs("packages:\n- packages/*\n- '!**/fixtures/**'\nonlyBuiltDependencies: []\n")).toEqual(["packages/*", "!**/fixtures/**"]);
    expect(parseWorkspaceGlobs("packages: ['packages/*', site] # all\n")).toEqual(["packages/*", "site"]);
    expect(parseWorkspaceGlobs("packages: [\n  'packages/*', # the libraries\n  site,\n]\n")).toEqual(["packages/*", "site"]);
  });
  it("gives undefined with no key packages, and throws on a form that it does not read", () => {
    expect(parseWorkspaceGlobs("onlyBuiltDependencies:\n  - esbuild\n")).toBeUndefined();
    expect(() => parseWorkspaceGlobs("packages: packages/*\n")).toThrow(/not a list/);
    expect(() => parseWorkspaceGlobs("packages: [\n  a,\n")).toThrow(/no "]"/);
    expect(() => parseWorkspaceGlobs("packages: [a] b\n")).toThrow(/text after/);
    expect(() => parseWorkspaceGlobs("packages:\n  key: value\n")).toThrow(/not an item/);
  });
  it("takes a folder of a glob and not of a ! glob, the root of a glob '.', and no folder of the default ignore of pnpm", () => {
    expect(isWorkspaceFolder("packages/a", ["packages/*"])).toBe(true);
    expect(isWorkspaceFolder("packages/a/b", ["packages/*"])).toBe(false);
    expect(isWorkspaceFolder("packages/a/b", ["packages/**"])).toBe(true);
    expect(isWorkspaceFolder("packages/a", ["./packages/*/", "!packages/a"])).toBe(false);
    expect(isWorkspaceFolder(".", [".", "site"])).toBe(true);
    for (const folder of ["packages/a/test/fixture", "packages/tests/x", "packages/node_modules/x", "packages/bower_components/x", "packages/.cache"]) {
      expect(isWorkspaceFolder(folder, ["packages/**"]), folder).toBe(false);
    }
  });
  it("leaves the folders of the default ignore of pnpm out of the package folders", () => {
    const root = fixture({
      "package.json": { name: "root", private: true },
      "pnpm-workspace.yaml": "packages:\n  - packages/**\n",
      "packages/a/package.json": { name: "a" },
      "packages/a/test/fixture/package.json": { name: "fixture" },
    });
    expect(packageFolders(root).map((folder) => resolve(folder))).toEqual([resolve(root, "packages/a")]);
  });
});
