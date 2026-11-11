// The plan of the release check of a pull request (.github/actions/release-check, CI.md "The release check").
//
//   node scripts/release/check-plan.ts
//
// The check starts the release build on the commit of a pull request: the build, pack.ts and tags.ts, as the build
// job of reusable-release-build.yml. Before the install, this script reads two facts of the repository (RELEASE_REPO):
//
//   run      false when the repository has no published package (workspace.ts). Then the release publishes
//            nothing, and the check passes at once, with a notice.
//   pending  In a repository with Changesets (.changeset/config.json), the packages whose version a pending
//            changeset raises: each package that a changeset names, and each member of a "fixed" group of such a
//            package. The version step of Changesets raises these versions later, so pack.ts (RELEASE_PENDING)
//            gives a note, not an error, for a shipped change of them. A shipped change of a different package at
//            a version on npm fails: no step raises its version. An empty changeset raises no version.
//
// The script writes "run", "pending" and "notice" to GITHUB_OUTPUT, and the notice to the log. A changeset that
// Changesets cannot read stops the check with an error: the version step fails on it too.

import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { globToRegExp, parseChangeset } from "../../.github/actions/changeset-check/check.ts";
import { publishedPackages, root } from "./workspace.ts";

/** The changesets that wait in a repository, and the packages whose version they raise. */
export interface PendingChangesets {
  readonly files: readonly string[];
  readonly raised: readonly string[];
}

/** The decision of the check, before the install. */
export interface Plan {
  readonly run: boolean;
  readonly pending: readonly string[];
  readonly notice: string;
}

/**
 * This function gives the packages that the changesets raise: each named package, and each member of a fixed group
 * that has a named package. A member of a group can be a glob (`@scope/*`), as in Changesets. The names are the
 * packages of the repository, for the globs.
 */
export function raisedPackages(
  releases: readonly Readonly<Record<string, string>>[],
  fixed: readonly (readonly string[])[],
  names: readonly string[],
): string[] {
  const named = new Set(releases.flatMap((release) => Object.keys(release)));
  const raised = new Set(named);
  for (const group of fixed) {
    const patterns = group.map(globToRegExp);
    const members = names.filter((name) => patterns.some((pattern) => pattern.test(name)));
    if (members.some((name) => named.has(name)) || group.some((entry) => named.has(entry))) {
      for (const name of members) raised.add(name);
    }
  }
  return [...raised].sort();
}

/**
 * This function reads the changesets that wait in a repository: each `.changeset/*.md` file other than `README.md`.
 * It gives undefined when the repository has no `.changeset/config.json`.
 */
export function pendingChangesets(repo: string, names: readonly string[]): PendingChangesets | undefined {
  const dir = join(repo, ".changeset");
  const configFile = join(dir, "config.json");
  if (!existsSync(configFile)) return undefined;
  const config = JSON.parse(readFileSync(configFile, "utf8")) as { readonly fixed?: unknown };
  const fixed = Array.isArray(config.fixed)
    ? config.fixed.filter(Array.isArray).map((group: unknown[]) => group.filter((entry): entry is string => typeof entry === "string"))
    : [];
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".md") && file.toLowerCase() !== "readme.md")
    .sort();
  const releases = files.map((file) => {
    try {
      return parseChangeset(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      throw new Error(`.changeset/${file}: ${error instanceof Error ? error.message : String(error)}. Changesets cannot read it.`);
    }
  });
  return { files: files.map((file) => `.changeset/${file}`), raised: raisedPackages(releases, fixed, names) };
}

/** This function gives a list of names for a notice: at most 10 names, then a count. */
function listNames(names: readonly string[]): string {
  return names.length > 10 ? `${names.slice(0, 10).join(", ")} and ${names.length - 10} more` : names.join(", ");
}

/** This function gives the plan of the release check of a repository. */
export function plan(repo: string): Plan {
  const packages = publishedPackages(repo);
  if (packages.length === 0) {
    return {
      run: false,
      pending: [],
      notice: "This repository has no published package, so its release publishes nothing. The release check passes.",
    };
  }
  const names = packages.map(({ manifest }) => manifest.name);
  const changesets = pendingChangesets(repo, names);
  if (changesets === undefined) return { run: true, pending: [], notice: "" };
  const pending = changesets.raised.filter((name) => names.includes(name));
  if (pending.length === 0) {
    return {
      run: true,
      pending,
      notice:
        "This repository uses Changesets, and no changeset raises a version. A shipped change at a version on npm fails the check. Add a changeset that names its package.",
    };
  }
  return {
    run: true,
    pending,
    notice:
      `This repository uses Changesets. ${changesets.files.length} pending changesets raise the version of ${pending.length} published packages later: ` +
      `${listNames(pending)}. A shipped change of these packages passes. A shipped change of a different package at a version on npm fails.`,
  };
}

/** This function writes the plan to GITHUB_OUTPUT and the notice to the log. It gives the exit code. */
export function main(repo: string = root, env: Readonly<Record<string, string | undefined>> = process.env): number {
  let result: Plan;
  try {
    result = plan(repo);
  } catch (error) {
    process.stdout.write(`::error title=Release check::${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (result.notice) process.stdout.write(`::notice title=Release check::${result.notice}\n`);
  else process.stdout.write("The release check starts the release build.\n");
  const output = env["GITHUB_OUTPUT"];
  if (output) appendFileSync(output, `run=${result.run}\npending=${result.pending.join(" ")}\nnotice=${result.notice}\n`);
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main();
