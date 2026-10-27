/**
 * The entries of a package for its report: the subpaths of the `exports` field (or `types` and
 * `main`), each with its declaration file, and the bins.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** The fields of a `package.json` file that the report reads. */
export interface Manifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly exports?: unknown;
  readonly imports?: unknown;
  readonly types?: unknown;
  readonly typings?: unknown;
  readonly main?: unknown;
  readonly bin?: unknown;
  readonly publishConfig?: Readonly<Record<string, unknown>>;
  readonly [field: string]: unknown;
}

/** A file that an entry without a declaration file exports: the subpath and the path of the file. */
export interface EntryFile {
  /** The subpath that a consumer imports, for example `./tsconfig/base.json`. */
  readonly subpath: string;
  /** The file, relative to the package folder, for example `./tsconfig/base.json`. */
  readonly path: string;
}

/** An entry of a package: a subpath and its declaration file, or a note when it has none. */
export interface Entry {
  /** The subpath of the `exports` field, for example `.` or `./client`. */
  readonly subpath: string;
  /** The declaration file, relative to the package folder, for example `./build/index.d.ts`. */
  readonly types?: string;
  /** This text tells why the entry has no declaration file. */
  readonly note?: string;
  /** The files that an entry without a declaration file exports, in the order of the subpaths. A removed file changes the report. */
  readonly files?: readonly EntryFile[];
}

/** A command of the `bin` field of a package. */
export interface Bin {
  readonly name: string;
  readonly path: string;
}

/** The conditions of the `exports` field that a TypeScript consumer can use, in no order. */
const CONDITIONS = new Set(["types", "import", "node", "default", "require"]);

/**
 * The fields of `publishConfig` that pnpm puts in the published `package.json`. A source package of
 * the template has `main: ./src/index.ts`, and its `publishConfig` gives the built entries.
 */
export const PUBLISH_CONFIG_FIELDS: readonly string[] = ["bin", "main", "module", "exports", "imports", "types", "typings", "typesVersions", "browser"];

/** The order of the code units: the same on each machine, with no locale. */
export const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** This function gives a path relative to `root`, with `/`. */
export const relativePath = (root: string, file: string): string => relative(root, file).split(sep).join("/");

/** This function gives the manifest as pnpm publishes it: the fields of `publishConfig` replace the fields of the source. */
export function publishedManifest(manifest: Manifest): Manifest {
  const config = manifest.publishConfig;
  if (!config) return manifest;
  const result: Record<string, unknown> = { ...manifest };
  for (const field of PUBLISH_CONFIG_FIELDS) if (config[field] !== undefined) result[field] = config[field];
  return result;
}

/**
 * This function gives the declaration file of a JavaScript or declaration path: `a.js` gives
 * `a.d.ts`, and `a.mjs` gives `a.d.mts`. The result is undefined for a file of another kind.
 */
export function declarationPathOf(path: string): string | undefined {
  if (/\.d\.[mc]?ts$/.test(path)) return path;
  const js = /\.([mc]?)js$/.exec(path);
  if (js) return `${path.slice(0, -js[0].length)}.d.${js[1] ?? ""}ts`;
  return undefined;
}

/** This function matches `subpath` with the key `pattern` of an `exports` or `imports` field. It gives the part of the `*`. */
export function patternMatch(pattern: string, subpath: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === subpath ? "" : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (subpath.length < prefix.length + suffix.length || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) return undefined;
  return subpath.slice(prefix.length, subpath.length - suffix.length);
}

/**
 * This function gives the target of an `exports` value for a TypeScript consumer: the first known
 * condition, in the order of the object. The result is `null` for an excluded subpath, and undefined
 * when no condition fits.
 */
export function targetOf(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = targetOf(item);
      if (typeof target === "string") return target;
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const [condition, inner] of Object.entries(value)) {
      if (!CONDITIONS.has(condition)) continue;
      const target = targetOf(inner);
      if (target !== undefined) return target;
    }
  }
  return undefined;
}

/** This function gives the `exports` field as a map of subpaths. */
function subpathMap(exportsField: unknown): Record<string, unknown> {
  if (typeof exportsField !== "object" || Array.isArray(exportsField) || exportsField === null) return { ".": exportsField };
  const keys = Object.keys(exportsField);
  if (keys.length > 0 && keys.every((key) => !key.startsWith("."))) return { ".": exportsField };
  return exportsField as Record<string, unknown>;
}

/** This function gives each file under `dir`, relative to `root` with `/`, without `node_modules`. */
function filesUnder(root: string, dir: string): string[] {
  const start = join(root, dir);
  if (!existsSync(start) || !statSync(start).isDirectory()) return [];
  const found: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relativePath(root, path));
    }
  };
  walk(start);
  return found.sort(byCode);
}

/**
 * This function gives each file under `root` that the target pattern `target` of the subpath
 * pattern `subpath` matches. Each file has its subpath, in the order of the subpaths. The function
 * skips each subpath that `isExcluded` excludes.
 */
function patternFiles(root: string, subpath: string, target: string, isExcluded: (subpath: string) => boolean): EntryFile[] {
  const pattern = target.replace(/^\.\//, "");
  const folder = pattern.slice(0, pattern.indexOf("*")).replace(/[^/]*$/, "");
  const matched: EntryFile[] = [];
  for (const file of filesUnder(root, folder)) {
    const part = patternMatch(pattern, file);
    if (part === undefined) continue;
    const expanded = subpath.split("*").join(part);
    if (!isExcluded(expanded)) matched.push({ subpath: expanded, path: `./${file}` });
  }
  return matched.sort((a, b) => byCode(a.subpath, b.subpath) || byCode(a.path, b.path));
}

/** This function gives an entry without a declaration file, with the files that it exports. */
function fileEntry(subpath: string, note: string, files: readonly EntryFile[]): Entry {
  return files.length > 0 ? { subpath, note, files } : { subpath, note };
}

/**
 * This function gives the entries of a package, in the order of the `exports` field. The
 * `./package.json` entry is not part of the API. A subpath pattern (`./*`) gives one entry for each
 * declaration file that it matches. An entry without a declaration file (for example a JSON or CSS
 * file) lists the files that it exports. `root` is the package folder.
 */
export function entriesOf(manifest: Manifest, root: string): Entry[] {
  const entries: Entry[] = [];
  const exists = (path: string): boolean => existsSync(resolve(root, path));
  if (manifest.exports === undefined) {
    // No `exports` field: TypeScript reads `types`, `typings`, then the declaration of `main`
    const field = manifest.types ?? manifest.typings;
    if (typeof field === "string") return [{ subpath: ".", types: field }];
    const main = typeof manifest.main === "string" ? manifest.main : "./index.js";
    const types = declarationPathOf(main);
    if (types && exists(types)) return [{ subpath: ".", types }];
    if (typeof manifest.main === "string") return [{ subpath: ".", note: `no declaration file for main ${manifest.main}` }];
    return [];
  }
  const map = subpathMap(manifest.exports);
  const excluded = Object.entries(map)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  const isExcluded = (subpath: string): boolean => excluded.some((pattern) => patternMatch(pattern, subpath) !== undefined);
  for (const [subpath, value] of Object.entries(map)) {
    if (subpath === "./package.json" || value === null) continue;
    const target = targetOf(value);
    if (typeof target !== "string") {
      entries.push({ subpath, note: "no condition for a TypeScript consumer" });
      continue;
    }
    const declared = declarationPathOf(target);
    const own = (path: string): EntryFile[] => (exists(path) ? [{ subpath, path }] : []);
    if (!subpath.includes("*")) {
      if (isExcluded(subpath)) continue;
      if (!declared) entries.push(fileEntry(subpath, `no declaration file for ${target}`, own(target)));
      // A JavaScript file without a declaration file has no types. A missing build throws later.
      else if (declared !== target && !exists(declared) && exists(target)) entries.push(fileEntry(subpath, `no declaration file for ${target}`, own(target)));
      else entries.push({ subpath, types: declared });
      continue;
    }
    if (!declared?.includes("*")) {
      // A pattern of files that are not declarations, for example `./tsconfig/*.json`
      const files = target.includes("*") ? patternFiles(root, subpath, target, isExcluded) : [];
      const note = files.length === 0 && target.includes("*") ? `no file matches ${target}` : `no declaration pattern for ${target}`;
      entries.push(fileEntry(subpath, note, files));
      continue;
    }
    const matched = patternFiles(root, subpath, declared, isExcluded).map((file): Entry => ({ subpath: file.subpath, types: file.path }));
    if (matched.length === 0) entries.push({ subpath, note: `no file matches ${declared}` });
    entries.push(...matched);
  }
  return entries;
}

/** This function gives the commands of the `bin` field, in name order. A string `bin` has the name of the package without its scope. */
export function binsOf(manifest: Manifest): Bin[] {
  const { bin } = manifest;
  if (typeof bin === "string") return [{ name: (manifest.name ?? "").replace(/^@[^/]+\//, ""), path: bin }];
  if (typeof bin !== "object" || bin === null) return [];
  return Object.entries(bin)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, path]) => ({ name, path }))
    .sort((a, b) => byCode(a.name, b.name));
}
