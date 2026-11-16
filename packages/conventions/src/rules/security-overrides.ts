/**
 * The rule `security-overrides`: a repository whose lockfile has a bad path of `SHARED_OVERRIDES` sets the override of
 * pnpm for it. When the lockfile has no version of the parent of an override, the override ends, and the rule removes it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasFile, type Break, type Rule } from "../rule.ts";
import { yamlEntry } from "./published-minor.ts";

const WORKSPACE = "pnpm-workspace.yaml";
const LOCKFILE = "pnpm-lock.yaml";

/** A shared override of pnpm, as data. */
export interface SharedOverride {
  /** The parent of the selector `parent>child`. The override changes the child only under the parent. */
  readonly parent: string;
  /** The child of the selector `parent>child`. */
  readonly child: string;
  /** The range that the override writes. */
  readonly range: string;
  /**
   * The lowest version of the child with no advisory. Its dependencies also admit no version with an advisory. A child
   * under the parent below this version is a bad path.
   */
  readonly fixed: string;
  /** The advisories that the override closes. */
  readonly advisories: readonly string[];
  /** The change upstream that removes the parent from the lockfile. Then the override ends. */
  readonly end: string;
}

/**
 * The shared overrides. The package glob 10 under archiver-utils 5 has GHSA-3g3m-2fjr-6pw4. Its minimatch 9 has
 * GHSA-g3hv-75wg-m249. The version glob 14.0.2 fixes glob. The version 14.0.3 is the first that asks for a fixed
 * minimatch (`^11.0.2`).
 */
export const SHARED_OVERRIDES: readonly SharedOverride[] = [
  {
    parent: "archiver-utils",
    child: "glob",
    range: "^14.0.3",
    fixed: "14.0.3",
    advisories: ["GHSA-3g3m-2fjr-6pw4", "GHSA-g3hv-75wg-m249"],
    end: "archiver 8 has no archiver-utils, so the override ends when testcontainers accepts archiver 8",
  },
];

/** This function gives the selector of an override: `parent>child`. */
export const selectorOf = (override: Pick<SharedOverride, "parent" | "child">): string => `${override.parent}>${override.child}`;

/** This function removes the quotes around a key or a value of YAML. */
const unquoted = (text: string): string => text.trim().replace(/^(['"])(.*)\1$/, "$2");

/** This function gives the parts of a release version, or undefined for other text. It cuts the peer suffix `(...)`. */
function partsOf(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:$|\()/.exec(version.trim());
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** This function tells if the release version `version` is below the version `fixed`. It gives false for other text. */
export function isBelow(version: string, fixed: string): boolean {
  const have = partsOf(version);
  const want = partsOf(fixed);
  if (have === undefined || want === undefined) return false;
  for (let index = 0; index < 3; index++) {
    if ((have[index] ?? 0) !== (want[index] ?? 0)) return (have[index] ?? 0) < (want[index] ?? 0);
  }
  return false;
}

/**
 * This function reads the `snapshots` of each document of the text of a `pnpm-lock.yaml` file. It gives the count of
 * the snapshots of `parent`, and the version of `child` in the dependencies of each of them.
 */
export function childVersions(text: string, parent: string, child: string): { readonly parents: number; readonly versions: readonly string[] } {
  const versions: string[] = [];
  let parents = 0;
  let inside = false;
  let inParent = false;
  let inDependencies = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inside = line.trimEnd() === "snapshots:";
      inParent = false;
      continue;
    }
    if (!inside) continue;
    const entry = yamlEntry(line);
    if (entry === undefined) continue;
    const key = unquoted(entry.key);
    if (entry.indent === 2) {
      // The key of a snapshot is `name@version`, and the version can have a peer suffix
      inParent = key.startsWith(`${parent}@`) && /^\d/.test(key.slice(parent.length + 1));
      inDependencies = false;
      if (inParent) parents++;
    } else if (entry.indent === 4) {
      inDependencies = key === "dependencies" || key === "optionalDependencies";
    } else if (entry.indent === 6 && inParent && inDependencies && key === child) {
      versions.push(unquoted(entry.value));
    }
  }
  return { parents, versions };
}

/** The block `overrides` of `pnpm-workspace.yaml`: the index of its key, the index of its last line, and each entry. */
interface Block {
  readonly key: number;
  readonly last: number;
  readonly inline: boolean;
  readonly entries: ReadonlyMap<string, { readonly index: number; readonly value: string }>;
}

/** This function gives the block `overrides` of the lines of `pnpm-workspace.yaml`, or undefined when it has none. */
function overridesOf(lines: readonly string[]): Block | undefined {
  const key = lines.findIndex((line) => /^overrides:(\s|$)/.test(line));
  if (key < 0) return undefined;
  const rest = (lines[key] ?? "").slice("overrides:".length).replace(/\s+#.*$/, "").trim();
  const entries = new Map<string, { index: number; value: string }>();
  let last = key;
  for (let index = key + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\S/.test(line)) break;
    const entry = yamlEntry(line);
    if (entry !== undefined) entries.set(unquoted(entry.key), { index, value: unquoted(entry.value.replace(/\s+#.*$/, "")) });
    last = index;
  }
  return { key, last, inline: rest !== "", entries };
}

/** This function gives the comment and the line of an override, with the indent `indent`. */
const overrideLines = (override: SharedOverride, indent: string): string[] => [
  `${indent}# ${override.advisories.join(" and ")}. The rule security-overrides of conventions removes this line at its end.`,
  `${indent}"${selectorOf(override)}": "${override.range}"`,
];

/** This function tells if a line is the comment that `overrideLines` writes. */
const isOwnComment = (line: string): boolean => line.trimStart().startsWith("#") && line.includes("The rule security-overrides of conventions");

export const securityOverrides: Rule = {
  id: "security-overrides",
  title: "A lockfile with a bad path of a shared override has the override of pnpm, and an override with no parent in the lockfile goes.",
  reason:
    "An advisory deep in the tree, for example glob 10 under archiver-utils, waits for each package on its path to release. The override of pnpm closes it in one line. Each repository wrote that line by hand, and no line said when it ends. A data list keeps one range for each repository, and the lockfile tells when the override ends.",
  fix: "Add the override of `SHARED_OVERRIDES` to `overrides` in `pnpm-workspace.yaml`, then start `pnpm install` and commit the lockfile. Remove an override whose parent is not in the lockfile. `conventions fix` edits `pnpm-workspace.yaml`.",
  sources: [
    { repo: "netdiag", rule: "security-overrides", doc: "netdiag #37 (2026-11-15): the override archiver-utils>glob for GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249" },
    { repo: "systems", rule: "security-overrides", doc: "systems #557 (2026-11-15): the same override, written by hand" },
    { repo: "private", rule: "security-overrides", doc: "a private repository (2026-11-16): glob 10.5.0 under archiver-utils 5.0.2 in its lockfile, with no override" },
  ],
  options: {},
  failsFrom: "2026-11-30",
  check(context) {
    if (!hasFile(context.root, LOCKFILE)) return { skipped: "the repository has no pnpm-lock.yaml" };
    const lock = readFileSync(join(context.root, LOCKFILE), "utf8");
    // A lockfile before version 9 has no snapshots, so each parent looks absent and each override looks ended
    const format = /^lockfileVersion:\s*['"]?(\d+)/m.exec(lock);
    if (format === null || Number(format[1]) < 9) return { skipped: "pnpm-lock.yaml is not a lockfile of version 9 or later" };
    const exists = hasFile(context.root, WORKSPACE);
    const text = exists ? readFileSync(join(context.root, WORKSPACE), "utf8") : "";
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const block = overridesOf(lines);
    const breaks: Break[] = [];
    for (const override of SHARED_OVERRIDES) {
      const selector = selectorOf(override);
      const found = childVersions(lock, override.parent, override.child);
      const bad = found.versions.filter((version) => isBelow(version, override.fixed));
      const own = block?.entries.get(selector);
      if (bad.length > 0 && own === undefined) {
        const message = `${LOCKFILE} has ${override.child} ${[...new Set(bad)].join(", ")} under ${override.parent} (${override.advisories.join(", ")}). Add the override "${selector}": "${override.range}" to ${WORKSPACE}, then start pnpm install.`;
        if (block?.inline === true) {
          breaks.push({ file: WORKSPACE, line: block.key + 1, message: `${message} The key overrides has an inline value, so a person writes the line.` });
          continue;
        }
        const after = [...lines];
        if (block === undefined) {
          while (after.length > 0 && after[after.length - 1] === "") after.pop();
          after.push(...(after.length > 0 ? [""] : []), "overrides:", ...overrideLines(override, "  "), "");
        } else {
          const first = [...block.entries.values()][0];
          const indent = first === undefined ? "  " : (lines[first.index] ?? "").slice(0, (lines[first.index] ?? "").length - (lines[first.index] ?? "").trimStart().length);
          after.splice(block.last + 1, 0, ...overrideLines(override, indent));
        }
        breaks.push({ file: WORKSPACE, ...(block === undefined ? {} : { line: block.key + 1 }), message, edits: [{ file: WORKSPACE, before: text, after: after.join(eol) }] });
      } else if (found.parents === 0 && own !== undefined && block !== undefined) {
        const after = [...lines];
        let start = own.index;
        while (start > 0 && isOwnComment(after[start - 1] ?? "")) start--;
        after.splice(start, own.index - start + 1);
        // An empty block goes with its key
        if (block.entries.size === 1 && !block.inline) {
          after.splice(block.key, 1);
          // The blank line above the key and the blank line below it become one
          if (block.key > 0 && after[block.key - 1] === "" && (after[block.key] ?? "") === "") after.splice(block.key, 1);
        }
        breaks.push({
          file: WORKSPACE,
          line: own.index + 1,
          message: `The override "${selector}" ends: ${LOCKFILE} has no ${override.parent}. Remove it (${override.end}).`,
          edits: [{ file: WORKSPACE, before: text, after: after.join(eol) }],
        });
      }
    }
    return breaks;
  },
};
