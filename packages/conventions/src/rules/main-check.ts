/**
 * The rule `main-check`: a script does not find out that it is the main module by a compare of `process.argv[1]` with
 * its own path. Through a link (a junction, a symbolic link, `~/git` to `D:/git`), the two paths differ. Then the
 * script does nothing, and it ends with exit code 0.
 */
import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { codePackages, type Break, type Rule } from "../rule.ts";

/** The extensions of the files that the rule reads. */
const SCRIPT = new Set([".ts", ".mts", ".cts", ".js", ".mjs"]);

/** The largest file that the rule reads, in bytes. */
const MAX_BYTES = 1024 * 1024;

/** The compare of two real paths. It is true through a link too, and it works on each Node version. */
export const REAL_COMPARE = "process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))";

/** The imports that the compare of two real paths uses. */
const REAL_IMPORTS: readonly (readonly [string, string])[] = [
  ["realpathSync", "node:fs"],
  ["fileURLToPath", "node:url"],
];

/** The names of the imports that only a path compare uses. The fix removes the ones that become unused. */
const PATH_NAMES = ["fileURLToPath", "pathToFileURL", "resolve", "realpathSync"] as const;

/** This function tells if a text compares `process.argv[1]` with the path of the module, without a real path of each side. */
export function isPathCompare(text: string): boolean {
  if (!text.includes("process.argv[1]") || !/import\.meta\.(url|filename|dirname)\b/.test(text)) return false;
  // A text with no compare only uses the two values, for example a record of them in a test
  if (!/[!=]=|\.(?:endsWith|startsWith|includes)\(/.test(text)) return false;
  // Two real paths are equal through a link too
  return (text.match(/realpathSync\s*\(/g) ?? []).length < 2;
}

/** The lowest version of a range of `engines.node` (for example `>=22.19` or `^24.2.0`). It is undefined when the range has no single lower bound. */
export function lowestNode(range: unknown): readonly [number, number] | undefined {
  if (typeof range !== "string" || range.includes("||")) return undefined;
  // One \s* only: two of them around the optional operator are slow on a long run of spaces
  const found = /^(?:>=|\^|~)?\s*v?(\d+)(?:\.(\d+))?/.exec(range.trim());
  return found ? [Number(found[1]), Number(found[2] ?? 0)] : undefined;
}

/** This function tells if each Node version of the range has `import.meta.main`: 22.18 and later in 22, and 24.2 and later. Node 23 does not have it. */
export function hasImportMetaMain(range: unknown): boolean {
  const lowest = lowestNode(range);
  if (lowest === undefined) return false;
  const [major, minor] = lowest;
  // `^22.18` stays in 22. `>=22.18` lets Node 23 in, which does not have import.meta.main
  if (major === 22) return minor >= 18 && typeof range === "string" && /^[\^~]/.test(range.trim());
  return major > 24 || (major === 24 && minor >= 2);
}

/** This function gives the line with `condition` in place of the condition of its `if (...)`. It gives undefined when no `if` has only the main check. */
export function fixLine(line: string, condition: string): string | undefined {
  const start = line.indexOf("if (");
  if (start < 0) return undefined;
  let depth = 0;
  let end = -1;
  for (let index = start + 3; index < line.length; index++) {
    if (line[index] === "(") depth++;
    if (line[index] === ")" && --depth === 0) {
      end = index;
      break;
    }
  }
  if (end < 0) return undefined;
  const old = line.slice(start + 4, end);
  // Each part of the condition is about argv[1], else the condition has more than the main check
  if (!old.split("&&").every((part) => part.includes("process.argv[1]")) || !isPathCompare(old)) return undefined;
  return `${line.slice(0, start)}if (${condition})${line.slice(end + 1)}`;
}

/** The import line of `module` with named imports, as `[index, prefix, names, suffix]`. */
function namedImport(lines: readonly string[], module: string): [number, string, string[], string] | undefined {
  const pattern = new RegExp(`^(\\s*import\\s*\\{)([^}]*)(\\}\\s*from\\s*["']${module}["'];?\\s*)$`);
  for (let index = 0; index < lines.length; index++) {
    const found = pattern.exec(lines[index] ?? "");
    if (found) return [index, found[1] ?? "", (found[2] ?? "").split(",").map((part) => part.trim()).filter((part) => part !== ""), found[3] ?? ""];
  }
  return undefined;
}

const importLine = (prefix: string, names: readonly string[], suffix: string): string => `${prefix.trimEnd()} ${names.join(", ")} ${suffix.trimStart()}`;

/** The local name of an import part, for example `type A`, `A as B` or `A`. */
const imported = (part: string): string => part.replace(/^type\s+/, "").split(/\s+as\s+/)[0] ?? "";

/** This function adds the imports in `needs` that the text does not have. Then it removes the named imports of PATH_NAMES that the text does not use. */
export function fixImports(text: string, needs: readonly (readonly [string, string])[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let lines = text.split(/\r?\n/);
  const isImport = (line: string): boolean => /^\s*import\b/.test(line);
  for (const [name, module] of needs) {
    const has = lines.some((line) => isImport(line) && new RegExp(`\\b${name}\\b`).test(line));
    if (has) continue;
    const found = namedImport(lines, module) ?? namedImport(lines, module.replace(/^node:/, ""));
    if (found) {
      lines = lines.map((line, index) => (index === found[0] ? importLine(found[1], [...found[2], name], found[3]) : line));
      continue;
    }
    // A new import after the last import line, or at the top (after a shebang)
    let last = -1;
    lines.forEach((line, index) => {
      if (isImport(line) && /from\s*["'][^"']+["'];?\s*$/.test(line)) last = index;
    });
    const at = last >= 0 ? last + 1 : lines[0]?.startsWith("#!") ? 1 : 0;
    // The quote and the semicolon of the other imports of the file
    const style = lines.find((line) => isImport(line) && /from\s*["']/.test(line)) ?? "";
    const quote = /from\s*'/.test(style) ? "'" : '"';
    const semi = style === "" || /;\s*$/.test(style) ? ";" : "";
    lines = [...lines.slice(0, at), `import { ${name} } from ${quote}${module}${quote}${semi}`, ...lines.slice(at)];
  }
  for (const name of PATH_NAMES) {
    if (lines.some((line) => !isImport(line) && new RegExp(`\\b${name}\\b`).test(line))) continue;
    for (const module of ["node:url", "node:path", "node:fs", "url", "path", "fs"]) {
      const found = namedImport(lines, module);
      if (!found || !found[2].some((part) => imported(part) === name)) continue;
      const kept = found[2].filter((part) => imported(part) !== name);
      lines = kept.length === 0 ? lines.filter((_, index) => index !== found[0]) : lines.map((line, index) => (index === found[0] ? importLine(found[1], kept, found[3]) : line));
    }
  }
  return lines.join(eol);
}

export const mainCheck: Rule = {
  id: "main-check",
  title: "A script finds out that it is the main module with `import.meta.main`, or with a real path of each side, not by a compare of `process.argv[1]` with its path.",
  reason:
    "Through a link, `process.argv[1]` has the path of the link, and the module has the real path. The compare is false, so the script does nothing and ends with exit code 0: a check that looks done but did not start.",
  fix: "Write `if (import.meta.main)` when `engines.node` allows only versions that have it (`^22.18`, `>=24.2`). Else compare `realpathSync(process.argv[1])` with `realpathSync(fileURLToPath(import.meta.url))`. `conventions fix` writes the one that fits.",
  sources: [{ repo: "private", rule: "main-check", doc: "docs/STRATEGY.md (2026-11-02, the main check through a link)" }],
  options: {},
  check(context) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    // The package of a file is the deepest package folder that holds it
    const packages = [...codePackages(context), context.rootPackage].sort((a, b) => b.folder.length - a.folder.length);
    const breaks: Break[] = [];
    for (const file of files) {
      if (!SCRIPT.has(extname(file).toLowerCase()) || /(^|\/)(node_modules|dist)\//.test(file)) continue;
      const path = join(context.root, file);
      let text: string;
      try {
        if (statSync(path).size > MAX_BYTES) continue;
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      if (!text.includes("process.argv[1]")) continue;
      const owner = packages.find((p) => p.folder === "" || file.startsWith(`${p.folder}/`));
      const engines = (owner?.manifest as { engines?: { node?: unknown } } | undefined)?.engines?.node;
      const main = hasImportMetaMain(engines);
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";
        const next = lines[index + 1] ?? "";
        // A compare on two lines: process.argv[1] on this line, and the path of the module on the next line
        const hit = isPathCompare(line) || (line.includes("process.argv[1]") && !/import\.meta/.test(line) && !isPathCompare(next) && isPathCompare(`${line} ${next}`));
        if (!hit) continue;
        const fixed = fixLine(line, main ? "import.meta.main" : REAL_COMPARE);
        const eol = text.includes("\r\n") ? "\r\n" : "\n";
        const after = fixed === undefined ? undefined : fixImports([...lines.slice(0, index), fixed, ...lines.slice(index + 1)].join(eol), main ? [] : REAL_IMPORTS);
        breaks.push({
          file,
          line: index + 1,
          message: "The script compares process.argv[1] with its own path, which is false through a link.",
          ...(after === undefined ? { fix: "Change the condition by hand: it has more than the main check, or it is on more than one line." } : { edits: [{ file, before: text, after }] }),
        });
      }
    }
    return breaks;
  },
};
