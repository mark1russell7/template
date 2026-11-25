// The versions that a release run published, while npm does not show them yet.
//
// pack.ts compares a version that is on npm with the tarball of npm. A version that npm does not
// have is a new version, and pack.ts does not compare it. But the registry shows a publish some
// minutes after it. On 2026-11-25, the release run of main published a version at 19:50:55 and
// made its git tag at 19:51:18. The release check of a pull request read npm at 19:51:42, and npm
// did not show the version until 19:53. The check read the version as new, and it passed with a
// changed file. After the merge, the release refused the version.
//
// The tag of the release (tags.ts) is the record that a release published a version. So when a
// version has its tag and npm does not show it, pack.ts reads npm again, up to a limit:
//   - npm shows the version: pack.ts compares with it, as with each version on npm.
//   - npm does not show it at the limit: pack.ts stops. The check cannot decide, so it does not pass.
//     Run it again later.
// A version with no tag is new, as before.
// The function awaitReleased takes the read of npm and the clock as parameters, so the tests give
// fakes (released.test.ts).

import { execFileSync } from "node:child_process";
import type { Packument } from "./workspace.ts";

/** A version of a package, with the tag that its release makes. */
export interface TaggedVersion {
  readonly name: string;
  readonly version: string;
  readonly tag: string;
}

/** The clock of the reads. The tests give a clock that does not wait. */
export interface ReadTiming {
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** The most time that the reads take, in milliseconds. */
  readonly limitMs: number;
  /** The time before each read again, in milliseconds. */
  readonly waitMs: number;
}

/** The result of the reads. */
export interface ReleasedResult {
  /** The packument of each package that npm shows with its version after the reads. */
  readonly found: ReadonlyMap<string, Packument>;
  /** The versions that have their tag and that npm does not show at the limit, as name@version. */
  readonly missing: readonly string[];
  readonly waitedMs: number;
}

/** This function gives the tags of a list from `git ls-remote --tags`: one "<sha>\trefs/tags/<tag>" for each line. */
export function remoteTags(text: string): Set<string> {
  const tags = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const ref = line.split("\t")[1];
    if (ref?.startsWith("refs/tags/")) tags.add(ref.slice("refs/tags/".length).replace(/\^\{\}$/, ""));
  }
  return tags;
}

/** This function tells if npm shows a version. */
function shows(packument: Packument | undefined, version: string): boolean {
  return packument?.versions?.[version] !== undefined;
}

/**
 * This function reads npm again for each version that has its tag and that npm does not show, until npm
 * shows each of them or the limit.
 */
export async function awaitReleased(
  versions: readonly TaggedVersion[],
  tags: ReadonlySet<string>,
  read: (name: string) => Promise<Packument | undefined>,
  timing: ReadTiming,
): Promise<ReleasedResult> {
  const start = timing.now();
  const found = new Map<string, Packument>();
  let open = versions.filter((v) => tags.has(v.tag));
  while (open.length > 0) {
    const still: TaggedVersion[] = [];
    for (const v of open) {
      const packument = await read(v.name);
      if (packument !== undefined && shows(packument, v.version)) found.set(v.name, packument);
      else still.push(v);
    }
    open = still;
    if (open.length === 0 || timing.now() - start + timing.waitMs > timing.limitMs) break;
    await timing.sleep(timing.waitMs);
  }
  return { found, missing: open.map((v) => `${v.name}@${v.version}`), waitedMs: timing.now() - start };
}

/** This function gives the tags of the remote origin, or undefined when git cannot read them. */
export function readRemoteTags(repo: string): Set<string> | undefined {
  try {
    const text = execFileSync("git", ["ls-remote", "--tags", "origin"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return remoteTags(text);
  } catch {
    return undefined;
  }
}
