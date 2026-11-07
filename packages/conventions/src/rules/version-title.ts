/**
 * The rule `version-title`: a merge whose title names a version sets that version in a `package.json`.
 */
import { existsSync, readFileSync } from "node:fs";
import { rangeOf } from "../change.ts";
import type { Break, Rule, RuleContext } from "../rule.ts";

/** A version of SemVer, with an optional pre-release. */
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
/**
 * The places of a version in a title. The first place is in parentheses at the end, before the number of a squash, for
 * example `feat: a rule (0.3.3) (#212)`. The second place is after "Release" at the start, for example `Release 0.23.0`.
 */
const NAMED: readonly RegExp[] = [
  new RegExp(String.raw`\((${SEMVER})\)(?:\s*\(#\d+\))?\s*$`),
  new RegExp(String.raw`^(?:[a-z]+(?:\([^)]*\))?!?:\s*)?release v?(${SEMVER})\b`, "i"),
];

/** This function gives the versions that a title names, in their order, each one time. */
export function namedVersions(title: string): string[] {
  const found: string[] = [];
  for (const pattern of NAMED) {
    const version = pattern.exec(title)?.[1];
    if (version !== undefined && !found.includes(version)) found.push(version);
  }
  return found;
}

/** This function gives the version of a `package.json` at a commit, or undefined. */
function versionAt(context: RuleContext, commit: string, file: string): string | undefined {
  const text = context.git(["show", `${commit}:${file}`]);
  if (text === undefined) return undefined;
  try {
    const value = (JSON.parse(text) as { version?: unknown }).version;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** This function gives the versions that the change from `from` to `to` sets: each `package.json` whose version changes. */
export function setVersions(context: RuleContext, from: string, to: string): string[] | undefined {
  const out = context.git(["diff", "--name-only", "--no-renames", from, to, "--", "package.json", "**/package.json"]);
  if (out === undefined) return undefined;
  const versions: string[] = [];
  for (const file of out.split(/\r?\n/).filter((line) => line !== "")) {
    const after = versionAt(context, to, file);
    if (after !== undefined && after !== versionAt(context, from, file) && !versions.includes(after)) versions.push(after);
  }
  return versions;
}

/** This function gives the title of the pull request of the event file, or undefined. */
function pullRequestTitle(context: RuleContext): string | undefined {
  const file = context.env["GITHUB_EVENT_PATH"];
  if (file === undefined || file === "" || !existsSync(file)) return undefined;
  try {
    const title = (JSON.parse(readFileSync(file, "utf8")) as { pull_request?: { title?: unknown } }).pull_request?.title;
    return typeof title === "string" ? title : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This function gives the break of a title that names a version when the change sets no version, or undefined. A change
 * that sets an other version than its title gets a release, so it does not break.
 */
function breakOf(title: string, set: readonly string[], file: string, where: string): Break | undefined {
  const named = namedVersions(title);
  if (named.length === 0 || set.length > 0) return undefined;
  return {
    file,
    message: `${where} has the title "${title}", which names ${named.join(", ")}, but it sets no version. The release workflow starts only on a change of a version, so the change gets no release.`,
  };
}

export const versionTitle: Rule = {
  id: "version-title",
  title: "A merge whose title names a version, for example `(0.3.3)` or `Release 0.23.0`, sets a version in a `package.json`.",
  reason:
    "When two pull requests set the same version line, the second one merges with no conflict and changes no version. The release workflow starts only on a change of a version, so the change gets no release. Template #164 merged so on 2026-11-04, and #215 on 2026-11-06.",
  fix: "Set the next free version (SemVer) in a pull request, and correct the title. On a pull request, merge the base branch in first: the version that the title names is then the version that the merge sets.",
  sources: [
    { repo: "template", rule: "version-title", doc: "#212 (5933b34) and #215 (e077054), 2026-11-06: both set site-pages 0.3.3, and e077054 changed no package.json" },
    { repo: "template", rule: "version-title", doc: "#162 (9392d6e) and #164 (5b6d568), 2026-11-04: both set site-pages 0.2.5, and #166 released the change of #164 as 0.2.6" },
    { repo: "rigor", rule: "unreleased-change", doc: "pull requests #18 and #20 (2026-11-02): two pull requests set the same version" },
    ...["crawler", "coeval"].map((repo) => ({ repo, rule: "version-title", doc: ".github/workflows/release.yml (it starts on a push to main that changes a package.json)" })),
  ],
  options: {},
  check(context) {
    const event = context.env["GITHUB_EVENT_NAME"];
    if (context.base === undefined && (event === "pull_request" || event === "pull_request_target")) {
      // The checkout of a pull request is its merge with the base: HEAD^1 is the base, and the title is in the event file
      const title = pullRequestTitle(context);
      if (title === undefined) return { skipped: "the event file has no title of the pull request" };
      const range = rangeOf(context);
      if ("skipped" in range) return range;
      const set = setVersions(context, range.ends[0], "HEAD");
      if (set === undefined) return { skipped: "git cannot give the changed files of the pull request" };
      const found = breakOf(title, set, "package.json", "The pull request");
      return found === undefined ? [] : [found];
    }
    // A push, or a range of `--base`: each commit on the first-parent line, against its first parent
    const range = rangeOf(context, { push: true });
    if ("skipped" in range) return range;
    const out = context.git(["rev-list", "--first-parent", ...range.log]);
    if (out === undefined) return { skipped: "git cannot give the commits of the change" };
    const breaks: Break[] = [];
    for (const commit of out.split(/\r?\n/).filter((line) => line !== "")) {
      const title = context.git(["log", "-1", "--format=%s", commit])?.trim();
      if (title === undefined || namedVersions(title).length === 0) continue;
      if (context.git(["rev-parse", "--verify", "--quiet", `${commit}^1^{commit}`]) === undefined) continue;
      const set = setVersions(context, `${commit}^1`, commit);
      if (set === undefined) continue;
      const found = breakOf(title, set, "package.json", `The commit ${commit.slice(0, 7)}`);
      if (found !== undefined) breaks.push(found);
    }
    return breaks;
  },
};
