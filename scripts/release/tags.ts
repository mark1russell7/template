// Plans the git tag and the GitHub release of each published package, for the release workflow.
//
//   node scripts/release/tags.ts <file>
//
// The script writes <file>: a JSON array with one entry for each published package, in the
// sequence of packages.txt: { name, version, tag, prerelease, notes }. The tag job of release.yml
// reads it. That job holds "contents: write" and runs no code of the repository. Thus this script
// runs in the build job ("contents: read") and makes all the text of the releases.
//
//   tag         "v<version>" in a repository with one published package, else "<name>@<version>"
//               (the convention of Changesets).
//   prerelease  true for a version with a prerelease part, for example 1.2.0-rc.1.
//   notes       The section of the version in the CHANGELOG.md of the package, or else one list
//               item with a link to the version on npm.
//
// The plan has each published package. The tag job selects the versions to tag.

import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseVersion, publishedPackages, readRepoFile } from "./workspace.ts";

// GitHub refuses a release text of more than 125000 characters.
export const MAX_NOTES: number = 100_000;

/** The plan of the tag and the GitHub release of one package. */
export interface TagEntry {
  readonly name: string;
  readonly version: string;
  readonly tag: string;
  readonly prerelease: boolean;
  readonly notes: string;
}

/** A package of the plan: its folder, its name and its version. */
export interface TagPackage {
  readonly dir: string;
  readonly manifest: { readonly name: string; readonly version?: string | undefined };
}

/** This function gives the tag of a version: "v<version>" when the repository has one published package. */
export function tagName(name: string, version: string, packageCount: number): string {
  return packageCount === 1 ? `v${version}` : `${name}@${version}`;
}

/** This function tells if a version has a prerelease part (SemVer), for example 1.2.0-rc.1. */
export function isPrerelease(version: string): boolean {
  return (parseVersion(version)?.prerelease.length ?? 0) > 0;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * This function gives the text of the section of a version in a changelog, or undefined.
 *
 * The heading of the section has the version, with an optional "v" or "<name>@" before it and
 * optional brackets: "## 1.2.0", "## v1.2.0", "## [1.2.0] - 2026-10-18", "# pkg@1.2.0 (2026-10-18)".
 * The section stops at the next heading of the same level or a higher level. A heading in fenced
 * code does not count. An empty section gives undefined.
 */
export function changelogSection(markdown: string, version: string, name: string): string | undefined {
  const heading = new RegExp(`^(#{1,6})\\s+\\[?(?:v|${escape(name)}@)?${escape(version)}\\]?(?=$|[\\s(])`);
  const lines = markdown.split(/\r?\n/);
  let level = 0;
  let fence: string | null = null;
  const body: string[] = [];
  for (const line of lines) {
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceMark !== undefined) {
      const mark = fenceMark[0] ?? "";
      if (fence === null) fence = mark;
      else if (mark === fence) fence = null;
      if (level > 0) body.push(line);
      continue;
    }
    if (fence === null) {
      const levelOf = /^(#{1,6})\s/.exec(line)?.[1]?.length;
      if (level > 0 && levelOf !== undefined && levelOf <= level) break;
      if (level === 0) {
        const match = heading.exec(line);
        if (match) level = match[1]?.length ?? 0;
        continue;
      }
    }
    if (level > 0) body.push(line);
  }
  const text = body.join("\n").trim();
  return text === "" ? undefined : text;
}

/** This function gives the address of a version on npm. */
export function npmUrl(name: string, version: string): string {
  return `https://www.npmjs.com/package/${name}/v/${version}`;
}

/**
 * This function gives the text of the GitHub release of a version: its changelog section, or else
 * one list item with a link to npm. The Releases page of site-pages reads each list item as a change.
 */
export function releaseNotes(name: string, version: string, changelog: string | undefined): string {
  const fallback = `- Version ${version} of [\`${name}\`](${npmUrl(name, version)}) on npm.`;
  const section = changelog === undefined ? undefined : changelogSection(changelog, version, name);
  if (section === undefined) return fallback;
  if (section.length <= MAX_NOTES) return section;
  return `${section.slice(0, MAX_NOTES)}\n\n(The CHANGELOG.md of \`${name}\` has the full text.)`;
}

/**
 * This function gives the plan of the tags and the releases of a list of published packages
 * (`publishedPackages()` of workspace.ts). `readChangelog(dir)` gives the text of the CHANGELOG.md
 * in a package folder, or undefined. A package with no version is an error.
 */
export function tagPlan(packages: readonly TagPackage[], readChangelog: (dir: string) => string | undefined): TagEntry[] {
  return packages.map(({ dir, manifest: { name, version } }) => {
    if (version === undefined) throw new Error(`The package.json of ${name} has no version.`);
    return {
      name,
      version,
      tag: tagName(name, version, packages.length),
      prerelease: isPrerelease(version),
      notes: releaseNotes(name, version, readChangelog(dir)),
    };
  });
}

// This part runs for "node tags.ts", not for an import (the tests). realpath: the path can have a link.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const out = process.argv[2];
  if (out === undefined) {
    process.stderr.write("usage: node scripts/release/tags.ts <file>\n");
    process.exit(2);
  }
  const plan = tagPlan(publishedPackages(), (dir) => readRepoFile(dir, "CHANGELOG.md"));
  writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
  for (const { tag, prerelease } of plan) process.stdout.write(`${tag}${prerelease ? " (prerelease)" : ""}\n`);
  if (plan.length === 0) process.stdout.write("This repository has no published package.\n");
}
