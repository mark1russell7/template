// The version check of a pull request (CI.md, the input version-check of reusable-ci.yml).
//
// The release skips each version that is on npm. So a pull request that changes the shipped files of
// a package and keeps its version ships nothing, and the next version pull request fails the release
// build. This script packs each published package whose version is on npm. It compares the files
// with the tarball on npm, with the compare of the release (scripts/release/unchanged.ts).
//
// Before the date FAILS_FROM, a difference gives a warning and the step passes. From that date, it
// gives an error and the step fails. evaluate() has the rules and no I/O, so the tests call it directly.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shippedDifferences, tarballFiles } from "../../../scripts/release/unchanged.ts";
import { publishedPackages, type Packument } from "../../../scripts/release/workspace.ts";

/** A published package whose version is on npm, with the shipped files that differ from npm. */
export interface Drift {
  readonly name: string;
  readonly version: string;
  readonly differences: readonly string[];
}

/** The result of evaluate(): the annotations and the exit code of the step. */
export interface Evaluation {
  readonly level: "notice" | "warning" | "error";
  readonly lines: string[];
  readonly exitCode: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SHOWN = 20;

/** This function tells if a difference fails the step on the day `today` (YYYY-MM-DD). An empty date fails at once. */
export function failsOn(failsFrom: string, today: string): boolean {
  if (failsFrom === "") return true;
  if (!DATE.test(failsFrom)) throw new Error(`"${failsFrom}" is not a date: use YYYY-MM-DD, or "" to fail at once.`);
  return today >= failsFrom;
}

/** This function gives the annotations and the exit code for the packages that differ from npm. */
export function evaluate(drifts: readonly Drift[], failsFrom: string, today: string): Evaluation {
  const changed = drifts.filter((drift) => drift.differences.length > 0);
  if (changed.length === 0) return { level: "notice", lines: [], exitCode: 0 };
  const fails = failsOn(failsFrom, today);
  const level = fails ? "error" : "warning";
  const after = fails ? "" : ` From ${failsFrom}, this check fails.`;
  const lines = changed.map((drift) => {
    const shown = drift.differences.slice(0, SHOWN).join(", ");
    const more = drift.differences.length > SHOWN ? ` and ${drift.differences.length - SHOWN} more` : "";
    return `${drift.name}@${drift.version} is on npm, but these shipped files differ from it: ${shown}${more}. The release skips a version that is on npm, so set a greater version (SemVer) in its package.json.${after}`;
  });
  return { level, lines, exitCode: fails ? 1 : 0 };
}

async function packument(name: string): Promise<Packument | undefined> {
  const response = await fetch(`https://registry.npmjs.org/${name.replaceAll("/", "%2f")}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`The registry gave HTTP ${response.status} for ${name}.`);
  return (await response.json()) as Packument;
}

/** This function packs each published package of `repo` whose version is on npm, and compares it with npm. */
export async function drifts(repo: string): Promise<Drift[]> {
  const out = mkdtempSync(join(tmpdir(), "version-check-"));
  const shell = process.platform === "win32";
  const found: Drift[] = [];
  for (const { dir, manifest } of publishedPackages(repo)) {
    const version = manifest.version ?? "";
    const published = (await packument(manifest.name))?.versions?.[version] as { dist?: { tarball?: string } } | undefined;
    const tarball = published?.dist?.tarball;
    if (!tarball) {
      process.stdout.write(`${manifest.name}@${version} is not on npm. The release publishes it.\n`);
      continue;
    }
    const before = new Set(readdirSync(out));
    execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: dir, stdio: ["ignore", "inherit", "inherit"], shell });
    const added = readdirSync(out).filter((name) => !before.has(name) && name.endsWith(".tgz"));
    if (added.length !== 1) throw new Error(`pnpm pack of ${manifest.name} made ${added.length} tarballs: ${added.join(", ")}`);
    const response = await fetch(tarball);
    if (!response.ok) throw new Error(`The registry gave HTTP ${response.status} for ${tarball}.`);
    const differences = shippedDifferences(tarballFiles(Buffer.from(await response.arrayBuffer())), tarballFiles(readFileSync(join(out, added[0] ?? ""))));
    process.stdout.write(`${manifest.name}@${version} is on npm: ${differences.length} shipped files differ.\n`);
    found.push({ name: manifest.name, version, differences });
  }
  return found;
}

async function main(): Promise<number> {
  const repo = resolve(process.env["VERSION_CHECK_REPO"] ?? ".");
  const failsFrom = process.env["FAILS_FROM"] ?? "";
  const today = new Date().toISOString().slice(0, 10);
  failsOn(failsFrom, today);
  const all = await drifts(repo);
  const result = evaluate(all, failsFrom, today);
  for (const line of result.lines) process.stdout.write(`::${result.level}::${line}\n`);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) {
    const rows = all.map((drift) => `| \`${drift.name}@${drift.version}\` | ${drift.differences.length === 0 ? "same as npm" : `${drift.differences.length} files differ`} |`);
    const table = rows.length > 0 ? `| Package | Shipped files |\n|---|---|\n${rows.join("\n")}\n` : "No version of a published package is on npm.\n";
    appendFileSync(summary, `### Version check\n\n${table}`);
  }
  return result.exitCode;
}

if (import.meta.main) process.exitCode = await main();
