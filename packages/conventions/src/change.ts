/**
 * The change that a check examines: the option `--base`, or the merge commit of a pull request.
 * The rule release-files reads its changed files, and the runner reads the files that it adds.
 */
import type { RuleContext } from "./rule.ts";

/** The range of commits of the change. */
export interface Range {
  /** The arguments of `git diff --name-only` that give the changed files. */
  readonly diff: readonly string[];
  /** The arguments of `git log` that give the commit messages. */
  readonly log: readonly string[];
  /** The two ends of the change. The checkout must have their merge base, or `log` does not give each commit of the change. */
  readonly ends: readonly [string, string];
}

/** This function gives the range of the change: the option `--base`, or the merge commit of a pull request. */
export function rangeOf(context: RuleContext): Range | { readonly skipped: string } {
  if (context.base !== undefined) {
    if (context.git(["rev-parse", "--verify", "--quiet", `${context.base}^{commit}`]) === undefined) return { skipped: `git does not know the base ${context.base}` };
    return { diff: [`${context.base}...HEAD`], log: [`${context.base}..HEAD`], ends: [context.base, "HEAD"] };
  }
  const event = context.env["GITHUB_EVENT_NAME"];
  if (event !== "pull_request" && event !== "pull_request_target") return { skipped: "no base: the rule runs on a pull request, or with --base <ref>" };
  // The checkout of a pull request is a merge commit: its first parent is the base, its second parent the head
  const parents = context.git(["rev-list", "--parents", "-n", "1", "HEAD"])?.trim().split(/\s+/) ?? [];
  if (parents.length !== 3) return { skipped: "HEAD is not the merge commit of the pull request" };
  if (context.git(["cat-file", "-e", "HEAD^1^{commit}"]) === undefined) return { skipped: "the checkout has no parent of HEAD: set fetch-depth to 2 or more" };
  return { diff: ["HEAD^1", "HEAD"], log: ["HEAD^1..HEAD"], ends: ["HEAD^1", "HEAD^2"] };
}

/**
 * This function gives the files that the change adds, relative to the root, with `/`. A renamed file is not added.
 * With no change (no base and no pull request), it gives undefined.
 */
export function addedFiles(context: RuleContext): ReadonlySet<string> | undefined {
  const range = rangeOf(context);
  if ("skipped" in range) return undefined;
  const out = context.git(["diff", "--name-only", "--find-renames", "--diff-filter=A", ...range.diff]);
  if (out === undefined) return undefined;
  return new Set(out.split(/\r?\n/).filter((file) => file !== ""));
}

/**
 * This function gives the lines that the change adds, for each changed file: the numbers (from 1) of the new file.
 * A renamed file with no other change has no added lines. With no change (no base and no pull request), it gives undefined.
 */
export function addedLines(context: RuleContext): ReadonlyMap<string, ReadonlySet<number>> | undefined {
  const range = rangeOf(context);
  if ("skipped" in range) return undefined;
  const out = context.git(["diff", "--unified=0", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "--find-renames", "--diff-filter=AMR", ...range.diff]);
  if (out === undefined) return undefined;
  const lines = new Map<string, Set<number>>();
  let file: string | undefined;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? undefined : line.slice(6);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null || file === undefined) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    let set = lines.get(file);
    if (set === undefined) lines.set(file, (set = new Set()));
    for (let index = 0; index < count; index++) set.add(start + index);
  }
  return lines;
}
