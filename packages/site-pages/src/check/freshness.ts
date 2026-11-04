/**
 * The freshness gate of a measured page. A site keeps a file of data stamps.
 * Each stamp names the page, its runs, their dates and their engine versions.
 * The gate fails on a page with no versions or no run date, and on old data with no newer run in flight.
 * The gate also fails on a run that started behind the engines on npm.
 * This file imports only Node.js and the folder `data`, so `reusable-pages.yml` starts it with no npm release of the package.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { npmPublishTimes } from "../data/npm.ts";
import type { NpmVersionTime } from "../data/types.ts";
import { compareVersions, parseVersion } from "../data/versions.ts";
import type { CheckIo } from "./check.ts";

/** The schema of a file of data stamps. */
export const DATA_STAMP_SCHEMA = "data-stamp/1";

/** The largest age of the data of a page, in days, when no newer run is in flight. */
export const MAX_DATA_AGE_DAYS = 3;

/** The most minor versions that an engine of a run can be behind npm at the start of the run. */
export const MAX_MINORS_BEHIND = 1;

const DAY_MS = 86_400_000;

/** One run that gives the data of a page. */
export interface DataRun {
  readonly id: string;
  readonly url: string;
  /** The ISO time of the start of the run. */
  readonly date: string;
  /** The version of each engine of the run, by its npm name. */
  readonly engines: Readonly<Record<string, string>>;
}

/** The stamp of one measured page. */
export interface PageStamp {
  readonly page: string;
  /** Each run that gives data to the page. */
  readonly runs: readonly DataRun[];
  /** The run on newer engines that is in progress. */
  readonly inFlight?: DataRun;
}

/** The content of a file of data stamps. */
export interface DataStamps {
  readonly schema: typeof DATA_STAMP_SCHEMA;
  readonly pages: readonly PageStamp[];
}

/** The result of `parseDataStamps`. */
export type DataStampsParse = { readonly ok: true; readonly stamps: DataStamps } | { readonly ok: false; readonly faults: readonly string[] };

/** The options of `checkFreshness`. */
export interface FreshnessOptions {
  /** The ISO time of the check. */
  readonly now: string;
  /** The publication times of the engines on npm. */
  readonly times: readonly NpmVersionTime[];
  /** The limit of the age. The default is `MAX_DATA_AGE_DAYS`. */
  readonly maxAgeDays?: number;
  /** The limit of the minor versions. The default is `MAX_MINORS_BEHIND`. */
  readonly maxMinorsBehind?: number;
}

/** The result of `checkFreshness`. */
export interface FreshnessCheck {
  /** Each break of a rule. One fault fails the gate. */
  readonly faults: readonly string[];
  /** Each rule that the gate could not run, with the reason. */
  readonly notRun: readonly string[];
}

const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** This function gives the faults of one run of a stamp. */
function runFaults(raw: unknown, at: string): string[] {
  const run = record(raw);
  if (run === null) return [`${at}: a run is not an object.`];
  const faults: string[] = [];
  if (typeof run["id"] !== "string" || run["id"] === "") faults.push(`${at}: a run has no id.`);
  const label = `${at}, run ${String(run["id"])}`;
  if (typeof run["url"] !== "string" || !run["url"].startsWith("https://")) faults.push(`${label}: the run has no https link.`);
  if (typeof run["date"] !== "string" || !Number.isFinite(Date.parse(run["date"]))) faults.push(`${label}: the run has no date.`);
  const engines = record(run["engines"]);
  if (engines === null || Object.keys(engines).length === 0) return [...faults, `${label}: the run names no engine versions.`];
  for (const [name, version] of Object.entries(engines)) {
    if (typeof version !== "string" || parseVersion(version) === null) faults.push(`${label}: the version of ${name} is not a version.`);
  }
  return faults;
}

/**
 * This function reads the content of a file of data stamps. It gives each fault of the content, so a page with no versions
 * or no run date fails here.
 */
export function parseDataStamps(raw: unknown): DataStampsParse {
  const file = record(raw);
  if (file === null) return { ok: false, faults: ["The file is not an object."] };
  if (file["schema"] !== DATA_STAMP_SCHEMA) return { ok: false, faults: [`The schema is not ${DATA_STAMP_SCHEMA}.`] };
  const pages = file["pages"];
  if (!Array.isArray(pages) || pages.length === 0) return { ok: false, faults: ["The file has no pages."] };
  const faults: string[] = [];
  for (const item of pages) {
    const page = record(item);
    if (page === null || typeof page["page"] !== "string" || page["page"] === "") {
      faults.push("A stamp has no page.");
      continue;
    }
    const at = page["page"];
    const runs = page["runs"];
    if (!Array.isArray(runs) || runs.length === 0) faults.push(`${at}: the page names no run.`);
    else for (const run of runs) faults.push(...runFaults(run, at));
    if (page["inFlight"] !== undefined) faults.push(...runFaults(page["inFlight"], `${at}, in flight`));
  }
  return faults.length > 0 ? { ok: false, faults } : { ok: true, stamps: raw as DataStamps };
}

/** This function gives the count of minor versions from `used` to `latest`. A newer major version counts as no limit. */
export function minorsBehind(used: string, latest: string): number {
  const a = parseVersion(used);
  const b = parseVersion(latest);
  if (a === null || b === null) return Number.POSITIVE_INFINITY;
  if (a.major !== b.major) return b.major > a.major ? Number.POSITIVE_INFINITY : 0;
  return Math.max(0, b.minor - a.minor);
}

/** This function gives the newest stable version of a package on npm at a time, or undefined when npm has none. */
export function latestAt(times: readonly NpmVersionTime[], name: string, date: string): string | undefined {
  const limit = Date.parse(date);
  return times
    .filter((t) => t.name === name && Date.parse(t.date) <= limit && parseVersion(t.version)?.prerelease.length === 0)
    .map((t) => t.version)
    .sort(compareVersions)
    .at(-1);
}

const ageInDays = (date: string, now: number): number => (now - Date.parse(date)) / DAY_MS;

/** This function tells if a run uses a newer version of an engine than another run. */
function hasNewerEngine(run: DataRun, than: DataRun): boolean {
  return Object.entries(run.engines).some(([name, version]) => {
    const old = than.engines[name];
    return old !== undefined && compareVersions(version, old) > 0;
  });
}

/**
 * This function applies the rules of the gate to the stamps.
 *
 * - The data of each page is at most `maxAgeDays` old, or a run on newer engines is in flight.
 * - The engines of the newest run are at most `maxMinorsBehind` behind npm at the start of that run.
 * - A run in flight has the same age limit, so an old stamp does not hold the gate open.
 */
export function checkFreshness(stamps: DataStamps, options: FreshnessOptions): FreshnessCheck {
  const { times, maxAgeDays = MAX_DATA_AGE_DAYS, maxMinorsBehind = MAX_MINORS_BEHIND } = options;
  const now = Date.parse(options.now);
  const faults: string[] = [];
  const notRun: string[] = [];
  for (const stamp of stamps.pages) {
    for (const run of [...stamp.runs, ...(stamp.inFlight === undefined ? [] : [stamp.inFlight])]) {
      if (ageInDays(run.date, now) < 0) faults.push(`${stamp.page}: the run ${run.id} has a date after the check.`);
    }
    const flight = stamp.inFlight;
    const flying = flight !== undefined && ageInDays(flight.date, now) <= maxAgeDays;
    if (flight !== undefined && !flying) faults.push(`${stamp.page}: the run ${flight.id} is in flight for more than ${maxAgeDays} days.`);
    for (const run of stamp.runs) {
      const age = ageInDays(run.date, now);
      if (age > maxAgeDays && !(flying && hasNewerEngine(flight, run))) {
        faults.push(`${stamp.page}: the run ${run.id} is ${age.toFixed(1)} days old, over the limit of ${maxAgeDays}, and no run on newer engines is in flight.`);
      }
    }
    const newest = flight ?? [...stamp.runs].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).at(-1);
    if (newest === undefined) continue;
    for (const [name, version] of Object.entries(newest.engines)) {
      const latest = latestAt(times, name, newest.date);
      if (latest === undefined) {
        notRun.push(`${stamp.page}: npm gives no version of ${name} at the start of the run ${newest.id}.`);
      } else if (minorsBehind(version, latest) > maxMinorsBehind) {
        faults.push(`${stamp.page}: the run ${newest.id} used ${name} ${version}, and npm had ${latest} at its start. The limit is ${maxMinorsBehind} minor version behind.`);
      }
    }
  }
  return { faults, notRun };
}

/** The help of the command `site-pages freshness`. */
export const FRESHNESS_HELP: string = `Usage: site-pages freshness --stamps <file> [options]

Examine the data stamps of the measured pages of a site.

  --stamps <file>  The file of data stamps, schema ${DATA_STAMP_SCHEMA}. (necessary)
  --now <time>     The ISO time of the check. The default is the time of the call.
  --help           Show this text.

The exit code is 0 when the stamps pass, 1 for a fault, and 2 for an incorrect command line.
`;

/** This function is the command `site-pages freshness`. The `fetch` option is for a test. */
export async function runFreshnessCli(argv: readonly string[], io: CheckIo, fetcher?: typeof fetch): Promise<number> {
  let values: { stamps?: string | undefined; now?: string | undefined; help?: boolean | undefined };
  try {
    ({ values } = parseArgs({ args: [...argv], allowPositionals: false, options: { stamps: { type: "string" }, now: { type: "string" }, help: { type: "boolean" } } }));
  } catch (error) {
    io.stderr(`site-pages freshness: ${error instanceof Error ? error.message : String(error)}\n\n${FRESHNESS_HELP}`);
    return 2;
  }
  if (values.help === true) {
    io.stdout(FRESHNESS_HELP);
    return 0;
  }
  if (values.stamps === undefined) {
    io.stderr(`site-pages freshness: --stamps is necessary.\n\n${FRESHNESS_HELP}`);
    return 2;
  }
  const path = isAbsolute(values.stamps) ? values.stamps : join(io.cwd, values.stamps);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    io.stderr(`site-pages freshness: the file ${values.stamps} cannot be read: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const parsed = parseDataStamps(raw);
  if (!parsed.ok) {
    for (const fault of parsed.faults) io.stderr(`${fault}\n`);
    return 1;
  }
  const engines = parsed.stamps.pages.flatMap((p) => [...p.runs, ...(p.inFlight === undefined ? [] : [p.inFlight])]).flatMap((r) => Object.keys(r.engines));
  const npm = await npmPublishTimes({ packages: [...new Set(engines)], ...(fetcher === undefined ? {} : { fetch: fetcher }) });
  const result = checkFreshness(parsed.stamps, { now: values.now ?? new Date().toISOString(), times: npm.times });
  for (const problem of [...npm.problems, ...result.notRun]) io.stdout(`Not run: ${problem}\n`);
  for (const fault of result.faults) io.stderr(`${fault}\n`);
  if (result.faults.length > 0) return 1;
  io.stdout(`The data stamps of ${parsed.stamps.pages.length} pages pass.\n`);
  return 0;
}
