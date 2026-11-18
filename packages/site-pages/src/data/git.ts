/**
 * The git source: the tags with their dates, the commit of the build and the GitHub remote. Each
 * function gives an empty result when git or the repository is not available.
 */

import { execFileSync } from "node:child_process";
import type { WorkspaceVersion } from "./types.ts";
import { compareVersions, parseVersion } from "./versions.ts";

/** A git tag and the ISO date of its creation. */
export interface TagDate {
  tag: string;
  date: string;
}

/** This function starts git in a folder and gives its output, or null when git fails. */
export function git(repoDir: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch {
    return null;
  }
}

/** This function tells if the clone is shallow. A shallow clone has not all the tags and commits. */
export function isShallow(repoDir: string): boolean {
  return git(repoDir, "rev-parse", "--is-shallow-repository")?.trim() === "true";
}

/** This function gives each tag of the repository with its date. An annotated tag has its own date. */
export function gitTagDates(repoDir: string): TagDate[] {
  const output = git(repoDir, "for-each-ref", "--format=%(refname:strip=2) %(creatordate:iso-strict)", "refs/tags");
  if (!output) return [];
  const tags: TagDate[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+) (\S+)$/.exec(line.trim());
    if (match?.[1] && match[2]) tags.push({ tag: match[1], date: match[2] });
  }
  return tags;
}

/**
 * This function gives the date of the oldest commit that added a version heading to a changelog,
 * or null. The path of the changelog starts at `repoDir`.
 */
export function headingDate(repoDir: string, version: string, file: string): string | null {
  const output = git(repoDir, "log", "--format=%cI", `-S## ${version}`, "--", file);
  const dates = (output ?? "").trim().split(/\r?\n/).filter(Boolean);
  return dates[dates.length - 1] ?? null;
}

/**
 * This function gives the ISO time of the last commit that changed the `version` line of a `package.json`, or null. The
 * path of the file starts at `repoDir`. A shallow clone can give a later commit, so use the full history. A change of
 * only the comma of that line also counts as a change of the line.
 */
export function versionCommitTime(repoDir: string, file: string): string | null {
  return git(repoDir, "log", "-1", "--format=%cI", '-G^\\s*"version":', "HEAD", "--", file)?.trim() || null;
}

/**
 * This function reads each object `<commit>:<path>` with one process of `git cat-file --batch`. It gives the text of each
 * object, or undefined for an object that git does not have.
 */
function readObjects(top: string, specs: readonly string[]): (string | undefined)[] {
  if (specs.length === 0) return [];
  let out: Buffer;
  try {
    out = execFileSync("git", ["cat-file", "--batch"], { cwd: top, input: `${specs.join("\n")}\n`, maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  } catch {
    return specs.map(() => undefined);
  }
  const texts: (string | undefined)[] = [];
  let at = 0;
  for (let index = 0; index < specs.length; index += 1) {
    const end = out.indexOf(0x0a, at);
    if (end < 0) {
      texts.push(undefined);
      continue;
    }
    // Each object starts with the line "<sha> blob <size>". An object that git does not have gives "<name> missing".
    const size = /^[0-9a-f]+ blob (\d+)$/.exec(out.toString("utf8", at, end))?.[1];
    if (size === undefined) {
      texts.push(undefined);
      at = end + 1;
      continue;
    }
    texts.push(out.toString("utf8", end + 1, end + 1 + Number(size)));
    at = end + 1 + Number(size) + 1;
  }
  return texts;
}

/** This function gives the name and the version of the text of a `package.json`, or undefined. */
function manifestOf(text: string | undefined): { name: string; version: string } | undefined {
  if (text === undefined) return undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (manifest === null || typeof manifest !== "object") return undefined;
  const { name, version } = manifest as { name?: unknown; version?: unknown };
  return typeof name === "string" && typeof version === "string" && parseVersion(version) !== null ? { name, version } : undefined;
}

/**
 * This function gives the versions of each package of the repository, by its name, from each `package.json` that git
 * tracks at `HEAD`. In CI, `HEAD` is the build commit.
 *
 * The first version is the version at `HEAD`, and each next version is older. Each version has the time of the commit
 * that set it. In a shallow clone, the oldest version has no time. For two packages with one name, the function keeps
 * the package with the higher version. A move of a file starts its history again. Outside a repository, it gives no package.
 */
export function workspaceVersions(repoDir: string): Record<string, readonly WorkspaceVersion[]> {
  const top = git(repoDir, "rev-parse", "--show-toplevel")?.trim();
  if (!top) return {};
  // A path with a line break cannot go to git cat-file --batch, and a package.json has no such path.
  const paths = (git(top, "ls-files", "-z", "--", ":(glob)**/package.json") ?? "").split("\0").filter((path) => path !== "" && !path.includes("\n"));
  const heads = readObjects(top, paths.map((path) => `HEAD:${path}`));
  const chosen = new Map<string, { path: string; version: string }>();
  paths.forEach((path, index) => {
    const manifest = manifestOf(heads[index]);
    if (manifest === undefined) return;
    const old = chosen.get(manifest.name);
    if (old === undefined || compareVersions(manifest.version, old.version) > 0) chosen.set(manifest.name, { path, version: manifest.version });
  });
  // One log gives each commit that changed a version line of a chosen file, the newest first. The search has no anchor,
  // so a `package.json` on one line also counts. A commit that changed only another part of that line keeps the version.
  // The loop below reads the version of each commit, so such a commit does not change the time of a version.
  const files = [...chosen.values()].map(({ path }) => path);
  const log = files.length === 0 ? "" : (git(top, "-c", "core.quotePath=false", "log", "--format=%x00%H %cI", "--name-only", '-G"version"\\s*:', "HEAD", "--", ...files.map((path) => `:(literal)${path}`)) ?? "");
  const commits = new Map<string, { sha: string; date: string }[]>();
  for (const entry of log.split("\0")) {
    const [head = "", ...names] = entry.split("\n");
    const [sha, date] = head.split(" ");
    if (sha === undefined || date === undefined || Number.isNaN(Date.parse(date))) continue;
    for (const name of names) {
      if (name === "") continue;
      let list = commits.get(name);
      if (list === undefined) {
        list = [];
        commits.set(name, list);
      }
      list.push({ sha, date: new Date(date).toISOString() });
    }
  }
  const specs = files.flatMap((path) => (commits.get(path) ?? []).map(({ sha }) => `${sha}:${path}`));
  const texts = readObjects(top, specs);
  const shallow = isShallow(top);
  const versions = new Map<string, WorkspaceVersion[]>();
  let next = 0;
  for (const [name, { path, version }] of chosen) {
    const list = commits.get(path) ?? [];
    const history: WorkspaceVersion[] = [{ version }];
    let complete = true;
    for (const [index, commit] of list.entries()) {
      const at = manifestOf(texts[next + index])?.version;
      const current = history.at(-1);
      // A commit with no version that the function can read ends the history that it knows.
      if (at === undefined || current === undefined) {
        complete = false;
        break;
      }
      if (at === current.version) current.since = commit.date;
      else history.push({ version: at, since: commit.date });
    }
    next += list.length;
    // In a shallow clone, the oldest commit is not the commit that set its version.
    const oldest = history.at(-1);
    if (shallow && complete && oldest !== undefined) delete oldest.since;
    versions.set(name, history);
  }
  return Object.fromEntries(versions);
}

/** This function gives the full SHA of `HEAD`, or null. */
export function headCommit(repoDir: string): string | null {
  const sha = git(repoDir, "rev-parse", "HEAD")?.trim();
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** This function gives "owner/name" of the GitHub remote "origin", or null. */
export function originRepository(repoDir: string): string | null {
  const url = git(repoDir, "remote", "get-url", "origin")?.trim() ?? "";
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}
