/**
 * A small glob for the changelog files. The syntax has `*` and `?` in one path segment, and `**` for
 * zero or more folders.
 */

import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

function segmentPattern(segment: string): RegExp {
  const source = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${source}$`);
}

const SKIP = new Set(["node_modules", ".git"]);

/**
 * This function gives the files under `root` that match a pattern, as paths with `/` that start at
 * `root`, sorted. It does not go into `node_modules` or `.git`.
 */
export function globFiles(root: string, pattern: string): string[] {
  const segments = pattern.replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter(Boolean);
  const found = new Set<string>();
  const walk = (dir: string, prefix: string, index: number): void => {
    const segment = segments[index];
    if (segment === undefined) return;
    const last = index === segments.length - 1;
    if (segment === "**") {
      walk(dir, prefix, index + 1);
      for (const entry of safeList(dir)) {
        if (entry.isDirectory() && !SKIP.has(entry.name)) walk(join(dir, entry.name), `${prefix}${entry.name}/`, index);
      }
      return;
    }
    if (!/[*?]/.test(segment)) {
      const path = join(dir, segment);
      if (!existsSync(path)) return;
      if (last) {
        if (statSync(path).isFile()) found.add(`${prefix}${segment}`);
      } else if (statSync(path).isDirectory()) {
        walk(path, `${prefix}${segment}/`, index + 1);
      }
      return;
    }
    const matcher = segmentPattern(segment);
    for (const entry of safeList(dir)) {
      if (!matcher.test(entry.name) || SKIP.has(entry.name)) continue;
      if (last && entry.isFile()) found.add(`${prefix}${entry.name}`);
      else if (!last && entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`, index + 1);
    }
  };
  walk(root, "", 0);
  return [...found].sort();
}

function safeList(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
