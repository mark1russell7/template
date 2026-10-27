// The reader of the declaration files, the entries of a package.json and the text of a report.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { apiReport, binsOf, entriesOf, HEADER_LINES, packageReport, parseDeclarations, publishedManifest, statementsOf, targetOf } from "./index.ts";

const temp = mkdtempSync(join(tmpdir(), "api-report-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

/** This function writes a fixture folder, and gives its path. */
function fixture(files: Record<string, unknown>): string {
  const root = join(temp, String(fixtures++));
  mkdirSync(root, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof text === "string" ? text : JSON.stringify(text, null, 2));
  }
  return root;
}

/** The report of a fixture package, without its header. */
function body(files: Record<string, unknown>): string {
  return packageReport(fixture(files)).split("\n").slice(HEADER_LINES).join("\n");
}

describe("the statements of a declaration file", () => {
  it("splits the statements, and drops the comments and the blank lines", () => {
    const source = [
      "/** The doc. */\r",
      'export declare const a: "x;y" | `${string};${number}`; // a comment',
      "export interface B {\r",
      "    /** A member. */",
      "    c: { d: string };",
      "",
      "}",
      'export { e as f } from "./g.js";',
      "export declare class H<T = {}> extends I<{ j: () => void }> {",
      "    k: T;",
      "}",
      "export type L = (m: number) => { n: 1 };",
      "//# sourceMappingURL=x.d.ts.map",
    ].join("\n");
    expect(statementsOf(source)).toEqual([
      'export declare const a: "x;y" | `${string};${number}`;',
      "export interface B {\n    c: { d: string };\n}",
      'export { e as f } from "./g.js";',
      "export declare class H<T = {}> extends I<{ j: () => void }> {\n    k: T;\n}",
      "export type L = (m: number) => { n: 1 };",
    ]);
  });

  it("drops the #! line of the declarations of a bin file", () => {
    expect(statementsOf('#!/usr/bin/env node\nimport type { A } from "a";\nexport declare const b: A;\n')).toEqual(['import type { A } from "a";', "export declare const b: A;"]);
  });

  it("keeps a declare module block and a namespace block as one statement each", () => {
    const source = ['declare module "./x.js" {', "    interface A { b: 1; }", "}", "export declare namespace N {", "    const c: 1;", "}"].join("\n");
    expect(statementsOf(source)).toEqual(['declare module "./x.js" {\n    interface A { b: 1; }\n}', "export declare namespace N {\n    const c: 1;\n}"]);
  });
});

describe("the kinds of the statements", () => {
  it("knows export =, import = require and export default", () => {
    const info = parseDeclarations(['declare function f(): void;', "export = f;", 'import g = require("./g.js");', "declare const _default: number;", "export default _default;"].join("\n"));
    expect(info.exported.get("export=")).toEqual({ local: "f", typeOnly: false });
    expect(info.imports.get("g")).toEqual({ from: "./g.js", imported: "export=", typeOnly: false });
    expect(info.exported.get("default")).toEqual({ local: "_default", typeOnly: false });
  });

  it("knows a default function or class without a name", () => {
    expect(parseDeclarations("export default function (a: string): void;").locals.get("default")).toHaveLength(1);
    expect(parseDeclarations("export default class extends A {\n    b: 1;\n}").exported.get("default")?.local).toBe("default");
    expect(parseDeclarations("export default class C {\n}").exported.get("default")?.local).toBe("C");
  });

  it("gives each name of a declaration with two declarators", () => {
    const info = parseDeclarations("export declare const a: Map<string, number>, b: (c: 1, d: 2) => void;");
    expect([...info.exported.keys()]).toEqual(["a", "b"]);
  });

  it("reads the bundled form of tsdown: local declarations and one export list", () => {
    const info = parseDeclarations(["//#region src/index.d.ts", "declare function a(): void;", "interface B {\n  c: 1;\n}", "//#endregion", "export { type B, a };"].join("\n"));
    expect([...info.exported]).toEqual([
      ["B", { local: "B", typeOnly: true }],
      ["a", { local: "a", typeOnly: false }],
    ]);
    expect(parseDeclarations("export {};").exported.size).toBe(0);
  });

  it("keeps the ambient declarations by label", () => {
    const info = parseDeclarations(['declare module "./x.js" {\n    interface A {\n    }\n}', "declare global {\n    var g: 1;\n}", "export as namespace Lib;"].join("\n"));
    expect([...info.ambient.keys()]).toEqual(['declare module "./x.js"', "declare global", "export as namespace Lib"]);
  });

  it("collects the module specifiers, also of import types", () => {
    const info = parseDeclarations(['import { a } from "./a.js";', 'export * from "./b.js";', 'export declare const c: import("./c.js").C;'].join("\n"));
    expect([...info.references].sort()).toEqual(["./a.js", "./b.js", "./c.js"]);
  });

  it("throws at an unknown form of statement", () => {
    expect(() => parseDeclarations("something else;", "x.d.ts")).toThrow(/A statement that the report does not know, in x\.d\.ts/);
  });
});

describe("the entries of a package.json", () => {
  it("reads the string form, the nested conditions and an array", () => {
    expect(targetOf("./a.js")).toBe("./a.js");
    expect(targetOf({ import: { types: "./a.d.mts", default: "./a.mjs" }, require: { types: "./a.d.cts" } })).toBe("./a.d.mts");
    expect(targetOf({ browser: "./b.js", default: "./a.js" })).toBe("./a.js");
    expect(targetOf([{ worker: "./w.js" }, "./a.js"])).toBe("./a.js");
    expect(targetOf(null)).toBe(null);
  });

  it("skips ./package.json and an excluded subpath, and infers the declaration of a JavaScript target", () => {
    const root = fixture({ "dist/a.d.ts": "export {};\n", "dist/a.js": "", "dist/b.js": "", "dist/c.css": "" });
    const manifest = {
      exports: { ".": { import: "./dist/a.js" }, "./b": "./dist/b.js", "./c.css": "./dist/c.css", "./internal": null, "./package.json": "./package.json" },
    };
    expect(entriesOf(manifest, root)).toEqual([
      { subpath: ".", types: "./dist/a.d.ts" },
      { subpath: "./b", note: "no declaration file for ./dist/b.js", files: [{ subpath: "./b", path: "./dist/b.js" }] },
      { subpath: "./c.css", note: "no declaration file for ./dist/c.css", files: [{ subpath: "./c.css", path: "./dist/c.css" }] },
    ]);
    expect(entriesOf({ exports: "./dist/a.js" }, root)).toEqual([{ subpath: ".", types: "./dist/a.d.ts" }]);
    expect(entriesOf({ exports: { import: "./dist/a.js" } }, root)).toEqual([{ subpath: ".", types: "./dist/a.d.ts" }]);
  });

  it("expands a subpath pattern into the declaration files that it matches", () => {
    const root = fixture({ "dist/x.d.ts": "", "dist/y/z.d.ts": "", "dist/secret.d.ts": "", "dist/x.js": "" });
    const manifest = { exports: { "./*": { types: "./dist/*.d.ts", import: "./dist/*.js" }, "./secret": null, "./none/*": "./lib/*.js" } };
    expect(entriesOf(manifest, root)).toEqual([
      { subpath: "./x", types: "./dist/x.d.ts" },
      { subpath: "./y/z", types: "./dist/y/z.d.ts" },
      { subpath: "./none/*", note: "no file matches ./lib/*.d.ts" },
    ]);
  });

  it("lists the files of a subpath pattern that are not declarations", () => {
    const root = fixture({ "tsconfig/node.json": "{}", "tsconfig/base.json": "{}", "tsconfig/sub/web.json": "{}", "tsconfig/readme.md": "", "tsconfig/secret.json": "{}" });
    const manifest = { exports: { "./tsconfig/*.json": "./tsconfig/*.json", "./tsconfig/secret.json": null, "./css/*": "./css/*.css" } };
    expect(entriesOf(manifest, root)).toEqual([
      {
        subpath: "./tsconfig/*.json",
        note: "no declaration pattern for ./tsconfig/*.json",
        files: [
          { subpath: "./tsconfig/base.json", path: "./tsconfig/base.json" },
          { subpath: "./tsconfig/node.json", path: "./tsconfig/node.json" },
          { subpath: "./tsconfig/sub/web.json", path: "./tsconfig/sub/web.json" },
        ],
      },
      { subpath: "./css/*", note: "no file matches ./css/*.css" },
    ]);
  });

  it("reads types, typings and main without an exports field", () => {
    const root = fixture({ "lib/main.d.ts": "", "index.d.ts": "" });
    expect(entriesOf({ types: "./t.d.ts" }, root)).toEqual([{ subpath: ".", types: "./t.d.ts" }]);
    expect(entriesOf({ typings: "./t.d.ts" }, root)).toEqual([{ subpath: ".", types: "./t.d.ts" }]);
    expect(entriesOf({ main: "./lib/main.js" }, root)).toEqual([{ subpath: ".", types: "./lib/main.d.ts" }]);
    expect(entriesOf({}, root)).toEqual([{ subpath: ".", types: "./index.d.ts" }]);
    expect(entriesOf({ main: "./x.js" }, fixture({}))).toEqual([{ subpath: ".", note: "no declaration file for main ./x.js" }]);
    expect(entriesOf({}, fixture({}))).toEqual([]);
  });

  it("reads the fields of publishConfig as pnpm publishes them", () => {
    const source = { name: "p", main: "./src/index.ts", bin: { p: "./src/cli.ts" }, publishConfig: { access: "public", main: "./build/index.js", bin: { p: "./build/cli.js" } } };
    expect(publishedManifest(source)).toMatchObject({ main: "./build/index.js", bin: { p: "./build/cli.js" } });
    expect(publishedManifest(source)).not.toHaveProperty("access");
    expect(publishedManifest({ main: "./a.js" })).toEqual({ main: "./a.js" });
  });

  it("gives the bins in name order, and the name of the package for a string bin", () => {
    expect(binsOf({ name: "@s/tool", bin: "./cli.js" })).toEqual([{ name: "tool", path: "./cli.js" }]);
    expect(binsOf({ bin: { z: "./z.js", a: "./a.js" } })).toEqual([
      { name: "a", path: "./a.js" },
      { name: "z", path: "./z.js" },
    ]);
    expect(binsOf({})).toEqual([]);
  });
});

describe("the report of a package", () => {
  it("lists the names of each entry, then each declaration, in the order of the code units", () => {
    const report = body({
      "package.json": { name: "p", exports: { ".": { types: "./dist/index.d.ts" }, "./b": { types: "./dist/b.d.ts" } } },
      "dist/index.d.ts": ['export { b as renamed, type B } from "./b.js";', 'export * from "./c.js";', "export declare function Zeta(): void;", "export declare function alpha(): void;"].join("\n"),
      "dist/b.d.ts": "/** Doc. */\nexport declare const b: 1;\nexport interface B {\n    x: 1;\n}\n",
      "dist/c.d.ts": "export type C = 2;\nexport default C;\n",
    });
    expect(report).toBe(
      [
        "",
        "## . (dist/index.d.ts): 5 names",
        "",
        "type B: dist/b.d.ts#B",
        "C: dist/c.d.ts#C",
        "Zeta: dist/index.d.ts#Zeta",
        "alpha: dist/index.d.ts#alpha",
        "renamed: dist/b.d.ts#b",
        "",
        "## ./b (dist/b.d.ts): 2 names",
        "",
        "B: dist/b.d.ts#B",
        "b: dist/b.d.ts#b",
        "",
        "## Declarations",
        "",
        "### dist/b.d.ts#B",
        "export interface B {\n    x: 1;\n}",
        "",
        "### dist/b.d.ts#b",
        "export declare const b: 1;",
        "",
        "### dist/c.d.ts#C",
        "export type C = 2;",
        "",
        "### dist/index.d.ts#Zeta",
        "export declare function Zeta(): void;",
        "",
        "### dist/index.d.ts#alpha",
        "export declare function alpha(): void;",
        "",
      ].join("\n"),
    );
  });

  it("joins the overloads of a function and drops the private members of a class", () => {
    const report = body({
      "package.json": { name: "p", types: "./index.d.ts" },
      "index.d.ts": [
        "export declare function f(a: string): string;",
        "export declare function f(a: number): number;",
        "export declare class K {",
        "    #private;",
        "    private secret;",
        "    private static readonly other;",
        "    protected kept: 1;",
        "    get value(): 1;",
        "}",
      ].join("\n"),
    });
    expect(report).toMatch(/### index\.d\.ts#f\nexport declare function f\(a: string\): string;\nexport declare function f\(a: number\): number;\n/);
    expect(report).toMatch(/### index\.d\.ts#K\nexport declare class K \{\n {4}protected kept: 1;\n {4}get value\(\): 1;\n\}\n/);
  });

  it("knows enums, namespaces, export = and export default", () => {
    const report = body({
      "package.json": { name: "p", exports: { ".": "./index.js", "./cjs": "./cjs.js", "./def": "./def.js" } },
      "index.d.ts": ["export declare enum E {\n    A = 0\n}", "export declare const enum F {\n    B = 1\n}", "export declare namespace N {\n    const c: 1;\n}"].join("\n"),
      "cjs.d.ts": "declare function run(): void;\ndeclare namespace run {\n    const version: string;\n}\nexport = run;\n",
      "def.d.ts": "declare const _default: { a: 1 };\nexport default _default;\n",
    });
    expect(report).toMatch(/## \. \(index\.d\.ts\): 3 names\n\nE: index\.d\.ts#E\nF: index\.d\.ts#F\nN: index\.d\.ts#N\n/);
    expect(report).toMatch(/## \.\/cjs \(cjs\.d\.ts\): 1 names\n\nexport=: cjs\.d\.ts#run\n/);
    expect(report).toMatch(/### cjs\.d\.ts#run\ndeclare function run\(\): void;\ndeclare namespace run \{\n {4}const version: string;\n\}\n/);
    expect(report).toMatch(/default: def\.d\.ts#_default\n/);
  });

  it("lists the names of a namespace export and the names of other packages", () => {
    const report = body({
      "package.json": { name: "p", types: "./index.d.ts" },
      "index.d.ts": ['export * as ns from "./ns.js";', 'export * from "other-package";', 'import type { Ext } from "@scope/pkg/sub";', "export { Ext };", 'import * as all from "./ns.js";', "export { all };"].join("\n"),
      "ns.d.ts": "export declare const one: 1;\nexport type Two = 2;\n",
    });
    expect(report).toContain(
      [
        '* from "other-package": other-package#* (external)',
        "type Ext: @scope/pkg/sub#Ext (external)",
        "all: ns.d.ts#* (namespace)",
        "all.Two: ns.d.ts#Two",
        "all.one: ns.d.ts#one",
        "ns: ns.d.ts#* (namespace)",
        "ns.Two: ns.d.ts#Two",
        "ns.one: ns.d.ts#one",
      ].join("\n"),
    );
  });

  it("gives each name of export type * and export type * as as a type", () => {
    const report = body({
      "package.json": { name: "p", types: "./index.d.ts" },
      "index.d.ts": ['export type * from "./ir.js";', 'export type * as shapes from "./ir.js";', 'export type * from "other-package";'].join("\n"),
      "ir.d.ts": "export declare const node: 1;\nexport type Edge = 2;\n",
    });
    expect(report).toContain('type * from "other-package": other-package#* (external)\ntype Edge: ir.d.ts#Edge\ntype node: ir.d.ts#node\ntype shapes: ir.d.ts#* (namespace)');
  });

  it("lists the ambient declarations of each file that an entry reaches", () => {
    const report = body({
      "package.json": { name: "p", types: "./index.d.ts" },
      "index.d.ts": 'export type { A } from "./a.js";\nexport declare const b: import("./b.js").B;\n',
      "a.d.ts": 'export interface A {\n}\ndeclare module "./a.js" {\n    interface A {\n        added: 1;\n    }\n}\n',
      "b.d.ts": "export type B = 1;\ndeclare global {\n    var g: 1;\n}\n",
    });
    expect(report).toContain('ambient: a.d.ts#declare module "./a.js"\nambient: b.d.ts#declare global\n');
    expect(report).toContain("### b.d.ts#declare global\ndeclare global {\n    var g: 1;\n}");
  });

  it("resolves a # name of the imports field", () => {
    const report = body({
      "package.json": { name: "p", types: "./index.d.ts", imports: { "#lib/*": "./lib/*.js" } },
      "index.d.ts": 'export { x } from "#lib/x";\n',
      "lib/x.d.ts": "export declare const x: 1;\n",
    });
    expect(report).toContain("x: lib/x.d.ts#x\n");
  });

  it("reads the built entries and the bins of a source package of the template", () => {
    const report = body({
      "package.json": {
        name: "@s/tool",
        main: "./src/index.ts",
        bin: { tool: "./src/cli.ts" },
        publishConfig: { exports: { ".": { types: "./build/index.d.ts", import: "./build/index.js" }, "./package.json": "./package.json" }, bin: { tool: "./build/cli.js" } },
      },
      "build/index.d.ts": "declare function run(): void;\nexport { run };\n",
    });
    expect(report).toContain("## . (build/index.d.ts): 1 names\n\nrun: build/index.d.ts#run\n\n## bin: 1 commands\n\ntool: ./build/cli.js\n");
  });

  it("says when a package has no type declarations, and names the entries without one", () => {
    const report = packageReport(fixture({ "package.json": { name: "p", exports: { "./style.css": "./style.css" } } }));
    expect(report).toMatch(/^# The public API of p\n/);
    expect(report).toContain("This package has no type declarations");
    expect(report).toMatch(/## \.\/style\.css: no declaration file for \.\/style\.css\n$/);
  });

  it("lists each file of an entry without declarations, so a removed file changes the report", () => {
    const files = { "package.json": { name: "p", exports: { "./tsconfig/*.json": "./tsconfig/*.json", "./package.json": "./package.json" } }, "tsconfig/b.json": "{}", "tsconfig/a.json": "{}" };
    const report = packageReport(fixture(files));
    expect(report).toContain("## ./tsconfig/*.json: no declaration pattern for ./tsconfig/*.json\n\nfile ./tsconfig/a.json: tsconfig/a.json\nfile ./tsconfig/b.json: tsconfig/b.json\n");
    const fewer = packageReport(fixture(Object.fromEntries(Object.entries(files).filter(([file]) => file !== "tsconfig/b.json"))));
    expect(fewer).not.toContain("tsconfig/b.json");
    expect(fewer).toContain("file ./tsconfig/a.json: tsconfig/a.json");
  });

  it("names the command of the header", () => {
    expect(packageReport(fixture({ "package.json": { name: "p" } }), { tool: "pnpm api" })).toContain("`pnpm api check`");
  });

  it("throws when the build is missing", () => {
    expect(() => packageReport(fixture({ "package.json": { name: "p", types: "./dist/index.d.ts" } }))).toThrow(/dist\/index\.d\.ts is missing\. Build the package first/);
  });

  it("gives the same text for CRLF line ends", () => {
    const files = (end: string): Record<string, unknown> => ({ "package.json": { name: "p", types: "./index.d.ts" }, "index.d.ts": ["export interface A {", "    b: 1;", "}", ""].join(end) });
    expect(body(files("\r\n"))).toBe(body(files("\n")));
    expect(apiReport("p", fixture({}), []).includes("\r")).toBe(false);
  });
});
