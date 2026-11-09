/**
 * The rule for the git tag and the text of a GitHub release of a package version.
 *
 * The release workflow keeps the same rule in `scripts/release/tags.ts`. A pinned workflow starts that script, so it
 * does not import this package. A test of this package compares the two.
 */

import { escapeRegExp as escape } from "@mark1russell7/text";

/** GitHub refuses a release text of more than 125000 characters. */
export const MAX_NOTES: number = 100_000;

/** This function gives the tag of a version: `v<version>` when the repository has one published package. */
export function tagName(name: string, version: string, packageCount: number): string {
  return packageCount === 1 ? `v${version}` : `${name}@${version}`;
}

/**
 * This function gives the text of the section of a version in a changelog, or undefined.
 *
 * The heading of the section has the version, with an optional `v` or `<name>@` before it and optional brackets:
 * `## 1.2.0`, `## v1.2.0`, `## [1.2.0] - 2026-10-18`, `# pkg@1.2.0 (2026-10-18)`. The section stops at the next heading
 * of the same level or a higher level. A heading in fenced code does not count. An empty section gives undefined.
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
 * This function gives the text of the GitHub release of a version: its changelog section, or else one list item with a
 * link to npm. The Releases page of `site-pages` reads each list item as a change.
 */
export function releaseNotes(name: string, version: string, changelog: string | undefined): string {
  const fallback = `- Version ${version} of [\`${name}\`](${npmUrl(name, version)}) on npm.`;
  const section = changelog === undefined ? undefined : changelogSection(changelog, version, name);
  if (section === undefined) return fallback;
  if (section.length <= MAX_NOTES) return section;
  return `${section.slice(0, MAX_NOTES)}\n\n(The CHANGELOG.md of \`${name}\` has the full text.)`;
}
