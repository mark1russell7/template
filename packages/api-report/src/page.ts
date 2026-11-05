/**
 * The check of a hand-written page of an API against the report of its package. A page can explain each
 * call, and the check holds its names. Each export shows in the code of the page. The page gives no name
 * as an export that the package does not have.
 */
import { byCode } from "./entries.ts";

/** One package and the pages that tell its API: an item of the field `pages` of `apiReport`. */
export interface ApiPage {
  /** The folder of the package, relative to the root. */
  readonly package: string;
  /** The Markdown or MDX files of the page, relative to the root. Together they tell the API. The list can be empty when `reference` is present. */
  readonly pages: readonly string[];
  /** The file of a page of each export, relative to the root. The command `update` writes it from the report, and the command `check` compares it. */
  readonly reference?: string;
  /** The names that the check does not examine, each with its reason. */
  readonly except?: Readonly<Record<string, string>>;
}

/** This function gives the names of each entry of a report, by the subpath of the entry. The members of a namespace are not in the result. */
export function reportEntries(report: string): ReadonlyMap<string, ReadonlySet<string>> {
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

/** This function gives the code blocks and the code spans of a Markdown text. */
function codeOf(text: string): { readonly blocks: readonly string[]; readonly spans: readonly string[] } {
  const blocks: string[] = [];
  const prose: string[] = [];
  let fence: string | null = null;
  let block: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null) {
      if (mark === undefined) prose.push(line);
      else {
        fence = mark;
        block = [];
      }
    } else if (mark !== undefined && mark[0] === fence[0] && mark.length >= fence.length) {
      blocks.push(block.join("\n"));
      fence = null;
    } else block.push(line);
  }
  if (fence !== null) blocks.push(block.join("\n"));
  const spans = [...prose.join("\n").matchAll(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g)].map((match) => match[2] ?? "");
  return { blocks, spans };
}

/** This function is true if the code has `name` as a whole word. */
function hasWord(code: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(code);
}

/**
 * This function gives the faults of the pages of a package against its report.
 *
 * An export must show in a code block or a code span of a page. An import from the package in a code block
 * must name an export of that entry. A signature, an `interface` or a `type` in a code block must be an
 * export of an entry. An exception needs a reason, and an exception that removes no fault is also a fault.
 * When `complete` is true, a different page shows each export, so the first rule does not apply.
 */
export function pageFaults(report: string, packageName: string, pages: readonly string[], except: Readonly<Record<string, string>> = {}, complete = false): string[] {
  const entries = reportEntries(report);
  const all = new Set([...entries.values()].flatMap((names) => [...names]));
  const code = pages.map(codeOf);
  const blocks = code.flatMap((item) => item.blocks);
  const text = [...blocks, ...code.flatMap((item) => item.spans)].join("\n");
  const faults = new Map<string, string>();
  const used = new Set<string>();
  const fault = (name: string, words: string): void => {
    if (Object.hasOwn(except, name)) used.add(name);
    else if (!faults.has(name)) faults.set(name, `${name}: ${words}`);
  };

  if (!complete) {
    for (const name of all) {
      if (!hasWord(text, name)) fault(name, "the package exports this name, and no code on the page shows it.");
    }
  }
  for (const block of blocks) {
    for (const match of block.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
      const source = match[2] ?? "";
      if (source !== packageName && !source.startsWith(`${packageName}/`)) continue;
      const names = entries.get(`.${source.slice(packageName.length)}`);
      if (names === undefined) {
        fault(source, "the page imports from this path, and the package has no such entry.");
        continue;
      }
      for (const part of (match[1] ?? "").split(",")) {
        const name = part.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "";
        if (name !== "" && name !== "default" && !names.has(name)) fault(name, `the page imports this name from ${source}, and that entry does not export it.`);
      }
    }
    for (const line of block.split("\n")) {
      const name =
        /^\s*(?:export\s+)?(?:declare\s+)?function\s+([\w$]+)\s*[<(].*;\s*(?:\/\/.*)?$/.exec(line)?.[1] ??
        /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+([\w$]+)/.exec(line)?.[1];
      if (name !== undefined && !all.has(name)) fault(name, "the page gives the declaration of this name, and the package does not export it.");
    }
  }
  for (const [name, reason] of Object.entries(except)) {
    if (reason.trim() === "") faults.set(name, `${name}: the exception has no reason.`);
    else if (!used.has(name)) faults.set(name, `${name}: the exception removes no fault, so remove it.`);
  }
  return [...faults.entries()].sort(([a], [b]) => byCode(a, b)).map(([, words]) => words);
}
