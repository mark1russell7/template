/**
 * The rule `release-files`: a pull request changes a file of the release flow only with a reason
 * that everyone can see.
 */
import { existsSync, readFileSync } from "node:fs";
import { rangeOf } from "../change.ts";
import { matchesAny, type Break, type Rule, type RuleContext } from "../rule.ts";

/** The facts of the pull request in the event file of GitHub Actions. */
interface PullRequest {
  /** The body, or an empty string. */
  readonly body: string;
  /** The number of commits, if the event file gives it. */
  readonly commits?: number;
}

/** This function gives the pull request of the event file of GitHub Actions. With no event file, the body is empty. */
function pullRequestOf(context: RuleContext): PullRequest {
  const file = context.env["GITHUB_EVENT_PATH"];
  if (file === undefined || file === "" || !existsSync(file)) return { body: "" };
  try {
    const event = JSON.parse(readFileSync(file, "utf8")) as { pull_request?: { body?: unknown; commits?: unknown } };
    const body = typeof event.pull_request?.body === "string" ? event.pull_request.body : "";
    const commits = event.pull_request?.commits;
    return typeof commits === "number" ? { body, commits } : { body };
  } catch {
    return { body: "" };
  }
}

/** This function escapes the special characters of a regular expression. */
const escape = (text: string): string => text.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");

export const releaseFiles: Rule = {
  id: "release-files",
  title: "A pull request changes `.github/workflows/release.yml` or `scripts/release/` only with a `Release-Edit: <reason>` line.",
  reason:
    "The release flow publishes to npm with trusted publishing. A change of its files by a session that does not own the release can stop or break each release.",
  fix: "Revert the change of the release files. When the owner asked for the change, add the line `Release-Edit: <reason>` to the last commit message or to the body of the pull request. A re-run of a job reads the body of the event that started the run, so after a change of the body, push a commit.",
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
    const pullRequest = pullRequestOf(context);
    if (line.test(pullRequest.body)) return [];
    // A shallow checkout can end inside the change: a commit at its end looks like a first commit, so it seems to change
    // each file, and the commits under it are not there. Then the authors and the messages are not those of the change.
    // A pull request of one commit is complete at depth 2, because its commit is the whole change.
    const single = pullRequest.commits === 1 && context.git(["rev-parse", "--verify", "--quiet", `${range.ends[1]}^2`]) === undefined;
    if (!single && context.git(["merge-base", ...range.ends]) === undefined) {
      throw new Error(
        `The checkout does not have the merge base of ${range.ends.join(" and ")}, so the rule cannot read each commit of the change. Use fetch-depth 0, or the CI of the template, which deepens the checkout of a pull request to its merge base.`,
      );
    }
    const messages = context.git(["log", "--no-merges", "--format=%B", ...range.log]) ?? "";
    if (line.test(messages)) return [];
    const authors = new Set(Array.isArray(options["authors"]) ? options["authors"] : []);
    const changers = (context.git(["log", "--no-merges", "--format=%an", ...range.log, "--", ...changed]) ?? "").split(/\r?\n/).filter((name) => name !== "");
    if (changers.length > 0 && changers.every((name) => authors.has(name))) return [];
    return changed.map((file): Break => ({ file, message: `The change edits ${file}, a file of the release flow, with no "${trailer}: <reason>" line.` }));
  },
};
