import { describe, expect, it } from "vitest";
import { pageFaults, reportEntries } from "./page.ts";

const REPORT = [
  "# The public API of lib",
  "",
  "## . (build/index.d.ts): 3 names",
  "",
  "type Options: build/index.d.ts#Options",
  "layout: build/index.d.ts#layout",
  "ns: build/ns.d.ts#* (namespace)",
  "ns.inner: build/ns.d.ts#inner",
  "ambient: build/index.d.ts#global",
  "",
  "## ./svg (build/svg.d.ts): 1 names",
  "",
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
  "### build/index.d.ts#layout",
  "declare function layout(): void;",
  "",
].join("\n");

const WHOLE = "Use `layout` with `Options`, the namespace `ns` and `toSvg`.\n";

describe("the names of a report", () => {
  it("gives the names of each entry, with no namespace member, bin or ambient line", () => {
    const entries = reportEntries(REPORT);
    expect([...entries.keys()]).toEqual([".", "./svg", "./x.css"]);
    expect([...(entries.get(".") ?? [])]).toEqual(["Options", "layout", "ns"]);
    expect([...(entries.get("./svg") ?? [])]).toEqual(["toSvg"]);
    expect([...(entries.get("./x.css") ?? [])]).toEqual([]);
  });

  it("gives the same names as the parser of the report before the model", () => {
    const external = "## . (build/index.d.ts): 2 names\n\nlayout: build/index.d.ts#layout\nOther: other-pkg#Other (external)\n";
    const twice = "## . (a.d.ts): 1 names\n\na: a.d.ts#a\n\n## . (b.d.ts): 1 names\n\nb: b.d.ts#b\n";
    for (const report of [REPORT, "", external, twice, "## bin: 1 commands\n\nlib: ./cli.js\n"]) {
      const shape = (entries: ReadonlyMap<string, ReadonlySet<string>>): [string, string[]][] => [...entries].map(([key, names]) => [key, [...names]]);
      expect(shape(reportEntries(report))).toEqual(shape(oldReportEntries(report)));
    }
  });
});

/** The parser of the names before the model, copied word for word. The test above holds that `reportEntries` gives the same names. */
function oldReportEntries(report: string): ReadonlyMap<string, ReadonlySet<string>> {
  const entries = new Map<string, Set<string>>();
  let current: Set<string> | null = null;
  for (const line of report.split("\n")) {
    if (line.startsWith("## ")) {
      const subpath = /^## (\.\S*?)(?: \(.*\))?: /.exec(line)?.[1];
      current = null;
      if (subpath !== undefined) {
        const names = new Set<string>();
        entries.set(subpath, names);
        if (line.endsWith(" names")) current = names;
      }
      continue;
    }
    const name = /^(?:type )?([^\s:]+): /.exec(line)?.[1];
    if (current !== null && name !== undefined && name !== "ambient" && !name.includes(".")) current.add(name);
  }
  return entries;
}

describe("the check of a page", () => {
  it("passes when each export shows in code, in a block or in a span", () => {
    expect(pageFaults(REPORT, "lib", [WHOLE])).toEqual([]);
    expect(pageFaults(REPORT, "lib", ["```ts\nlayout(); const a: Options = ns; toSvg();\n```\n"])).toEqual([]);
  });

  it("reads each file of a page", () => {
    expect(pageFaults(REPORT, "lib", ["`layout` and `Options`", "`ns` and `toSvg`"])).toEqual([]);
  });

  it("fails on an export that only prose names, or that no text names", () => {
    expect(pageFaults(REPORT, "lib", ["The layout and the Options. `ns`, `toSvg`."])).toEqual([
      "Options: the package exports this name, and no code on the page shows it.",
      "layout: the package exports this name, and no code on the page shows it.",
    ]);
  });

  it("does not take a longer name for the export", () => {
    expect(pageFaults(REPORT, "lib", ["`layoutAll`, `Options`, `ns`, `toSvg`"])[0]).toContain("layout: the package exports");
  });

  it("fails on an import of a name that the entry does not export, and passes a name of its entry", () => {
    const good = '```ts\nimport { toSvg } from "lib/svg";\nimport type { Options as O } from "lib";\n```\n';
    expect(pageFaults(REPORT, "lib", [WHOLE + good])).toEqual([]);
    const bad = '```ts\nimport { layout } from "lib/svg";\nimport { other } from "elsewhere";\n```\n';
    expect(pageFaults(REPORT, "lib", [WHOLE + bad])).toEqual(["layout: the page imports this name from lib/svg, and that entry does not export it."]);
  });

  it("fails on an import from an entry that the package does not have", () => {
    const bad = '```ts\nimport { layout } from "lib/gone";\n```\n';
    expect(pageFaults(REPORT, "lib", [WHOLE + bad])).toEqual(["lib/gone: the page imports from this path, and the package has no such entry."]);
  });

  it("fails on a signature, an interface or a type of a name that the package does not export", () => {
    const bad = "```ts\nfunction gone(a: number): void;\ninterface Lost { a: 1 }\ntype Old = string;\n```\n";
    expect(pageFaults(REPORT, "lib", [WHOLE + bad])).toEqual([
      "Lost: the page gives the declaration of this name, and the package does not export it.",
      "Old: the page gives the declaration of this name, and the package does not export it.",
      "gone: the page gives the declaration of this name, and the package does not export it.",
    ]);
  });

  it("does not read a function with a body as a signature of the API", () => {
    expect(pageFaults(REPORT, "lib", [`${WHOLE}\`\`\`ts\nfunction helper(a: number) {\n  return a;\n}\n\`\`\`\n`])).toEqual([]);
  });

  it("does not read the code of a page as prose, or a fence that stays open as nothing", () => {
    expect(pageFaults(REPORT, "lib", ["`layout` `Options` `ns`\n\n```ts\ntoSvg();\n"])).toEqual([]);
  });

  it("accepts an exception with its reason", () => {
    const except = { toSvg: "The renderer page tells this name.", Old: "The page shows a type of the reader." };
    expect(pageFaults(REPORT, "lib", ["`layout` `Options` `ns`\n\n```ts\ntype Old = string;\n```\n"], except)).toEqual([]);
  });

  it("fails on an exception with no reason, and on an exception that removes no fault", () => {
    expect(pageFaults(REPORT, "lib", [WHOLE], { layout: "A reason." })).toEqual(["layout: the exception removes no fault, so remove it."]);
    expect(pageFaults(REPORT, "lib", ["`layout` `Options` `ns`"], { toSvg: " " })).toEqual(["toSvg: the exception has no reason."]);
  });

  it("reads a CRLF file", () => {
    expect(pageFaults(REPORT, "lib", ["`layout` `Options`\r\n\r\n```ts\r\nns; toSvg();\r\n```\r\n"])).toEqual([]);
  });
});
