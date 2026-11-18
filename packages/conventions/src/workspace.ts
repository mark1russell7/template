/**
 * The package folders of a repository: the folders that the globs of the workspace name, with a
 * `package.json` file. This file is the one home of this code. The subpath
 * `@mark1russell7/conventions/workspace` exports it, and `@mark1russell7/api-report` imports it from there.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { globToRegExp, isGlob } from "@mark1russell7/files/glob";

/** This function compares two strings by their code units, as the default sort does. */
export const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** This function gives a path relative to `root`, with `/`. */
export const relativePath = (root: string, file: string): string => relative(root, file).split(sep).join("/");

/**
 * The function `globToRegExp` of `@mark1russell7/files`, the home of the globs. Before 0.47.0, conventions had a copy of
 * its own, which read `[` and `]` as text and threw on a `{` with no `}`.
 */
export { globToRegExp };

/** This function removes the `/` characters at the end of a path, with a loop in place of a regular expression. */
function trimEndSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charAt(end - 1) === "/") end -= 1;
  return path.slice(0, end);
}

/**
 * This function gives the folders under `root` that a glob names, as `/` paths relative to `root`,
 * in the order of the code units. It does not go into `node_modules` or a folder that starts with `.`.
 */
export function globFolders(root: string, glob: string): string[] {
  const clean = trimEndSlashes(glob.startsWith("./") ? glob.slice(2) : glob);
  const segments = clean.split("/");
  const firstPattern = segments.findIndex((segment) => isGlob(segment));
  if (firstPattern < 0) return existsSync(join(root, clean)) ? [clean] : [];
  const base = segments.slice(0, firstPattern).join("/");
  const depth = clean.includes("**") ? Number.POSITIVE_INFINITY : segments.length - firstPattern;
  const pattern = globToRegExp(clean);
  const start = join(root, base);
  if (!existsSync(start)) return [];
  const found: string[] = [];
  const walk = (folder: string, level: number): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(folder, entry.name);
      if (pattern.test(relativePath(root, path))) found.push(relativePath(root, path));
      if (level < depth) walk(path, level + 1);
    }
  };
  // `a/**` also names `a`
  if (base !== "" && pattern.test(base)) found.push(base);
  walk(start, 1);
  return found.sort(byCode);
}

/**
 * This function removes a comment at the end of a line of YAML: the first `#` after a space, and the text after it.
 * The caller trims the spaces before it. A search for one space and a `#` takes linear time on each text.
 */
function stripComment(text: string): string {
  const at = text.search(/\s#/);
  return at < 0 ? text : text.slice(0, at);
}

/** This function removes a comment at the end of a YAML value, the spaces and the quotes around it. */
function unquote(text: string): string {
  const value = stripComment(text).trim();
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

/**
 * This function gives the `packages` list of the text of a `pnpm-workspace.yaml` file, or undefined when the file has
 * no key `packages`. It reads a block list (also at the column of the key) and a flow list on one or more lines. It
 * throws on each other form, because a list that it reads in part names too few packages.
 */
export function parseWorkspaceGlobs(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (start < 0) return undefined;
  const rest = stripComment((lines[start] ?? "").replace(/^packages\s*:/, "")).trim();
  if (rest.startsWith("[")) {
    let flow = rest;
    for (let index = start + 1; !flow.includes("]"); index++) {
      if (index >= lines.length) throw new Error('The list packages of pnpm-workspace.yaml has no "]"');
      flow += ` ${stripComment(lines[index] ?? "")}`;
    }
    const close = flow.indexOf("]");
    if (flow.slice(close + 1).trim() !== "") throw new Error(`The list packages of pnpm-workspace.yaml has text after its "]": ${flow}`);
    return flow
      .slice(1, close)
      .split(",")
      .map(unquote)
      .filter((glob) => glob !== "");
  }
  if (rest !== "") throw new Error(`The key packages of pnpm-workspace.yaml is not a list: ${rest}`);
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s*-\s(.+)$/.exec(line);
    if (item) {
      globs.push(unquote(item[1] ?? ""));
      continue;
    }
    // A line at the column of the key starts the next key. An indented line that is not an item is a form that this
    // function does not read.
    if (!/^\s/.test(line)) break;
    throw new Error(`A line of the list packages of pnpm-workspace.yaml is not an item: ${line.trim()}`);
  }
  return globs;
}

/** The folders that pnpm does not take as packages of a workspace: the default ignore of its search for packages. */
const IGNORED_FOLDERS = new Set(["node_modules", "bower_components", "test", "tests"]);

/**
 * This function tells if a folder is a package folder of the workspace globs, as in pnpm. The folder is a `/` path
 * relative to the root, or `.` for the root. A glob matches it, and no `!` glob matches it. No part of it starts with
 * `.` or is a folder of the default ignore of pnpm. The function does not look for a `package.json` file.
 */
export function isWorkspaceFolder(folder: string, globs: readonly string[]): boolean {
  if (folder.split("/").some((part) => (part !== "." && part.startsWith(".")) || IGNORED_FOLDERS.has(part))) return false;
  const matches = (glob: string): boolean => globToRegExp(trimEndSlashes(glob.startsWith("./") ? glob.slice(2) : glob)).test(folder);
  return globs.some((glob) => !glob.startsWith("!") && matches(glob)) && !globs.some((glob) => glob.startsWith("!") && matches(glob.slice(1)));
}

/**
 * This function gives the globs of the workspace at `root`: the `packages` list of
 * `pnpm-workspace.yaml`, then the `workspaces` field of `package.json`. The result is undefined when
 * the repository has no workspace.
 */
export function workspaceGlobs(root: string): string[] | undefined {
  const yaml = join(root, "pnpm-workspace.yaml");
  if (existsSync(yaml)) {
    const globs = parseWorkspaceGlobs(readFileSync(yaml, "utf8"));
    if (globs !== undefined) return globs;
  }
  const manifestFile = join(root, "package.json");
  if (existsSync(manifestFile)) {
    const { workspaces } = JSON.parse(readFileSync(manifestFile, "utf8")) as { workspaces?: unknown };
    if (Array.isArray(workspaces)) return workspaces.filter((glob): glob is string => typeof glob === "string");
    if (typeof workspaces === "object" && workspaces !== null && "packages" in workspaces && Array.isArray(workspaces.packages)) {
      return workspaces.packages.filter((glob): glob is string => typeof glob === "string");
    }
  }
  return undefined;
}

/**
 * This function gives the package folders of the repository at `root`: the folders of the globs
 * that have a `package.json` file. A glob that starts with `!` removes folders, and so does the default ignore of pnpm
 * (`isWorkspaceFolder`). Without globs, the function reads the globs of the workspace, and a repository with no
 * workspace is one package. The result has absolute paths, in the order of the code units.
 */
export function packageFolders(root: string, globs: readonly string[] | undefined = workspaceGlobs(root)): string[] {
  if (globs === undefined) return existsSync(join(root, "package.json")) ? [root] : [];
  const found = new Set<string>();
  for (const glob of globs.filter((item) => !item.startsWith("!"))) for (const folder of globFolders(root, glob)) found.add(folder);
  // As in pnpm, a `!` glob removes its folders in each position of the list
  return [...found]
    .filter((folder) => isWorkspaceFolder(folder, globs) && existsSync(join(root, folder, "package.json")))
    .sort(byCode)
    .map((folder) => join(root, folder));
}

/**
 * This function gives the folders of the reports when the command names no folder. With `globs`, these are the package
 * folders of the globs. Without `globs`, these are the package folders of the workspace, and also the root when its
 * package is public and the globs leave it out. A repository can publish its root and keep a private site in its
 * workspace. The result has absolute paths, in the order of the code units.
 */
export function reportFolders(root: string, globs?: readonly string[]): string[] {
  if (globs !== undefined) return packageFolders(root, globs);
  const folders = packageFolders(root);
  const top = resolve(root);
  const manifest = join(top, "package.json");
  if (workspaceGlobs(root) === undefined || !existsSync(manifest) || folders.some((folder) => resolve(folder) === top)) return folders;
  let isPrivate = false;
  try {
    isPrivate = (JSON.parse(readFileSync(manifest, "utf8")) as { private?: unknown }).private === true;
  } catch {
    // The run reads the file again and tells the error of the root
  }
  return isPrivate ? folders : [top, ...folders];
}
