/**
 * A page of each export of a package, from its report. A library with many exports keeps each name on this
 * page, and a hand-written page explains the main calls. The report has the names and the declarations, so
 * this page has the same text as the report in each build.
 */
import type { FrontmatterValue } from "./page.ts";

/** One line of an entry of a report. */
interface ReportItem {
  readonly name: string;
  readonly key: string;
  readonly isType: boolean;
  readonly kind: "declaration" | "namespace" | "external" | "ambient";
}

/** One entry of a report: its subpath and its lines. */
interface ReportEntry {
  readonly subpath: string;
  readonly items: readonly ReportItem[];
}

/** This function gives the entries of a report and the text of each declaration. */
function readReport(report: string): { readonly entries: readonly ReportEntry[]; readonly declarations: ReadonlyMap<string, string> } {
  const entries: ReportEntry[] = [];
  const declarations = new Map<string, string>();
  let items: ReportItem[] | null = null;
  let key: string | null = null;
  let body: string[] = [];
  const close = (): void => {
    if (key !== null) declarations.set(key, body.join("\n").trimEnd());
  };
  let inDeclarations = false;
  for (const line of report.replace(/\r\n/g, "\n").split("\n")) {
    if (inDeclarations) {
      const next = /^### (.+)$/.exec(line)?.[1];
      if (next === undefined) body.push(line);
      else {
        close();
        key = next;
        body = [];
      }
      continue;
    }
    if (line.startsWith("## ")) {
      inDeclarations = line === "## Declarations";
      const subpath = /^## (\.\S*?)(?: \(.*\))?: /.exec(line)?.[1];
      items = null;
      if (subpath !== undefined) {
        const lines: ReportItem[] = [];
        entries.push({ subpath, items: lines });
        if (line.endsWith(" names")) items = lines;
      }
      continue;
    }
    if (items === null) continue;
    const match = /^(type )?(.+?): (\S+)(?: \((namespace|external)\))?$/.exec(line);
    if (match === null) continue;
    const name = match[2] ?? "";
    const kind = name === "ambient" ? "ambient" : ((match[4] as "namespace" | "external" | undefined) ?? "declaration");
    items.push({ name, key: match[3] ?? "", isType: match[1] !== undefined, kind });
  }
  close();
  return { entries, declarations };
}

/** This function gives a fenced block of TypeScript. The fence is longer than each run of backticks in the code. */
function fenced(code: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}ts\n${code}\n${fence}`;
}

/** The most characters of a line of an import list. */
const IMPORT_WIDTH = 100;

/** This function gives an import of `names` from `path`, with a line break at `IMPORT_WIDTH`. */
function importOf(names: readonly string[], path: string): string {
  const lines: string[] = [];
  let line = " ";
  for (const name of names) {
    if (line.length + name.length + 2 > IMPORT_WIDTH) {
      lines.push(line);
      line = " ";
    }
    line += ` ${name},`;
  }
  lines.push(line);
  return `import {\n${lines.join("\n")}\n} from ${JSON.stringify(path)};`;
}

/** This function removes the words `export` and `declare` from the start of each statement of a declaration. `declare global` and `declare module` keep the word. */
function plain(declaration: string): string {
  return declaration.replace(/^(?:export )?(?:declare (?!global\b|module\b))?/gm, "");
}

/** This pattern finds a name that a bundler changed, to keep two declarations apart: `grid$1`. */
const BUNDLER_NAME = /\$\d+$/;

/** This function gives the name of the declaration of a line of a report. */
function localName(item: ReportItem): string {
  return item.key.slice(item.key.lastIndexOf("#") + 1);
}

/** This function puts the name of each export of `items` in `code`, where a bundler changed that name. */
function withExportNames(code: string, items: readonly ReportItem[]): string {
  let text = code;
  for (const item of items) {
    const local = localName(item);
    if (!BUNDLER_NAME.test(local) || item.name.includes(".") || item.kind !== "declaration") continue;
    const word = new RegExp(`(?<![\\w$])${local.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}(?![\\w$])`, "g");
    text = text.replace(word, () => item.name);
  }
  return text;
}

/**
 * This function gives the Markdown of the page of each export of a package. Each entry has an import with its
 * names. A declaration shows one time, in the first entry that reaches it. A comment tells the name of an
 * export when the source gave the declaration a different name. A name from a bundler does not show. A
 * comment also tells the package of an external name.
 *
 * The fields of `frontmatter` go into the front matter, after the title and the description. A field `title` or
 * `description` replaces the default.
 */
export function referencePage(report: string, packageName: string, frontmatter: Readonly<Record<string, FrontmatterValue>> = {}): string {
  const { entries, declarations } = readReport(report);
  const fields: Record<string, FrontmatterValue> = {
    title: `Each export of ${packageName}`,
    description: `Each entry point of ${packageName}, with its exports and their declarations.`,
    ...frontmatter,
  };
  const out = [
    "---",
    "# The command `api-report update` writes this file from the report of the package. Do not edit it.",
    ...Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    "---",
    "",
    "The report of the API of the package makes this page, so the page and the package have the same names. Each section is one entry point. A declaration shows one time, in the first section that has it.",
  ];
  const seen = new Set<string>();
  for (const entry of entries) {
    const path = `${packageName}${entry.subpath.slice(1)}`;
    out.push("", `## \`${path}\``, "");
    if (entry.items.length === 0) {
      out.push("This entry has no declarations.");
      continue;
    }
    const top = entry.items.filter((item) => item.kind !== "ambient" && !item.name.includes(".") && !item.name.startsWith("* "));
    const blocks = top.length > 0 ? [fenced(importOf(top.map((item) => `${item.isType ? "type " : ""}${item.name === "default" ? "default as defaultExport" : item.name}`), path))] : [];
    const parts: string[] = [];
    for (const item of entry.items) {
      if (seen.has(`${item.name} ${item.key}`)) continue;
      seen.add(`${item.name} ${item.key}`);
      if (item.kind === "external") {
        const from = item.key.slice(0, item.key.lastIndexOf("#"));
        parts.push(`// ${item.name} comes from the package ${from}.`);
        continue;
      }
      const text = declarations.get(item.key);
      if (text === undefined || seen.has(item.key)) continue;
      seen.add(item.key);
      const local = localName(item);
      const label = item.kind === "ambient" || local === item.name || BUNDLER_NAME.test(local) ? "" : `// The export ${item.name}:\n`;
      parts.push(`${label}${plain(text)}`);
    }
    if (parts.length > 0) blocks.push(fenced(withExportNames(parts.join("\n\n"), entry.items)));
    out.push(blocks.join("\n\n"));
  }
  return `${out.join("\n")}\n`;
}
