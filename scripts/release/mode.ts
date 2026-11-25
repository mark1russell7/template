// The mode of a release run: publish the versions, or open the version pull request of Changesets.
//
//   node scripts/release/mode.ts
//
// The build job of reusable-release-build.yml starts this script before the install. It reads the repository
// (RELEASE_REPO) and writes "mode" to GITHUB_OUTPUT:
//
//   publish  The repository has no .changeset/config.json, or no changeset waits. The release packs and publishes
//            each version that npm does not have, as before this script.
//   version  The repository has .changeset/config.json, and one or more changesets wait. The job "version" of
//            release.yml opens or updates the pull request "Version the packages", and the run publishes nothing.
//            The merge of that pull request removes the changesets, so the run of the merge publishes.
//
// A pending changeset is a file .changeset/*.md other than README.md. In the pre mode of Changesets
// (.changeset/pre.json, "mode": "pre"), the version step keeps each changeset and writes its name into pre.json.
// Thus a changeset that pre.json names is not pending. After `changeset pre exit` ("mode": "exit"), the next version
// step reads each changeset again, so each file is pending.
//
// The script reads only files. It needs no install, so it starts before the install of the repository.

import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { root } from "./workspace.ts";

/** The two modes of a release run. */
export type ReleaseMode = "publish" | "version";

/** The mode of a run, the pending changesets, and the reason in one line. */
export interface ModeDecision {
  readonly mode: ReleaseMode;
  readonly changesets: readonly string[];
  readonly reason: string;
}

/** This function gives the names (without ".md") that the pre mode of Changesets consumed, or undefined out of pre mode. */
function consumedInPre(dir: string): ReadonlySet<string> | undefined {
  const file = join(dir, "pre.json");
  if (!existsSync(file)) return undefined;
  let pre: unknown;
  try {
    pre = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`.changeset/pre.json is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { mode, changesets } = (pre ?? {}) as { readonly mode?: unknown; readonly changesets?: unknown };
  if (mode === "exit") return new Set();
  if (mode !== "pre" || !Array.isArray(changesets) || !changesets.every((name) => typeof name === "string")) {
    throw new Error('.changeset/pre.json must have "mode" "pre" or "exit", and "changesets" as a list of names.');
  }
  return new Set(changesets as string[]);
}

/**
 * This function gives the changesets that wait in a repository, as `.changeset/<file>`, in order. It gives undefined
 * when the repository has no `.changeset/config.json`: then the repository does not use Changesets.
 */
export function pendingChangesetFiles(repo: string): string[] | undefined {
  const dir = join(repo, ".changeset");
  if (!existsSync(join(dir, "config.json"))) return undefined;
  const consumed = consumedInPre(dir) ?? new Set<string>();
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md") && file.toLowerCase() !== "readme.md" && !consumed.has(file.slice(0, -".md".length)))
    .sort()
    .map((file) => `.changeset/${file}`);
}

/** This function gives a list of files for a line of the log: at most 10 files, then a count. */
function listFiles(files: readonly string[]): string {
  return files.length > 10 ? `${files.slice(0, 10).join(", ")} and ${String(files.length - 10)} more` : files.join(", ");
}

/** This function gives the mode of a release run of a repository. */
export function releaseMode(repo: string): ModeDecision {
  const changesets = pendingChangesetFiles(repo);
  if (changesets === undefined) {
    return { mode: "publish", changesets: [], reason: "The repository does not use Changesets. The release publishes each version that npm does not have." };
  }
  if (changesets.length === 0) {
    return { mode: "publish", changesets, reason: "No changeset waits. The release publishes each version that npm does not have." };
  }
  return {
    mode: "version",
    changesets,
    reason:
      `${String(changesets.length)} changesets wait: ${listFiles(changesets)}. The release opens or updates the pull request "Version the packages", ` +
      "and it publishes nothing. The merge of that pull request starts the publish.",
  };
}

/** This function writes the mode to GITHUB_OUTPUT, and the reason to the log and to the summary. It gives the exit code. */
export function main(repo: string = root, env: Readonly<Record<string, string | undefined>> = process.env): number {
  let decision: ModeDecision;
  try {
    decision = releaseMode(repo);
  } catch (error) {
    process.stdout.write(`::error title=Release mode::${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  process.stdout.write(`The release mode is ${decision.mode}. ${decision.reason}\n`);
  const output = env["GITHUB_OUTPUT"];
  if (output) appendFileSync(output, `mode=${decision.mode}\n`);
  const summary = env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, `Release mode: **${decision.mode}**. ${decision.reason}\n`);
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main();
