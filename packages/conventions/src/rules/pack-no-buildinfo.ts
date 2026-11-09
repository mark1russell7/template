/**
 * The rule `pack-no-buildinfo`: npm does not pack the build info file of tsc. A public package that writes it in a
 * folder of its field `files` has the negation `!<path>` there.
 */
import { readdirSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";
import { buildInfoFile } from "../tsconfig.ts";
import { codePackages, lineOf, type Break, type PackageInfo, type Rule } from "../rule.ts";
import { globToRegExp } from "../workspace.ts";

/** The names of the tsconfig files of a package folder. */
const TSCONFIG = /^tsconfig(?:\.[\w-]+)?\.json$/;

/** A rule of the ignore list that npm makes from the field `files`, with the index of its entry. */
interface PackRule {
  /** The glob, without its `!` characters. */
  readonly glob: string;
  /** True when the rule includes the paths that it matches (an odd count of `!`). */
  readonly include: boolean;
  /** The index of the entry of `files`. */
  readonly index: number;
}

/** This function gives the rule of a line of the ignore list, as minimatch reads it: each `!` inverts the rule. */
function packRule(line: string, index: number): PackRule {
  let bangs = 0;
  while (line.charAt(bangs) === "!") bangs += 1;
  // minimatch does not keep a repeated `/` (preserveMultipleSlashes is false)
  return { glob: line.slice(bangs).replace(/\/{2,}/g, "/"), include: bangs % 2 === 1, index };
}

/** This function gives the regular expression of a glob, as npm reads it: with no case, and `*` also matches a dot. */
function packRegExp(glob: string): RegExp {
  return new RegExp(globToRegExp(glob).source, "i");
}

/**
 * This function tells if a rule matches the path (`/`, relative to the package). A glob with no `/` matches the name
 * at each depth (matchBase). A `/` at the start anchors the glob, as each glob with a `/` is. A `/` at the end
 * matches a folder only. A rule that includes also matches a folder that holds a path that the glob can match.
 */
function ruleMatches(rule: PackRule, path: string, folder: boolean): boolean {
  let glob = rule.glob;
  if (glob.startsWith("/")) glob = glob.slice(1);
  if (glob.endsWith("/")) {
    if (!folder) return false;
    glob = glob.slice(0, -1);
  }
  if (glob === "") return false;
  const segments = path.split("/");
  if (!rule.glob.includes("/")) return packRegExp(glob).test(segments[segments.length - 1] ?? path);
  if (packRegExp(glob).test(path)) return true;
  if (!folder || !rule.include) return false;
  // A partial match: each segment of the folder matches its segment of the glob, and the glob has more segments
  const parts = glob.split("/");
  for (let at = 0; at < parts.length; at++) {
    const part = parts[at] ?? "";
    if (part === "**" || at >= segments.length) return true;
    if (!packRegExp(part).test(segments[at] ?? "")) return false;
  }
  return false;
}

/**
 * This function gives the rules that npm 11 (npm-packlist 10) makes from the field `files`, for the path and its
 * folders. npm examines each entry on the disk. At the time of the pack, the path is a file and each of its parents
 * is a folder. This function takes each other entry as a pattern, and the rules of a pattern match the path in the
 * same way.
 */
function packRules(files: readonly unknown[], path: string): { readonly strict: PackRule[]; readonly loose: PackRule[] } {
  const parts = path.split("/");
  const folders = new Set(parts.slice(0, -1).map((_, at) => parts.slice(0, at + 1).join("/")));
  const strict: PackRule[] = [];
  const loose: PackRule[] = [];
  files.forEach((entry, index) => {
    if (typeof entry !== "string") return;
    let file = entry;
    if (file.startsWith("./")) file = file.slice(1);
    if (file.endsWith("/*")) file += "*";
    const inverse = `!${file}`;
    // The path that npm gives to lstat: without the `!` characters, normalized as path.join does
    const target = posix
      .normalize(file.replace(/^!+/, "") || ".")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (target === path) {
      // A file is strict: its rule goes before the strict rules of the earlier entries, so the first entry decides
      strict.unshift(packRule(inverse, index));
    } else if (folders.has(target)) {
      loose.push(packRule(inverse, index), packRule(`${inverse}/**`, index));
    } else {
      loose.push(packRule(inverse, index));
    }
  });
  return { strict, loose };
}

/**
 * This function gives the last rule that matches the path, or undefined when no rule matches it. The rule `*` of
 * npm comes first, so a path that no rule matches is not packed.
 */
function lastMatch(rules: readonly PackRule[], path: string, folder: boolean): PackRule | undefined {
  let found: PackRule | undefined;
  for (const rule of rules) if (ruleMatches(rule, path, folder)) found = rule;
  return found;
}

/**
 * This function tells if npm 11 packs `path` (relative to the package, with `/`) by the field `files`. It follows
 * npm-packlist 10: the rule `*`, then a rule for each entry in its order, then the strict rules of the entries that
 * name the file. The last rule that matches a path decides, and npm does not go into a folder that it does not take.
 * The function gives the index of the entry of the rule that takes the file, or -1 when npm does not pack it.
 */
export function packedBy(files: readonly unknown[], path: string): number {
  const { strict, loose } = packRules(files, path);
  const rules = [...loose, ...strict];
  const parts = path.split("/");
  for (let at = 1; at < parts.length; at++) {
    if (lastMatch(rules, parts.slice(0, at).join("/"), true)?.include !== true) return -1;
  }
  const rule = lastMatch(rules, path, false);
  return rule?.include === true ? rule.index : -1;
}

/**
 * This function gives the text of `package.json` with the entry `negation` after the entry `index` of the field
 * `files`, in the format of the file. It gives undefined when it cannot find the field, or when the changed text does
 * not parse as the manifest with the new entry.
 */
export function withNegation(pkg: PackageInfo, index: number, negation: string): string | undefined {
  const files = pkg.manifest["files"];
  if (!Array.isArray(files)) return undefined;
  const expected = JSON.stringify({ ...pkg.manifest, files: [...files.slice(0, index + 1), negation, ...files.slice(index + 1)] });
  const eol = pkg.text.includes("\r\n") ? "\r\n" : "\n";
  for (const field of pkg.text.matchAll(/"files"\s*:\s*\[/g)) {
    const open = (field.index ?? 0) + field[0].length;
    // The end of each JSON string of the list, until the entry `index`
    let at = open;
    let end = -1;
    for (let item = 0; item <= index; item++) {
      const match = /^[\s,]*("(?:[^"\\]|\\.)*")/.exec(pkg.text.slice(at));
      if (match === null) break;
      at += match[0].length;
      if (item === index) end = at;
    }
    if (end < 0) continue;
    // A list with a line for each entry gets a new line with the indent of the entry, a list on one line gets ", "
    const multiline = (/^\s*/.exec(pkg.text.slice(open))?.[0] ?? "").includes("\n");
    const indent = /^[ \t]*/.exec(pkg.text.slice(pkg.text.lastIndexOf("\n", end - 1) + 1))?.[0] ?? "";
    const separator = multiline ? `,${eol}${indent}` : ", ";
    const after = `${pkg.text.slice(0, end)}${separator}${JSON.stringify(negation)}${pkg.text.slice(end)}`;
    try {
      if (JSON.stringify(JSON.parse(after)) === expected) return after;
    } catch {
      // The next field "files", if any
    }
  }
  return undefined;
}

export const packNoBuildinfo: Rule = {
  id: "pack-no-buildinfo",
  title: "npm does not pack the build info file of tsc: a public package that writes it in a folder of `files` has the negation `!<path>` there.",
  reason:
    "The build info file changes on each build, also after a bump of a dev dependency. The release stops when the packed files of an unchanged version differ from npm. On 2026-11-09 the main of splay-react went red, because only `dist/.tsbuildinfo` differed. The cue lib preset writes this file in `dist`, and `files` packs `dist`.",
  fix: 'Add the negation of the path after its folder in `files`, for example `"files": ["dist", "!dist/.tsbuildinfo"]`. `conventions fix` writes it. Keep the file in `dist`: a `tsc -b` after a clean of `dist` must build again. A package with no field `files` packs each file of its folder: give it the field. A changed list of packed files needs a PATCH version.',
  sources: [
    { repo: "splay-react", rule: "pack-no-buildinfo", doc: "package.json (files, 1.0.2)" },
    { repo: "splay", rule: "pack-no-buildinfo", doc: "package.json (files)" },
    { repo: "cue", rule: "pack-no-buildinfo", doc: "npm/package/ts.cue (files, 2.1.3)" },
  ],
  options: {},
  failsFrom: "2026-11-25",
  check(context) {
    const breaks: Break[] = [];
    const unread: string[] = [];
    // The root is a published package also when the workspace has packages (splay-react and its private site)
    const all = [context.rootPackage, ...codePackages(context)];
    for (const pkg of all.filter((item, index) => all.findIndex((other) => other.file === item.file) === index)) {
      if (pkg.manifest["private"] === true) continue;
      const name = String(pkg.manifest["name"] ?? pkg.folder);
      const seen = new Set<string>();
      for (const config of readdirSync(pkg.dir).filter((file) => TSCONFIG.test(file)).sort()) {
        const found = buildInfoFile(join(pkg.dir, config));
        if (found === undefined) {
          unread.push(`${pkg.folder === "" ? "" : `${pkg.folder}/`}${config}`);
          continue;
        }
        if (found === null) continue;
        const path = relative(pkg.dir, found).replace(/\\/g, "/");
        // npm never packs a path outside the folder, or in node_modules
        if (path === "" || path.startsWith("../") || isAbsolute(path) || path.split("/").includes("node_modules") || seen.has(path)) continue;
        seen.add(path);
        const files = pkg.manifest["files"];
        const line = lineOf(pkg.text, '"files"');
        if (!Array.isArray(files)) {
          breaks.push({
            file: pkg.file,
            message: `${name} has no field "files", so npm packs ${path}, the build info file of ${config}.`,
            fix: `Give ${name} the field "files" with the folders that it publishes, and "!${path}".`,
          });
          continue;
        }
        const index = packedBy(files, path);
        if (index < 0) continue;
        // The negation after the entry stops the pack, except after an entry that names the file: the first decides
        const negated = [...files.slice(0, index + 1), `!${path}`, ...files.slice(index + 1)];
        const negationStops = packedBy(negated, path) < 0;
        const after = negationStops ? withNegation(pkg, index, `!${path}`) : undefined;
        const fix = negationStops
          ? `Add "!${path}" after "${String(files[index])}" in "files".`
          : `Remove the entry "${String(files[index])}" of "files": it names ${path}.`;
        breaks.push({
          file: pkg.file,
          ...(line === undefined ? {} : { line }),
          message: `npm packs ${path}, the build info file of ${config}, by the entry "${String(files[index])}" of "files" of ${name}.`,
          ...(after === undefined ? { fix } : { edits: [{ file: pkg.file, before: pkg.text, after }] }),
        });
      }
    }
    if (breaks.length === 0 && unread.length > 0) return { skipped: `The rule cannot read the extends chain of ${unread.join(", ")}. Install the dependencies.` };
    return breaks;
  },
};
