/**
 * The rule `release-files`: a pull request changes a file of the release flow only with a reason
 * that everyone can see.
 */
import { existsSync, readFileSync } from "node:fs";
import { matchesAny, type Break, type Rule, type RuleContext } from "../rule.ts";

/** The range of commits that the rule examines. */
interface Range {
  /** The arguments of `git diff --name-only` that give the changed files. */
  readonly diff: readonly string[];
  /** The arguments of `git log` that give the commit messages. */
  readonly log: readonly string[];
}

/** This function gives the range of the change: the option `--base`, or the merge commit of a pull request. */
function rangeOf(context: RuleContext): Range | { readonly skipped: string } {
  if (context.base !== undefined) {
    if (context.git(["rev-parse", "--verify", "--quiet", `${context.base}^{commit}`]) === undefined) return { skipped: `git does not know the base ${context.base}` };
    return { diff: [`${context.base}...HEAD`], log: [`${context.base}..HEAD`] };
  }
  const event = context.env["GITHUB_EVENT_NAME"];
  if (event !== "pull_request" && event !== "pull_request_target") return { skipped: "no base: the rule runs on a pull request, or with --base <ref>" };
  // The checkout of a pull request is a merge commit: its first parent is the base, its second parent the head
  const parents = context.git(["rev-list", "--parents", "-n", "1", "HEAD"])?.trim().split(/\s+/) ?? [];
  if (parents.length !== 3) return { skipped: "HEAD is not the merge commit of the pull request" };
  if (context.git(["cat-file", "-e", "HEAD^1^{commit}"]) === undefined) return { skipped: "the checkout has no parent of HEAD: set fetch-depth to 2 or more" };
  return { diff: ["HEAD^1", "HEAD"], log: ["HEAD^1..HEAD"] };
}

/** This function gives the body of the pull request from the event file of GitHub Actions, or an empty string. */
function pullRequestBody(context: RuleContext): string {
  const file = context.env["GITHUB_EVENT_PATH"];
  if (file === undefined || file === "" || !existsSync(file)) return "";
  try {
    const event = JSON.parse(readFileSync(file, "utf8")) as { pull_request?: { body?: unknown } };
    return typeof event.pull_request?.body === "string" ? event.pull_request.body : "";
  } catch {
    return "";
  }
}

/** This function escapes the special characters of a regular expression. */
const escape = (text: string): string => text.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");

export const releaseFiles: Rule = {
  id: "release-files",
  title: "A pull request changes `.github/workflows/release.yml` or `scripts/release/` only with a `Release-Edit: <reason>` line.",
  reason:
    "The release flow publishes to npm with trusted publishing. A change of its files by a session that does not own the release can stop or break each release.",
  fix: "Revert the change of the release files. When the owner asked for the change, add the line `Release-Edit: <reason>` to the last commit message or to the body of the pull request.",
  sources: [
    { repo: "coeval", rule: "no-release-edit", doc: "CLAUDE.md:40" },
    { repo: "coeval", rule: "no-release-edits", doc: "CLAUDE.md:40" },
    { repo: "crawler", rule: "no-release-edit", doc: "CLAUDE.md:80" },
    { repo: "crawler", rule: "no-release-edits", doc: "CLAUDE.md:80" },
    { repo: "headroom", rule: "no-release-edits", doc: "CLAUDE.md:37" },
    { repo: "headroom", rule: "release-files-frozen", doc: "CLAUDE.md:37" },
  ],
  options: {
    paths: { type: "strings", default: [".github/workflows/release.yml", "scripts/release/**"], description: "The globs of the files that the release flow owns." },
    trailer: { type: "string", default: "Release-Edit", description: "The key of the line that gives the reason of a change." },
    authors: {
      type: "strings",
      default: ["mark1russell7-release-train[bot]"],
      description: "The authors of the release flow. A change of the release files in commits of only these authors (the sync of the template) needs no reason.",
    },
  },
  check(context, options) {
    const range = rangeOf(context);
    if ("skipped" in range) return range;
    const globs = Array.isArray(options["paths"]) ? options["paths"] : [];
    const changed = (context.git(["diff", "--name-only", ...range.diff]) ?? "")
      .split(/\r?\n/)
      .filter((file) => file !== "" && matchesAny(file, globs));
    if (changed.length === 0) return [];
    const trailer = typeof options["trailer"] === "string" ? options["trailer"] : "Release-Edit";
    const line = new RegExp(`^${escape(trailer)}:[ \\t]*\\S`, "im");
    const messages = context.git(["log", "--no-merges", "--format=%B", ...range.log]) ?? "";
    if (line.test(messages) || line.test(pullRequestBody(context))) return [];
    const authors = new Set(Array.isArray(options["authors"]) ? options["authors"] : []);
    const changers = (context.git(["log", "--no-merges", "--format=%an", ...range.log, "--", ...changed]) ?? "").split(/\r?\n/).filter((name) => name !== "");
    if (changers.length > 0 && changers.every((name) => authors.has(name))) return [];
    return changed.map((file): Break => ({ file, message: `The change edits ${file}, a file of the release flow, with no "${trailer}: <reason>" line.` }));
  },
};
