/**
 * The change that a check examines: the option `--base`, the merge commit of a pull request, or a push to the default
 * branch. The rule release-files reads its changed files, and the runner reads the files that it adds.
 */
import { existsSync, readFileSync } from "node:fs";
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

/** The options of `rangeOf`. */
export interface RangeOptions {
  /**
   * When true, a push to the default branch also has a range: the commits of the push. The default is false, because
   * the body of a pull request and the files that it adds are not facts of a push.
   */
  readonly push?: boolean;
}

/** The facts of a push in the event file of GitHub Actions. */
interface PushEvent {
  readonly before?: unknown;
  readonly ref?: unknown;
  readonly repository?: { readonly default_branch?: unknown };
}

/** This function gives the range of the commits of a push to the default branch, from the event file of GitHub Actions. */
function pushRange(context: RuleContext): Range | { readonly skipped: string } {
  const file = context.env["GITHUB_EVENT_PATH"];
  let event: PushEvent | undefined;
  try {
    event = file === undefined || file === "" || !existsSync(file) ? undefined : (JSON.parse(readFileSync(file, "utf8")) as PushEvent);
  } catch {
    event = undefined;
  }
  if (event === undefined) return { skipped: "the push has no event file (GITHUB_EVENT_PATH)" };
  const branch = event.repository?.default_branch;
  if (typeof branch !== "string" || event.ref !== `refs/heads/${branch}`) return { skipped: "the push is not to the default branch: the pull request of the branch has the change" };
  const before = typeof event.before === "string" ? event.before : "";
  if (!/^[0-9a-f]{40,64}$/.test(before) || /^0+$/.test(before)) return { skipped: "the push has no commit before it" };
  if (context.git(["rev-parse", "--verify", "--quiet", `${before}^{commit}`]) === undefined) {
    return { skipped: `the checkout does not have ${before}, the commit before the push: fetch it, or set fetch-depth to 0` };
  }
  return { diff: [before, "HEAD"], log: [`${before}..HEAD`], ends: [before, "HEAD"] };
}

/**
 * This function gives the range of the change: the option `--base`, or the merge commit of a pull request. With the
 * option `push`, a push to the default branch gives the commits of the push: from the commit before the push to HEAD.
 */
export function rangeOf(context: RuleContext, options: RangeOptions = {}): Range | { readonly skipped: string } {
  if (context.base !== undefined) {
    if (context.git(["rev-parse", "--verify", "--quiet", `${context.base}^{commit}`]) === undefined) return { skipped: `git does not know the base ${context.base}` };
    return { diff: [`${context.base}...HEAD`], log: [`${context.base}..HEAD`], ends: [context.base, "HEAD"] };
  }
  const event = context.env["GITHUB_EVENT_NAME"];
  if (event === "push" && options.push === true) return pushRange(context);
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
