/**
 * The package folders of a repository: the folders that the globs of the workspace name, with a
 * `package.json` file. This file is a copy of `workspace.ts` of `@mark1russell7/api-report`, so that
 * each tool has no runtime dependency.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** This function compares two strings by their code units, as the default sort does. */
export const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** This function gives a path relative to `root`, with `/`. */
export const relativePath = (root: string, file: string): string => relative(root, file).split(sep).join("/");

/** The characters that have a meaning in a regular expression. */
const SPECIAL = new Set([..."\\^$.|+()[]{}*?/"]);

/**
 * This function gives a regular expression for a glob of `/` paths. `*` matches a part of one path
 * segment, `?` matches one character, `**` matches zero or more segments, and `{a,b}` matches one of
 * its parts. The function escapes each other special character.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  let braces = 0;
  for (let index = 0; index < glob.length; index++) {
    const char = glob.charAt(index);
    if (char === "/" && glob.slice(index + 1) === "**") {
      // `a/**` matches `a` and each path under it
      source += "(?:/.*)?";
      break;
    }
    if (char === "*" && glob.charAt(index + 1) === "*") {
      const atStart = index === 0 || glob.charAt(index - 1) === "/";
      const after = glob.charAt(index + 2);
      if (atStart && after === "/") {
        // `**/` matches zero or more whole segments
        source += "(?:[^/]+/)*";
        index += 2;
      } else if (atStart && after === "") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
        index += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") {
      braces++;
      source += "(?:";
    } else if (char === "}" && braces > 0) {
      braces--;
      source += ")";
    } else if (char === "," && braces > 0) source += "|";
    else if (SPECIAL.has(char)) source += `\\${char}`;
    else source += char;
  }
  if (braces > 0) throw new Error(`A glob with a "{" that has no "}": ${glob}`);
  return new RegExp(`^${source}$`);
}

/** The characters that make a path segment a pattern. */
const GLOB_CHARS = /[*?{]/;

/**
 * This function gives the folders under `root` that a glob names, as `/` paths relative to `root`,
 * in the order of the code units. It does not go into `node_modules` or a folder that starts with `.`.
 */
export function globFolders(root: string, glob: string): string[] {
  const clean = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  const segments = clean.split("/");
  const firstPattern = segments.findIndex((segment) => GLOB_CHARS.test(segment));
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
 * This function gives the globs of the workspace at `root`: the `packages` list of
 * `pnpm-workspace.yaml`, then the `workspaces` field of `package.json`. The result is undefined when
 * the repository has no workspace.
 */
export function workspaceGlobs(root: string): string[] | undefined {
  const yaml = join(root, "pnpm-workspace.yaml");
  if (existsSync(yaml)) {
    const lines = readFileSync(yaml, "utf8").split(/\r?\n/);
    const start = lines.findIndex((line) => /^packages\s*:/.test(line));
    if (start >= 0) {
      const unquote = (text: string): string =>
        text
          .replace(/\s+#.*$/, "")
          .trim()
          .replace(/^["']|["']$/g, "");
      const inline = /^packages\s*:\s*\[(.*)\]/.exec(lines[start] ?? "");
      if (inline) return (inline[1] ?? "").split(",").map(unquote).filter(Boolean);
      const globs: string[] = [];
      for (const line of lines.slice(start + 1)) {
        if (/^\s*(#.*)?$/.test(line)) continue;
        const item = /^\s+-\s+(.+)$/.exec(line);
        if (!item) break;
        globs.push(unquote(item[1] ?? ""));
      }
      return globs;
    }
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
 * that have a `package.json` file. A glob that starts with `!` removes folders. Without globs, the
 * function reads the globs of the workspace, and a repository with no workspace is one package.
 * The result has absolute paths, in the order of the code units.
 */
export function packageFolders(root: string, globs: readonly string[] | undefined = workspaceGlobs(root)): string[] {
  if (globs === undefined) return existsSync(join(root, "package.json")) ? [root] : [];
  const included = new Set<string>();
  // As in pnpm, a `!` glob removes its folders in each position of the list
  for (const glob of globs.filter((item) => !item.startsWith("!"))) for (const folder of globFolders(root, glob)) included.add(folder);
  for (const glob of globs.filter((item) => item.startsWith("!"))) for (const folder of globFolders(root, glob.slice(1))) included.delete(folder);
  return [...included]
    .filter((folder) => existsSync(join(root, folder, "package.json")))
    .sort(byCode)
    .map((folder) => join(root, folder));
}
