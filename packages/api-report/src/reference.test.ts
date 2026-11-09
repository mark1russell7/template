import { describe, expect, it } from "vitest";
import { apiModel } from "./model.ts";
import { pageFaults } from "./page.ts";
import { referencePage } from "./reference.ts";

const REPORT = [
  "# The public API of lib",
  "",
  "## . (build/index.d.ts): 8 names",
  "",
  "type Options: build/index.d.ts#Options",
  "layout: build/index.d.ts#layout",
  "renamed: build/index.d.ts#layout$1",
  "aliased: build/index.d.ts#source",
  "many: build/index.d.ts#many",
  "useBundled: build/index.d.ts#useBundled",
  "ns: build/ns.d.ts#* (namespace)",
  "ns.inner: build/ns.d.ts#inner",
  "other: elsewhere#other (external)",
  "ambient: build/index.d.ts#global",
  "",
  "## ./svg (build/svg.d.ts): 2 names",
  "",
  "layout: build/index.d.ts#layout",
  "toSvg: build/svg.d.ts#toSvg",
  "",
  "## ./x.css: no declaration file for ./x.css",
  "",
  "file ./x.css: x.css",
  "",
  "## bin: 1 commands",
  "",
  "lib: ./build/cli.js",
  "",
  "## Declarations",
  "",
  "### build/index.d.ts#Options",
  "export interface Options {",
  "  readonly a?: number;",
  "}",
  "",
  "### build/index.d.ts#global",
  "declare global {",
  "  var lib: number;",
  "}",
  "",
  "### build/index.d.ts#layout",
  "export declare function layout(): void;",
  "",
  "### build/index.d.ts#source",
  "declare function source(): void;",
  "",
  "### build/index.d.ts#many",
  "export declare function many(a: string): string;",
  "export declare function many(a: number): number;",
  "",
  "### build/index.d.ts#useBundled",
  "export declare function useBundled(a: typeof layout$1): void;",
  "",
  "### build/index.d.ts#layout$1",
  "declare function layout$1(): void;",
  "",
  "### build/ns.d.ts#inner",
  "declare const inner: number;",
  "",
  "### build/svg.d.ts#toSvg",
  "declare function toSvg(tick: string): string;",
  "",
].join("\n");

describe("the page of each export", () => {
  const page = referencePage(REPORT, "lib");

  it("gives the title and the description in the front matter, with a comment that names the command", () => {
    expect(page.startsWith('---\n# The command `api-report update` writes this file')).toBe(true);
    expect(page).toContain('title: "Each export of lib"\n');
    expect(page).toContain('description: "Each entry point of lib, with its exports and their declarations."\n');
  });

  it("adds the fields of frontmatter after the description, and a field title replaces the default", () => {
    const head = referencePage(REPORT, "lib", { order: 42, status: "final", title: "API: each export", draft: false }).split("\n---\n")[0] ?? "";
    expect(head.split("\n").slice(2)).toEqual([
      'title: "API: each export"',
      'description: "Each entry point of lib, with its exports and their declarations."',
      "order: 42",
      'status: "final"',
      "draft: false",
    ]);
    expect(referencePage(REPORT, "lib", {})).toBe(page);
  });

  it("gives each entry a section with an import of its names", () => {
    expect(page).toContain('## `lib`\n\n```ts\nimport {\n  type Options, layout, renamed, aliased, many, useBundled, ns, other,\n} from "lib";\n```');
    expect(page).toContain('## `lib/svg`\n\n```ts\nimport {\n  layout, toSvg,\n} from "lib/svg";\n```');
  });

  it("does not show the file of a declaration, so the name of a chunk stays off the page", () => {
    const chunked = referencePage(["## . (build/index.d.ts): 1 names", "", "html: build/html-o5bDHjNi.d.mts#html", "", "## Declarations", "", "### build/html-o5bDHjNi.d.mts#html", "export declare function html(): void;", ""].join("\n"), "lib");
    expect(chunked).toContain("function html(): void;");
    expect(chunked).not.toContain("o5bDHjNi");
  });

  it("shows a declaration with no export or declare word, one time", () => {
    expect(page).toContain("interface Options {\n  readonly a?: number;\n}");
    expect(page.split("function layout(): void;").length - 1).toBe(1);
    expect(page).not.toContain("export interface");
    expect(page).not.toContain("declare function");
  });

  it("tells the name of an export with a different declaration, and the package of an external name", () => {
    expect(page).toContain("// The export aliased:\nfunction source(): void;");
    expect(page).toContain("// other comes from the package elsewhere.");
  });

  it("shows the name of the export where a bundler changed the name of its declaration", () => {
    expect(page).toContain("function renamed(): void;");
    expect(page).toContain("function useBundled(a: typeof renamed): void;");
    expect(page).not.toContain("layout$1");
    expect(page).not.toContain("// The export renamed:");
  });

  it("shows each signature of an overload, in one block", () => {
    expect(page).toContain("function many(a: string): string;\nfunction many(a: number): number;");
  });

  it("shows a name of two entries in the import of each, and its declaration in the first", () => {
    const [first, second] = page.split("## `lib/svg`");
    expect(first).toContain("function layout(): void;");
    expect(second).toContain("layout,");
    expect(second).not.toContain("function layout(): void;");
  });

  it("shows the members of a namespace and the ambient declarations", () => {
    expect(page).toContain("// The export ns.inner:\nconst inner: number;");
    expect(page).toContain("declare global {\n  var lib: number;\n}");
  });

  it("says that an entry with no declarations has none, and leaves out the commands", () => {
    expect(page).toContain("## `lib/x.css`\n\nThis entry has no declarations.");
    expect(page).not.toContain("cli.js");
  });

  it("shows each export of the report for the check of a page", () => {
    const missing = pageFaults(REPORT, "lib", [page]).filter((fault) => fault.includes("no code on the page shows it"));
    expect(missing).toEqual([]);
  });

  it("makes a fence longer than the backticks of the code", () => {
    const code = "### build/svg.d.ts#toSvg\ntype Q = \"```\";\n";
    expect(referencePage(REPORT.replace(/### build\/svg\.d\.ts#toSvg\n[^\n]*\n/, code), "lib")).toContain('````ts\n');
  });

  it("gives an import of a default export as a valid name", () => {
    const report = "## . (build/index.d.ts): 1 names\n\ndefault: build/index.d.ts#main\n\n## Declarations\n\n### build/index.d.ts#main\ndeclare function main(): void;\n";
    const text = referencePage(report, "lib");
    expect(text).toContain("default as defaultExport,");
    expect(text).toContain("// The export default:\nfunction main(): void;");
  });

  it("gives the same text for a CRLF report", () => {
    expect(referencePage(REPORT.replace(/\n/g, "\r\n"), "lib")).toBe(page);
  });
});

describe("the page of each export from a model", () => {
  it("gives the same page as the report when the model has no doc comments", () => {
    expect(referencePage(apiModel(REPORT, "lib"), "lib")).toBe(referencePage(REPORT, "lib"));
  });

  it("puts the doc comment of each declaration above it, and keeps a comment end in the text inside the comment", () => {
    const docs = new Map([
      ["build/index.d.ts#layout", "The layout of a tree."],
      ["build/svg.d.ts#toSvg", "The text of a tick.\n\n@param tick - A tick. Its end mark */ stays inside."],
    ]);
    const page = referencePage(apiModel(REPORT, "lib", docs), "lib");
    expect(page).toContain("/** The layout of a tree. */\nfunction layout(): void;");
    expect(page).toContain("/**\n * The text of a tick.\n *\n * @param tick - A tick. Its end mark *\/ stays inside.\n */\nfunction toSvg(tick: string): string;");
  });

  it("gives the model of a report: the entries, their names and the declarations", () => {
    const model = apiModel(REPORT, "lib", new Map([["build/index.d.ts#Options", "The options."]]));
    expect(model.packageName).toBe("lib");
    expect(model.entries.map((entry) => entry.subpath)).toEqual([".", "./svg", "./x.css"]);
    expect(model.entries[2]?.names).toEqual([]);
    expect(model.entries[0]?.names[0]).toEqual({ name: "Options", key: "build/index.d.ts#Options", isType: true, kind: "declaration" });
    expect(model.entries[0]?.names.find((name) => name.name === "ns")?.kind).toBe("namespace");
    expect(model.entries[0]?.names.find((name) => name.name === "other")?.kind).toBe("external");
    expect(model.entries[0]?.names.find((name) => name.name === "ambient")?.kind).toBe("ambient");
    expect(model.declarations["build/index.d.ts#Options"]).toEqual({ text: "export interface Options {\n  readonly a?: number;\n}", doc: "The options." });
    expect(model.declarations["build/index.d.ts#layout"]).toEqual({ text: "export declare function layout(): void;" });
  });
});
