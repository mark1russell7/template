// The dist-tag of one publish of the action npm-publish (action.yml). The step reads the packument of the package
// just before the publish, and this file gives the tag from the version and the "latest" of that packument.
//
//   - A pre-release (1.2.0-rc.1) gets "next", as before. It never gets "latest" or "latest-<major>.<minor>".
//   - A version gets "latest" when npm has no "latest" (a first publish), or when it is higher than that "latest".
//   - A version that is not higher gets "latest-<major>.<minor>", and "latest" stays. Two runs can publish in either
//     order, so a lower version that comes after a higher version does not move "latest" back.
//
// The order is the precedence of SemVer 2.0.0 (semver.org, item 11), not the order of the text: 0.1.10 is higher
// than 0.1.9. The pure function distTag has no I/O, so the tests call it directly (.github/actions/npm-publish.test.ts).
// main() reads a packument file and writes one line for the step.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A SemVer 2.0.0 version, with no build metadata. */
export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The identifiers of the pre-release, or an empty list for a release. */
  readonly prerelease: readonly string[];
}

/** The tag of one publish. `supersededBy` is the "latest" of npm when the tag is not "latest" for a release. */
export type TagResult = { readonly tag: string; readonly supersededBy?: string } | { readonly error: string };

// The grammar of semver.org: no leading zero in a number, and an identifier of [0-9A-Za-z-].
const NUMBER = "0|[1-9]\\d*";
const IDENTIFIER = `(?:${NUMBER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(`^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

/** This function reads a SemVer 2.0.0 version, or gives undefined. It drops the build metadata. */
export function parseVersion(text: string): Version | undefined {
  const match = SEMVER.exec(text);
  if (match === null) return undefined;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number);
  if (major === undefined || minor === undefined || patch === undefined || ![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return { major, minor, patch, prerelease: match[4] === undefined ? [] : match[4].split(".") };
}

/** This function compares two identifiers of a pre-release: numbers by value, and a number is lower than a word. */
function compareIdentifiers(a: string, b: string): number {
  const numberA = /^\d+$/.test(a);
  const numberB = /^\d+$/.test(b);
  if (numberA && numberB) return Math.sign(Number(a) - Number(b));
  if (numberA !== numberB) return numberA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** This function gives -1, 0 or 1 by the precedence of SemVer 2.0.0. The build metadata has no effect. */
export function compareVersions(a: Version, b: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  }
  // A release is higher than each of its pre-releases.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return Math.sign(b.prerelease.length - a.prerelease.length);
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index += 1) {
    const order = compareIdentifiers(a.prerelease[index] ?? "", b.prerelease[index] ?? "");
    if (order !== 0) return order;
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}

/**
 * This function gives the dist-tag of a publish of `version`. `latest` is the "latest" dist-tag of npm,
 * read immediately before the publish, or undefined when npm has none.
 */
export function distTag(version: string, latest: string | undefined): TagResult {
  const own = parseVersion(version);
  if (own === undefined) return { error: `${version} is not a SemVer version.` };
  if (own.prerelease.length > 0) return { tag: "next" };
  if (latest === undefined) return { tag: "latest" };
  const current = parseVersion(latest);
  if (current === undefined) return { error: `The "latest" of npm is ${latest}, which is not a SemVer version, so the step cannot compare ${version} with it.` };
  if (compareVersions(own, current) > 0) return { tag: "latest" };
  return { tag: `latest-${String(own.major)}.${String(own.minor)}`, supersededBy: latest };
}

/** This function gives the "latest" dist-tag of a packument, or undefined. */
export function latestOf(packument: unknown): string | undefined {
  if (packument === null || typeof packument !== "object") return undefined;
  const tags = (packument as { "dist-tags"?: unknown })["dist-tags"];
  if (tags === null || typeof tags !== "object") return undefined;
  const latest = (tags as { latest?: unknown }).latest;
  return typeof latest === "string" ? latest : undefined;
}

/**
 * The step: `node dist-tag.ts <version> <packument file>`. It writes "<tag>" or "<tag> <latest of npm>" to stdout. It
 * gives 1 with the reason on stderr when it cannot decide, so the step publishes nothing with a wrong tag.
 */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const [version, file] = argv;
  if (version === undefined || file === undefined) {
    console.error("Usage: node dist-tag.ts <version> <packument file>");
    return 1;
  }
  let packument: unknown;
  try {
    packument = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`The packument ${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const result = distTag(version, latestOf(packument));
  if ("error" in result) {
    console.error(result.error);
    return 1;
  }
  console.log(result.supersededBy === undefined ? result.tag : `${result.tag} ${result.supersededBy}`);
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main();
