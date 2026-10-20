/**
 * The git source: the tags with their dates, the commit of the build and the GitHub remote. Each
 * function gives an empty result when git or the repository is not available.
 */

import { execFileSync } from "node:child_process";

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
