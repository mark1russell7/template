import { describe, expect, it } from "vitest";
import { pageFaults } from "./page.ts";
import { referencePage } from "./reference.ts";

const REPORT = [
  "# The public API of lib",
  "",
  "## . (build/index.d.ts): 5 names",
  "",
  "type Options: build/index.d.ts#Options",
  "layout: build/index.d.ts#layout",
  "renamed: build/index.d.ts#layout$1",
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

  it("gives each entry a section with an import of its names", () => {
    expect(page).toContain('## `lib`\n\n```ts\nimport {\n  type Options, layout, renamed, ns, other,\n} from "lib";\n```');
    expect(page).toContain('## `lib/svg`\n\n```ts\nimport {\n  layout, toSvg,\n} from "lib/svg";\n```');
  });

  it("shows a declaration with no export or declare word, one time", () => {
    expect(page).toContain("interface Options {\n  readonly a?: number;\n}");
    expect(page.split("function layout(): void;").length - 1).toBe(1);
    expect(page).not.toContain("export interface");
    expect(page).not.toContain("declare function");
  });

  it("tells the name of an export with a different declaration, and the package of an external name", () => {
    expect(page).toContain("// The export renamed:\nfunction layout$1(): void;");
    expect(page).toContain("// other comes from the package elsewhere.");
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
