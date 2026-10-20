/**
 * Versions: the SemVer parser, the sort, the kind of a version and the version of a git tag.
 */

import type { ReleaseKind } from "./types.ts";

/** The parts of a SemVer 2.0.0 version. */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** This function gives the parts of a version, or null when the text is not a SemVer version. */
export function parseVersion(version: string): ParsedVersion | null {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/**
 * This function compares two versions by the SemVer precedence. It gives a negative number when `a`
 * is older, a positive number when `a` is newer, and 0 for the same version. A text that is not a
 * version comes before each version.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : a.localeCompare(b);
  const core = x.major - y.major || x.minor - y.minor || x.patch - y.patch;
  if (core !== 0) return core;
  // A prerelease comes before its release: 1.0.0-rc.1 < 1.0.0
  if (x.prerelease.length === 0 || y.prerelease.length === 0) return y.prerelease.length - x.prerelease.length;
  for (let index = 0; index < Math.max(x.prerelease.length, y.prerelease.length); index++) {
    const p = x.prerelease[index];
    const q = y.prerelease[index];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pNumber = /^\d+$/.test(p);
    const qNumber = /^\d+$/.test(q);
    if (pNumber && qNumber) return Number(p) - Number(q);
    if (pNumber !== qNumber) return pNumber ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * This function gives the kind of a version. The oldest version of the list is "first". The caller
 * tells if the version is the oldest.
 */
export function kindOf(version: string, oldest: boolean): ReleaseKind {
  if (oldest) return "first";
  const parsed = parseVersion(version);
  if (!parsed) return "patch";
  if (parsed.major > 0 && parsed.minor === 0 && parsed.patch === 0) return "major";
  return parsed.patch === 0 ? "minor" : "patch";
}

/** The version of a git tag, and the package that the tag names (null for a tag like `v1.2.3`). */
export interface TagVersion {
  version: string;
  package: string | null;
}

/**
 * This function reads the version of a git tag. It knows `1.2.3`, `v1.2.3` and the tags of Changesets:
 * `name@1.2.3` and `@scope/name@1.2.3`. It gives null for another tag.
 */
export function versionOfTag(tag: string): TagVersion | null {
  const match = /^(?:(.+)@)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)$/.exec(tag.trim());
  if (!match || match[2] === undefined || !parseVersion(match[2])) return null;
  return { version: match[2], package: match[1] ?? null };
}
