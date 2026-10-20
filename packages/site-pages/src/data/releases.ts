/**
 * The release data: one entry for each version. The sources are the changelogs of Changesets, the
 * GitHub releases, the git tags and the publication times on npm.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { headingAnchor, parseChangelog, releaseBodyEntries, type ChangelogEntry, type ChangelogSection } from "./changelog.ts";
import { gitTagDates, headingDate, isShallow, type TagDate } from "./git.ts";
import { githubReleases } from "./github.ts";
import { globFiles } from "./glob.ts";
import { npmPublishTimes } from "./npm.ts";
import type { GitHubRelease, Link, NpmVersionTime, Release, ReleaseChange } from "./types.ts";
import { compareVersions, kindOf, versionOfTag } from "./versions.ts";

/** An error in the release sources, for example a group without a changelog. */
export class ReleaseDataError extends Error {}

/** One changelog file and the npm name of its package. */
export interface ChangelogSource {
  /** The npm name of the package. */
  name: string;
  /** The path of the file in the repository, with `/`. */
  file: string;
  markdown: string;
}

/** The sources of `mergeReleases`. Each source is optional. */
export interface ReleaseSources {
  changelogs?: readonly ChangelogSource[];
  githubReleases?: readonly GitHubRelease[];
  tags?: readonly TagDate[];
  npm?: readonly NpmVersionTime[];
  /**
   * The npm name of the package whose changelog gives the versions, for a monorepo with one version
   * for all its packages. Without it, each version of each source is a version.
   */
  group?: string | undefined;
  /** "owner/name" of the repository, for the links. */
  repository?: string | undefined;
  /** The branch or the commit of the changelog links. The default is "HEAD". */
  ref?: string | undefined;
  /** This function gives the date of a version without another date: the commit that added its heading. */
  headingDate?: ((version: string, file: string) => string | null) | undefined;
  /** The time of the build, for a version without a date. The default is the time of the call. */
  now?: string | undefined;
  warn?: ((message: string) => void) | undefined;
}

/** The changes of one version, by commit (or by text, for an entry without a commit). */
type ChangeMap = Map<string, ReleaseChange>;

function addChange(changes: ChangeMap, entry: ChangelogEntry, packageName: string | null): void {
  const key = entry.commit ?? `text:${entry.text}`;
  const change = changes.get(key) ?? { commit: entry.commit, text: entry.text, packages: [] };
  if (packageName && !change.packages.includes(packageName)) change.packages.push(packageName);
  changes.set(key, change);
}

function sortedChanges(changes: ChangeMap | undefined): ReleaseChange[] {
  return [...(changes?.values() ?? [])]
    .map((change) => ({ ...change, packages: [...change.packages].sort() }))
    .sort((a, b) => b.packages.length - a.packages.length || a.text.localeCompare(b.text));
}

/** The earliest of some ISO dates, or null. */
function earliest(dates: ReadonlyArray<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const date of dates) {
    if (!date || !Number.isFinite(Date.parse(date))) continue;
    if (best === null || Date.parse(date) < Date.parse(best)) best = date;
  }
  return best;
}

/** The URL path of a git ref: each character that a URL cannot hold is encoded, and "@" and "/" stay. */
function refPath(ref: string): string {
  return encodeURI(ref).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

/**
 * This function merges the release sources into one entry for each version, the newest first.
 *
 * - The versions: the changelog of `group`, or else each changelog version and each GitHub release.
 * - The date: the git tag, else the GitHub release, else npm, else the commit of the changelog heading.
 * - The changes: the changelog entries, else the list items of the GitHub release text.
 *
 * @throws ReleaseDataError when `group` has no changelog and other changelogs exist
 */
export function mergeReleases(sources: ReleaseSources): Release[] {
  const { group, repository, ref = "HEAD", warn = () => {} } = sources;
  const changelogs = sources.changelogs ?? [];
  const inGroup = (packageName: string | null): boolean => !group || packageName === null || packageName === group;

  // The changelog sections of each version
  const parsed: Array<{ source: ChangelogSource; sections: ChangelogSection[] }> = changelogs.map((source) => ({
    source,
    sections: parseChangelog(source.markdown),
  }));
  const groupChangelog = group ? parsed.find((entry) => entry.source.name === group) : undefined;
  if (group && parsed.length > 0 && !groupChangelog) throw new ReleaseDataError(`no changelog of ${group}`);

  const githubByVersion = new Map<string, Array<{ release: GitHubRelease; package: string | null }>>();
  for (const release of sources.githubReleases ?? []) {
    const tag = versionOfTag(release.tag);
    if (!tag) continue;
    const list = githubByVersion.get(tag.version) ?? [];
    list.push({ release, package: tag.package });
    githubByVersion.set(tag.version, list);
  }

  // The versions
  const versions = new Set<string>();
  if (groupChangelog) {
    for (const section of groupChangelog.sections) versions.add(section.version);
  } else {
    for (const { sections } of parsed) for (const section of sections) versions.add(section.version);
    for (const [version, list] of githubByVersion) if (list.some((entry) => inGroup(entry.package))) versions.add(version);
  }
  const ordered = [...versions].sort((a, b) => compareVersions(b, a));
  if (ordered.length === 0) return [];

  // The changes and the changelog section of each version
  const changelogChanges = new Map<string, ChangeMap>();
  const changelogOf = new Map<string, { source: ChangelogSource; heading: string }>();
  const groupFirst = groupChangelog ? [groupChangelog, ...parsed.filter((entry) => entry !== groupChangelog)] : parsed;
  for (const { source, sections } of groupFirst) {
    for (const section of sections) {
      if (!versions.has(section.version)) continue;
      if (!changelogOf.has(section.version)) changelogOf.set(section.version, { source, heading: section.heading });
      const changes = changelogChanges.get(section.version) ?? new Map<string, ReleaseChange>();
      for (const entry of section.entries) addChange(changes, entry, source.name);
      changelogChanges.set(section.version, changes);
    }
  }

  const tagsByVersion = new Map<string, TagDate[]>();
  for (const tag of sources.tags ?? []) {
    const parsedTag = versionOfTag(tag.tag);
    if (!parsedTag || !inGroup(parsedTag.package)) continue;
    const list = tagsByVersion.get(parsedTag.version) ?? [];
    list.push(tag);
    tagsByVersion.set(parsedTag.version, list);
  }
  const npmByVersion = new Map<string, NpmVersionTime[]>();
  for (const time of sources.npm ?? []) {
    const list = npmByVersion.get(time.version) ?? [];
    list.push(time);
    npmByVersion.set(time.version, list);
  }

  // The date of each version
  const dates = new Map<string, string>();
  const missing: string[] = [];
  for (const version of ordered) {
    const github = (githubByVersion.get(version) ?? []).filter((entry) => inGroup(entry.package));
    const npm = npmByVersion.get(version) ?? [];
    const npmGroup = group ? npm.filter((time) => time.name === group) : [];
    const changelog = changelogOf.get(version);
    const date =
      earliest((tagsByVersion.get(version) ?? []).map((tag) => tag.date)) ??
      earliest(github.map((entry) => entry.release.publishedAt)) ??
      earliest((npmGroup.length > 0 ? npmGroup : npm).map((time) => time.date)) ??
      (changelog && sources.headingDate ? sources.headingDate(version, changelog.source.file) : null);
    if (date) dates.set(version, date);
    else missing.push(version);
  }
  if (missing.length > 0) {
    // A version without a date gets the date of the next newer version, or the time of the build
    warn(`no source gives a date for ${missing.join(", ")}. The page shows an approximate date.`);
    let newer = sources.now ?? new Date().toISOString();
    for (const version of ordered) {
      const date = dates.get(version);
      if (date) newer = date;
      else dates.set(version, newer);
    }
  }

  const oldest = ordered[ordered.length - 1];
  return ordered.map((version): Release => {
    const github = githubByVersion.get(version) ?? [];
    let changes: ChangeMap | undefined = changelogChanges.get(version);
    if (!changes) {
      // No changelog has the version: the list items of the GitHub releases are the changes
      changes = new Map();
      for (const { release, package: packageName } of github) {
        for (const entry of releaseBodyEntries(release.body)) addChange(changes, entry, packageName ?? (group || null));
      }
    }

    const links: Link[] = [];
    const githubRelease = github.find((entry) => entry.package === group) ?? github.find((entry) => entry.package === null) ?? github[0];
    if (githubRelease?.release.url) links.push({ label: "GitHub release", url: githubRelease.release.url });
    else if (repository) {
      const tag = (tagsByVersion.get(version) ?? [])[0];
      if (tag) links.push({ label: "Tag", url: `https://github.com/${repository}/releases/tag/${refPath(tag.tag)}` });
    }
    const changelog = changelogOf.get(version);
    if (changelog && repository) {
      links.push({ label: "Changelog", url: `https://github.com/${repository}/blob/${refPath(ref)}/${changelog.source.file}#${headingAnchor(changelog.heading)}` });
    }
    const npm = npmByVersion.get(version) ?? [];
    const npmPackage = npm.find((time) => time.name === group) ?? npm[0];
    if (npmPackage) links.push({ label: "npm", url: `https://www.npmjs.com/package/${npmPackage.name}/v/${version}` });

    return {
      version,
      date: dates.get(version) ?? sources.now ?? new Date().toISOString(),
      kind: kindOf(version, version === oldest),
      changes: sortedChanges(changes),
      links,
    };
  });
}

// ---------------------------------------------------------------------------
// The sources on disk
// ---------------------------------------------------------------------------

/** The default patterns of the changelog files: the first pattern that finds a file wins. */
export const DEFAULT_CHANGELOGS: readonly string[] = ["packages/*/CHANGELOG.md", "CHANGELOG.md"];

/**
 * This function reads the changelog files of a repository. The npm name of each changelog comes from
 * the `package.json` next to it, else from its folder.
 */
export function readChangelogs(repoDir: string, pattern?: string): ChangelogSource[] {
  const patterns = pattern ? [pattern] : DEFAULT_CHANGELOGS;
  for (const candidate of patterns) {
    const files = globFiles(repoDir, candidate);
    if (files.length === 0) continue;
    return files.map((file) => {
      const path = join(repoDir, ...file.split("/"));
      const manifest = join(dirname(path), "package.json");
      let name = basename(dirname(path));
      if (existsSync(manifest)) {
        try {
          const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
          if (typeof parsed.name === "string" && parsed.name) name = parsed.name;
        } catch {
          // A package.json that is not JSON: the folder gives the name
        }
      }
      return { name, file, markdown: readFileSync(path, "utf8") };
    });
  }
  return [];
}

/** The options of `readReleases`. */
export interface ReadReleasesOptions {
  /** The folder of the repository. The changelog patterns start here. */
  repoDir: string;
  /** "owner/name" of the repository on GitHub, for the GitHub releases and the links. */
  repository?: string | undefined;
  token?: string | undefined;
  /** The glob pattern of the changelog files. The default is `DEFAULT_CHANGELOGS`. */
  changesets?: string | undefined;
  /** The npm names or scopes for the npm dates. */
  packages?: readonly string[] | undefined;
  group?: string | undefined;
  /** The branch or the commit of the changelog links. */
  ref?: string | undefined;
  fetch?: typeof fetch | undefined;
  now?: string | undefined;
  warn?: ((message: string) => void) | undefined;
}

/**
 * This function reads all the release sources of a repository and merges them. A failure of GitHub
 * or npm does not stop it, but gives a warning.
 *
 * @throws ReleaseDataError when `group` has no changelog and other changelogs exist
 */
export async function readReleases(options: ReadReleasesOptions): Promise<Release[]> {
  const { repoDir, repository, warn = () => {} } = options;
  const changelogs = readChangelogs(repoDir, options.changesets);
  const tags = gitTagDates(repoDir);
  if (isShallow(repoDir)) warn("the clone is shallow, so the release dates are not exact. Check out the full history (fetch-depth 0).");

  let releases: GitHubRelease[] = [];
  const [owner = "", repo = ""] = (repository ?? "").split("/");
  if (owner && repo) {
    const result = await githubReleases({ owner, repo, token: options.token, ...(options.fetch ? { fetch: options.fetch } : {}) });
    if (result.available) releases = result.releases;
    else warn(`the releases page has no GitHub releases: ${result.reason}.`);
  }

  let npm: NpmVersionTime[] = [];
  if (options.packages && options.packages.length > 0) {
    const result = await npmPublishTimes({ packages: options.packages, ...(options.fetch ? { fetch: options.fetch } : {}) });
    npm = result.times;
    for (const problem of result.problems) warn(problem);
  }

  return mergeReleases({
    changelogs,
    githubReleases: releases,
    tags,
    npm,
    group: options.group,
    repository,
    ref: options.ref,
    headingDate: (version, file) => headingDate(repoDir, version, file),
    now: options.now,
    warn,
  });
}
