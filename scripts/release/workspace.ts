// The published packages of this repository, for the release scripts.
//
// A published package is a package.json that is not private: the root package.json, or one in
// packages/*. The list has a package after the packages of this repository that it depends on.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The fields of a package.json that the release scripts read. */
export interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly repository?: string | { readonly type?: string; readonly url?: string; readonly directory?: string };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly [field: string]: unknown;
}

/** A published package: its folder and its package.json. */
export interface PublishedPackage {
  readonly dir: string;
  readonly manifest: Manifest & { readonly name: string };
}

/** The parts of a SemVer version. */
export interface Version {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

/** The npm data of a package (the packument), with the fields that the scripts read. */
export interface Packument {
  readonly versions?: Readonly<Record<string, unknown>>;
  readonly time?: Readonly<Record<string, string>>;
  readonly "dist-tags"?: Readonly<Record<string, string>>;
}

// RELEASE_REPO names the repository when the scripts run from another folder: the release build
// runs the scripts of the template commit of its workflow for the repository of the caller.
const releaseRepo: string | undefined = process.env["RELEASE_REPO"];
export const root: string = releaseRepo ? resolve(releaseRepo) : join(import.meta.dirname, "..", "..");

/** This function gives the text of a file of a repository: from the disk, or from a git ref. */
export function readRepoFile(repo: string, path: string, ref?: string): string | undefined {
  if (ref === undefined) {
    const file = join(repo, path);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  }
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/** This function gives the folders in packages/ of a repository: from the disk, or from a git ref. */
function packageFolders(repo: string, ref?: string): string[] {
  if (ref === undefined) {
    const packagesDir = join(repo, "packages");
    return existsSync(packagesDir) ? readdirSync(packagesDir).sort().map((name) => `packages/${name}`) : [];
  }
  const out = execFileSync("git", ["ls-tree", "-d", "--name-only", ref, "packages/"], { cwd: repo, encoding: "utf8" });
  return out.split(/\r?\n/).filter(Boolean).sort();
}

/**
 * This function gives the published packages of a repository, in the sequence of their dependencies.
 * With a git ref (for example `origin/main`), it reads the package.json files of that commit.
 */
export function publishedPackages(repo: string = root, ref?: string): PublishedPackage[] {
  const packages = ["", ...packageFolders(repo, ref)]
    .map((folder) => ({ folder, text: readRepoFile(repo, folder ? `${folder}/package.json` : "package.json", ref) }))
    .flatMap(({ folder, text }) => (text === undefined ? [] : [{ dir: join(repo, folder), manifest: JSON.parse(text) as Manifest }]))
    .filter((entry): entry is PublishedPackage => !entry.manifest.private && typeof entry.manifest.name === "string");

  const byName = new Map(packages.map((entry) => [entry.manifest.name, entry]));
  const ordered: PublishedPackage[] = [];
  const visit = (entry: PublishedPackage, path: readonly PublishedPackage[] = []): void => {
    if (ordered.includes(entry)) return;
    if (path.includes(entry)) throw new Error(`a dependency cycle at ${entry.manifest.name}`);
    const { dependencies = {}, peerDependencies = {}, optionalDependencies = {} } = entry.manifest;
    for (const name of Object.keys({ ...dependencies, ...peerDependencies, ...optionalDependencies })) {
      const dependency = byName.get(name);
      if (dependency) visit(dependency, [...path, entry]);
    }
    ordered.push(entry);
  };
  packages.forEach((entry) => visit(entry));
  return ordered;
}

/**
 * This function gives the dependencies that npm users cannot install: git, file and link specifiers.
 * A package can use them during development, but not in a release.
 */
export function unpublishableDependencies(manifest: Manifest): string[] {
  const { dependencies = {}, peerDependencies = {}, optionalDependencies = {} } = manifest;
  return Object.entries({ ...dependencies, ...peerDependencies, ...optionalDependencies })
    .filter(([, spec]) => /^(github:|git\+|git:|file:|link:|https?:)/.test(spec) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec))
    .map(([name, spec]) => `${name}@${spec}`);
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** This function gives the parts of a SemVer 2.0.0 version, or undefined for a version that is not valid. */
export function parseVersion(version: string): Version | undefined {
  const match = SEMVER.exec(version);
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ? match[4].split(".") : [] };
}

/** This function compares two valid versions by the SemVer precedence. It gives a negative number, 0 or a positive number. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x === undefined || y === undefined) throw new Error(`compareVersions needs two valid versions: ${a}, ${b}`);
  for (const i of [0, 1, 2] as const) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  // A prerelease comes before its release: 1.0.0-rc.1 < 1.0.0.
  if (x.prerelease.length === 0 || y.prerelease.length === 0) return y.prerelease.length - x.prerelease.length;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
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
 * This function tells why npm must not get a version of a package, or gives undefined when the version is correct.
 * The packument is the npm data of the package, or undefined for a new package. A version that is on npm
 * is correct: the publish job skips it.
 */
export function versionProblem(version: string, packument: Packument | undefined): string | undefined {
  if (!parseVersion(version)) return `${version} is not a SemVer version: use MAJOR.MINOR.PATCH, with an optional -prerelease.`;
  if (packument === undefined || packument.versions?.[version]) return undefined;
  if (packument.time?.[version]) return `${version} was on npm and was removed. npm never accepts a version again: use a greater version.`;
  const latest = packument["dist-tags"]?.["latest"];
  if (latest && parseVersion(latest) && compareVersions(version, latest) <= 0) {
    return `${version} is not greater than ${latest}, the "latest" version on npm. Increase MAJOR, MINOR or PATCH (SemVer).`;
  }
  return undefined;
}

/** This function gives "owner/repo" of the GitHub remote "origin". */
export function githubRepository(repo: string = root): string {
  const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repo, encoding: "utf8" }).trim();
  const match = /github\.com[:/]([^/]+)\/(.+?)(\.git)?$/.exec(url);
  if (!match) throw new Error(`The remote "origin" of ${repo} is not on GitHub: ${url}`);
  return `${match[1]}/${match[2]}`;
}
