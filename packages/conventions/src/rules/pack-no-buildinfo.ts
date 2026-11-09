/**
 * The rule `pack-no-buildinfo`: npm does not pack the build info file of tsc. A public package that writes it in a
 * folder of its field `files` has the negation `!<path>` there.
 */
import { readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { buildInfoFile } from "../tsconfig.ts";
import { cleanPath, codePackages, lineOf, type Break, type PackageInfo, type Rule } from "../rule.ts";
import { globToRegExp } from "../workspace.ts";

/** The names of the tsconfig files of a package folder. */
const TSCONFIG = /^tsconfig(?:\.[\w-]+)?\.json$/;

/** This function tells if an entry of the field `files` (without `!`) takes the path: the path, a folder of it, or a glob. */
function entryTakes(entry: string, path: string): boolean {
  let clean = cleanPath(entry);
  // A loop, not a pattern: a pattern with a repeated slash at the end is slow on a long run of slashes
  while (clean.endsWith("/")) clean = clean.slice(0, -1);
  if (clean === "") return false;
  return path === clean || path.startsWith(`${clean}/`) || globToRegExp(clean).test(path);
}

/**
 * This function tells if npm packs `path` (relative to the package, with `/`) by the field `files`. A negation `!<glob>`
 * removes a path in each place of the list (npm 11 packs `["!a/b", "a"]` as `["a", "!a/b"]`). It gives the index of
 * the first entry that takes the path, or -1 when npm does not pack it.
 */
export function packedBy(files: readonly unknown[], path: string): number {
  const entries = files.filter((entry): entry is string => typeof entry === "string");
  if (entries.some((entry) => entry.startsWith("!") && entryTakes(entry.slice(1), path))) return -1;
  return files.findIndex((entry) => typeof entry === "string" && !entry.startsWith("!") && entryTakes(entry, path));
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
        const after = withNegation(pkg, index, `!${path}`);
        breaks.push({
          file: pkg.file,
          ...(line === undefined ? {} : { line }),
          message: `npm packs ${path}, the build info file of ${config}, by the entry "${String(files[index])}" of "files" of ${name}.`,
          ...(after === undefined ? { fix: `Add "!${path}" after "${String(files[index])}" in "files".` } : { edits: [{ file: pkg.file, before: pkg.text, after }] }),
        });
      }
    }
    if (breaks.length === 0 && unread.length > 0) return { skipped: `The rule cannot read the extends chain of ${unread.join(", ")}. Install the dependencies.` };
    return breaks;
  },
};
