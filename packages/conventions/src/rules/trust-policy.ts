/**
 * The rule `trust-policy`: a pnpm repository sets `trustPolicy: no-downgrade` in `pnpm-workspace.yaml`. It checks each
 * version for 7 days after its publish (`trustPolicyIgnoreAfter`). It excludes the scopes of the release train.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasFile, type Break, type Edit, type Rule } from "../rule.ts";

const WORKSPACE = "pnpm-workspace.yaml";

/** The scopes that the release train updates. The train checks the provenance of their versions itself. */
export const TRAIN_SCOPES = ["@mark1russell7/*", "@procedures/*"] as const;

/** 7 days, in minutes. */
export const IGNORE_AFTER = 10_080;

const POLICY_COMMENT = [
  "# An install fails when a new version has less trust evidence than an earlier version of the same package: for",
  "# example, a version with no provenance after versions from a trusted publisher. Such a version can be a stolen token.",
];
const IGNORE_COMMENT = [
  "# The check examines the versions of the last 7 days. A stolen-token version is new, and the registry removes it in",
  "# hours. Older versions can have less evidence for other reasons: for example undici-types 6.21.0 under @types/node.",
];
const EXCLUDE_COMMENT = [
  "# The release train updates our own scopes, and it checks the provenance of each version. pnpm cannot use them: it",
  "# ranks the first versions, which were staged by hand, above the versions from release.yml (pnpm/pnpm#16689).",
];

/** A top-level key of the file: its line index, and its value without a comment or quotes. */
function valueOf(lines: readonly string[], key: string): { index: number; value: string } | undefined {
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index < 0) return undefined;
  const value = (lines[index] ?? "").slice(key.length + 1).replace(/\s+#.*$/, "").trim();
  return { index, value: value.replace(/^["']|["']$/g, "") };
}

/** This function gives the items of the block list under the line `start`, the index of its last item, and its indent. */
function blockList(lines: readonly string[], start: number): { items: string[]; last: number; indent: string } {
  const items: string[] = [];
  let last = start;
  let indent = "  ";
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    if (!text.startsWith("- ") || line === line.trimStart()) break;
    indent = line.slice(0, line.length - line.trimStart().length);
    items.push(text.slice(2).replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, ""));
    last = index;
  }
  return { items, last, indent };
}

/** This function gives the text with the lines `added` after the line `after` (-1: at the end), with the line ends of the text. */
function insert(text: string, after: number, added: readonly string[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (after >= 0) {
    lines.splice(after + 1, 0, ...added);
    return lines.join(eol);
  }
  // At the end: one empty line before the block, and one line end after it
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return [...lines, ...(lines.length > 0 ? [""] : []), ...added, ""].join(eol);
}

/** This function gives the text with the value of the top-level key on the line `index` replaced. */
function setValue(text: string, index: number, key: string, value: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  lines[index] = `${key}: ${value}`;
  return lines.join(eol);
}

export const trustPolicy: Rule = {
  id: "trust-policy",
  title: "A pnpm repository sets `trustPolicy: no-downgrade` for the versions of the last 7 days, and excludes the scopes of the release train.",
  reason:
    "A stolen npm token can publish a version with no provenance, and the next install takes it. With `no-downgrade`, pnpm refuses a version with less trust evidence than an earlier version. The release age of pnpm keeps out the versions of the last day; this check covers the next days. The release train updates our own scopes at once and checks their provenance itself.",
  fix: "Add `trustPolicy: no-downgrade`, `trustPolicyIgnoreAfter: 10080` and a `trustPolicyExclude` with the scopes of the option `exclude` to `pnpm-workspace.yaml`. `conventions fix` writes them.",
  sources: [{ repo: "private", rule: "trust-policy", doc: "docs/STRATEGY.md (2026-11-01, release age and trust policy)" }],
  options: {
    exclude: {
      type: "strings",
      default: [...TRAIN_SCOPES],
      description: "The patterns that `trustPolicyExclude` must have: the scopes whose versions the release train checks.",
    },
    ignoreAfter: {
      type: "number",
      default: IGNORE_AFTER,
      description: "The smallest `trustPolicyIgnoreAfter`, in minutes. A larger value checks more versions.",
    },
  },
  check(context, options) {
    if (!hasFile(context.root, "pnpm-lock.yaml")) return { skipped: "the repository has no pnpm-lock.yaml" };
    const exclude = Array.isArray(options["exclude"]) ? (options["exclude"] as readonly string[]) : TRAIN_SCOPES;
    const ignoreAfter = typeof options["ignoreAfter"] === "number" ? options["ignoreAfter"] : IGNORE_AFTER;
    const exists = hasFile(context.root, WORKSPACE);
    const text = exists ? readFileSync(join(context.root, WORKSPACE), "utf8") : "";
    const lines = text.split(/\r?\n/);
    const edit = (after: string): Edit[] => (after === text ? [] : [{ file: WORKSPACE, before: text, after }]);
    const at = (index: number | undefined) => (index === undefined ? {} : { line: index + 1 });
    const breaks: Break[] = [];

    const policy = valueOf(lines, "trustPolicy");
    if (policy?.value !== "no-downgrade") {
      breaks.push({
        file: WORKSPACE,
        ...at(policy?.index),
        message: policy === undefined ? `${exists ? WORKSPACE : "The repository"} does not set trustPolicy.` : `trustPolicy is "${policy.value}", not "no-downgrade".`,
        edits: edit(policy === undefined ? insert(text, -1, [...POLICY_COMMENT, "trustPolicy: no-downgrade"]) : setValue(text, policy.index, "trustPolicy", "no-downgrade")),
      });
    }

    const ignore = valueOf(lines, "trustPolicyIgnoreAfter");
    const minutes = ignore === undefined ? undefined : Number(ignore.value);
    if (minutes === undefined || !Number.isInteger(minutes) || minutes < ignoreAfter) {
      const after = ignore !== undefined ? setValue(text, ignore.index, "trustPolicyIgnoreAfter", String(ignoreAfter)) : policy !== undefined ? insert(text, policy.index, [...IGNORE_COMMENT, `trustPolicyIgnoreAfter: ${String(ignoreAfter)}`]) : text;
      breaks.push({
        file: WORKSPACE,
        ...at(ignore?.index),
        message:
          ignore === undefined
            ? `${WORKSPACE} does not set trustPolicyIgnoreAfter, so pnpm also refuses old versions that have less evidence for other reasons.`
            : `trustPolicyIgnoreAfter is ${ignore.value}, not a whole number of at least ${String(ignoreAfter)} minutes.`,
        // With no trustPolicy line, the edit waits for the next check, which places it under that line
        edits: edit(after),
      });
    }

    const start = lines.findIndex((line) => line.startsWith("trustPolicyExclude:"));
    const inline = start >= 0 && (valueOf(lines, "trustPolicyExclude")?.value ?? "") !== "";
    const list = start >= 0 && !inline ? blockList(lines, start) : { items: [], last: start, indent: "  " };
    const missing = exclude.filter((pattern) => !list.items.includes(pattern));
    if (missing.length > 0) {
      const items = missing.map((pattern) => `${list.indent}- ${JSON.stringify(pattern)}`);
      // The fix does not rewrite a list in the flow style ([a, b]): a person adds the patterns
      const after = inline ? text : start >= 0 ? insert(text, list.last, items) : policy === undefined ? text : insert(text, -1, [...EXCLUDE_COMMENT, "trustPolicyExclude:", ...items]);
      breaks.push({
        file: WORKSPACE,
        ...at(start >= 0 ? start : undefined),
        message: `trustPolicyExclude does not have ${missing.join(", ")}.`,
        edits: edit(after),
      });
    }
    return breaks;
  },
};
