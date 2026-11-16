/**
 * The freshness gate of a measured page. A site keeps a file of data stamps.
 * Each stamp names the page, its runs, their dates and their engine versions.
 * The gate fails on a page with no versions or no run date, and on old data with no newer run in flight.
 * The gate also fails on a run behind the engines on npm, or behind a package of the repository at the build commit.
 *
 * Old data before the start of its limit gives a warning, and the gate fails on it from that start.
 * A study has an age limit and a scheduled workflow, or it says why it needs no limit. A page with a longer limit names the reason and the workflow.
 * This file imports only Node.js, the folder `data` and `schedule.ts`, so `reusable-pages.yml` starts it with no npm release of the package.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { workspaceVersions } from "../data/git.ts";
import { npmPublishTimes } from "../data/npm.ts";
import type { NpmVersionTime, WorkspaceVersion } from "../data/types.ts";
import { compareVersions, parseVersion } from "../data/versions.ts";
import type { CheckIo } from "./check.ts";
import { scheduleGapDays } from "./schedule.ts";

/** The schema of a file of data stamps. */
export const DATA_STAMP_SCHEMA = "data-stamp/1";

/** The largest age of the data of a page, in days, when no newer run is in flight. */
export const MAX_DATA_AGE_DAYS = 3;

/** The most minor versions that an engine of a run can be behind npm at the start of the run. */
export const MAX_MINORS_BEHIND = 1;

/** The longest limit of a page, in days, with no ruling for that site. */
export const MAX_LIMIT_DAYS_WITHOUT_RULING = 14;

/** The longest limit of a study, in days, also with a ruling. A study over `MAX_LIMIT_DAYS_WITHOUT_RULING` also needs a ruling. */
export const MAX_STUDY_LIMIT_DAYS = 30;

/** The last time at which a limit can start. A limit turns on at this time if its site did not turn it on before. */
export const LAST_LIMIT_START = "2026-12-07T00:00:00Z";

/** The days after the commit that raised a package of the repository past the limit, before a fault. A rerun needs that time. */
export const VERSION_GRACE_DAYS = 3;

/** The start of the version rule for an engine of the same repository. Before it, a break of that rule is a warning. */
export const WORKSPACE_RULE_START = "2026-11-30T00:00:00Z";

const DAY_MS = 86_400_000;

/** The form of a full commit. */
const FULL_COMMIT = /^[0-9a-f]{40}$/;

/** One run that gives the data of a page. */
export interface DataRun {
  readonly id: string;
  readonly url: string;
  /** The ISO time of the start of the run. */
  readonly date: string;
  /** The version of each engine of the run, by its npm name. */
  readonly engines: Readonly<Record<string, string>>;
  /** The words for data that no CI run made, for example `lab run` or `hand count`. The page shows them in place of `run`. */
  readonly method?: string;
  /** The full commit of the code that ran. It is not the commit that added a copy of the data. A study with a limit in force needs it. */
  readonly commit?: string;
}

/** The age limit of one page, in place of `MAX_DATA_AGE_DAYS`. */
export interface DataLimit {
  /** The largest age of the data, in days. */
  readonly days: number;
  /** The reason for the limit, as one sentence. The page shows it. */
  readonly reason: string;
  /** The path of the workflow from the root of the repository. Its schedule must meet the limit. */
  readonly workflow: string;
  /** The link to the public ruling. A limit over `MAX_LIMIT_DAYS_WITHOUT_RULING` needs it. */
  readonly ruling?: string;
  /** The ISO time at which the age rule and the commit rule start, at most `LAST_LIMIT_START`. A site removes this field at the first green read of its workflow. */
  readonly startsAt?: string;
}

/** The two statements of a study with no age limit. The page shows both. */
export interface NoAgeLimit {
  /** The reason that no run of the current code can reproduce the numbers. */
  readonly reproduce: string;
  /** The reason that the page claims nothing about today. */
  readonly today: string;
}

/** The stamp of one measured page. */
export interface PageStamp {
  readonly page: string;
  /** Each run that gives data to the page. */
  readonly runs: readonly DataRun[];
  /** The run on newer engines that is in progress. */
  readonly inFlight?: DataRun;
  /** The page shows a study of the versions of its runs. A study has a `limit` or the field `noLimit`, and the rule of the engines does not apply to it. */
  readonly study?: true;
  /** The age limit of this page, in place of the default. */
  readonly limit?: DataLimit;
  /** The statements of a study with no age limit. */
  readonly noLimit?: NoAgeLimit;
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
  /** The schedule of each workflow of a limit. A number is the largest gap between its starts in days. A text tells why the gate cannot read it. */
  readonly schedules?: Readonly<Record<string, number | string>>;
  /**
   * The versions of each package of the repository, by its npm name. The first version is the version at the build commit.
   * An engine with a name here is a package of the same repository, so the gate reads its version here and not on npm.
   */
  readonly workspace?: Readonly<Record<string, readonly WorkspaceVersion[]>>;
  /** The days of grace after the commit that raised a package of the repository past the limit. The default is `VERSION_GRACE_DAYS`. */
  readonly versionGraceDays?: number;
  /** The start of the version rule for an engine of the same repository. The default is `WORKSPACE_RULE_START`. */
  readonly workspaceStartsAt?: string;
}

/** The result of `checkFreshness`. */
export interface FreshnessCheck {
  /** Each break of a rule. One fault fails the gate. */
  readonly faults: readonly string[];
  /** Each rule that the gate could not run, with the reason. */
  readonly notRun: readonly string[];
  /** Each break before the gate fails on it, with the time from which it fails. A warning does not fail the gate. */
  readonly warnings: readonly string[];
}

const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** The form of a two-part image tag, for example `7.4`. A fixed study can name it, because no check compares the versions of a study. */
const IMAGE_TAG = /^\d+\.\d+$/;

/** This function gives the faults of one run of a stamp. */
function runFaults(raw: unknown, at: string, study = false): string[] {
  const run = record(raw);
  if (run === null) return [`${at}: a run is not an object.`];
  const faults: string[] = [];
  if (typeof run["id"] !== "string" || run["id"] === "") faults.push(`${at}: a run has no id.`);
  const label = `${at}, run ${String(run["id"])}`;
  if (typeof run["url"] !== "string" || !run["url"].startsWith("https://")) faults.push(`${label}: the run has no https link.`);
  if (typeof run["date"] !== "string" || !Number.isFinite(Date.parse(run["date"]))) faults.push(`${label}: the run has no date.`);
  if (run["method"] !== undefined && (typeof run["method"] !== "string" || run["method"].trim() === "")) faults.push(`${label}: the method of the run is not text.`);
  if (run["commit"] !== undefined && (typeof run["commit"] !== "string" || !FULL_COMMIT.test(run["commit"]))) faults.push(`${label}: the commit of the run is not a full commit.`);
  const engines = record(run["engines"]);
  if (engines === null || Object.keys(engines).length === 0) return [...faults, `${label}: the run names no engine versions.`];
  for (const [name, version] of Object.entries(engines)) {
    const known = typeof version === "string" && (parseVersion(version) !== null || (study && IMAGE_TAG.test(version)));
    if (!known) faults.push(`${label}: the version of ${name} is not a version.`);
  }
  return faults;
}

/** This function gives the faults of the age limit of one page. */
function limitFaults(raw: unknown, at: string, study: boolean): string[] {
  const limit = record(raw);
  if (limit === null) return [`${at}: the limit is not an object.`];
  const faults: string[] = [];
  const days = limit["days"];
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) faults.push(`${at}: the limit has no count of days.`);
  if (typeof limit["reason"] !== "string" || limit["reason"].trim() === "") faults.push(`${at}: the limit has no reason.`);
  if (typeof limit["workflow"] !== "string" || limit["workflow"] === "") faults.push(`${at}: the limit names no workflow.`);
  const ruling = limit["ruling"];
  if (ruling !== undefined && (typeof ruling !== "string" || !ruling.startsWith("https://"))) faults.push(`${at}: the ruling of the limit has no https link.`);
  if (typeof days === "number" && days > MAX_LIMIT_DAYS_WITHOUT_RULING && ruling === undefined) {
    faults.push(`${at}: a limit over ${MAX_LIMIT_DAYS_WITHOUT_RULING} days needs a ruling for this site.`);
  }
  if (study && typeof days === "number" && days > MAX_STUDY_LIMIT_DAYS) faults.push(`${at}: the limit of a study is at most ${MAX_STUDY_LIMIT_DAYS} days.`);
  const startsAt = limit["startsAt"];
  if (startsAt !== undefined) {
    if (typeof startsAt !== "string" || !Number.isFinite(Date.parse(startsAt))) faults.push(`${at}: the start of the limit has no date.`);
    else if (Date.parse(startsAt) > Date.parse(LAST_LIMIT_START)) faults.push(`${at}: the start of the limit is after ${LAST_LIMIT_START.slice(0, 10)}.`);
  }
  return faults;
}

/** This function gives the faults of the statements of a study with no age limit. */
function noLimitFaults(raw: unknown, at: string): string[] {
  const statements = record(raw);
  if (statements === null) return [`${at}: the field noLimit is not an object.`];
  const faults: string[] = [];
  const said = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";
  if (!said(statements["reproduce"])) faults.push(`${at}: the field noLimit does not say why no run of the current code can reproduce the numbers.`);
  if (!said(statements["today"])) faults.push(`${at}: the field noLimit does not say why the page claims nothing about today.`);
  return faults;
}

/** This function gives the faults of the fields of a page that change the age rule. */
function ageRuleFaults(page: Record<string, unknown>, at: string): string[] {
  const faults: string[] = [];
  const study = page["study"];
  if (study !== undefined && study !== true) faults.push(`${at}: the field study is not true.`);
  const limit = page["limit"];
  const noLimit = page["noLimit"];
  if (study === true && limit === undefined && noLimit === undefined) faults.push(`${at}: a study needs a limit, or the field noLimit.`);
  if (limit !== undefined && noLimit !== undefined) faults.push(`${at}: a page has a limit or the field noLimit, not both.`);
  if (study !== true && noLimit !== undefined) faults.push(`${at}: only a study has the field noLimit.`);
  if (study === true && page["inFlight"] !== undefined) faults.push(`${at}: a study has no run in flight.`);
  if (limit !== undefined) faults.push(...limitFaults(limit, at, study === true));
  if (noLimit !== undefined) faults.push(...noLimitFaults(noLimit, at));
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
    else for (const run of runs) faults.push(...runFaults(run, at, page["study"] === true));
    if (page["inFlight"] !== undefined) faults.push(...runFaults(page["inFlight"], `${at}, in flight`));
    faults.push(...ageRuleFaults(page, at));
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

/** This function gives the newest run of a stamp: the run in flight, or else the run with the latest date. */
function newestRun(stamp: PageStamp): DataRun | undefined {
  return stamp.inFlight ?? [...stamp.runs].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).at(-1);
}

/** A break of the version rule by an engine that is a package of the repository. */
interface OwnBreak {
  readonly name: string;
  readonly version: string;
  readonly own: string;
  /** The time from which the gate fails on the break. */
  readonly failsAt: number;
  /** This value is true when the history gives the commit that raised the package past the limit. */
  readonly known: boolean;
}

/**
 * This function gives each engine of a run that is more than `maxMinorsBehind` behind its package in the repository. The
 * gate fails on a break `graceDays` after the commit that raised the package past the limit, and not before `startsAt`.
 */
function ownBreaks(run: DataRun, workspace: Readonly<Record<string, readonly WorkspaceVersion[]>>, maxMinorsBehind: number, graceDays: number, startsAt: string): OwnBreak[] {
  const breaks: OwnBreak[] = [];
  for (const [name, version] of Object.entries(run.engines)) {
    // A key of the object prototype, for example "constructor", is not a package of the repository.
    const history = Object.hasOwn(workspace, name) ? (workspace[name] ?? []) : [];
    const own = history[0];
    if (own === undefined || minorsBehind(version, own.version) <= maxMinorsBehind) continue;
    // The break starts at the oldest version of the newest versions that are all past the limit.
    let raised: string | undefined;
    for (const entry of history) {
      if (minorsBehind(version, entry.version) <= maxMinorsBehind) break;
      raised = entry.since;
      if (raised === undefined) break;
    }
    const start = Date.parse(startsAt);
    const failsAt = raised === undefined ? start : Math.max(start, Date.parse(raised) + graceDays * DAY_MS);
    breaks.push({ name, version, own: own.version, failsAt, known: raised !== undefined });
  }
  return breaks;
}

/**
 * This function applies the rules of the gate to the stamps.
 *
 * - The data of each page is at most `maxAgeDays` old, or a run on newer engines is in flight.
 * - The engines of the newest run are at most `maxMinorsBehind` behind npm at the start of that run.
 * - An engine that is a package of the repository is at most `maxMinorsBehind` behind its version at the build commit.
 *   The gate fails on a break `versionGraceDays` after the commit that raised the version, and not before `workspaceStartsAt`.
 *   Before that time, the break is a warning.
 * - A run in flight has the same age limit, so an old stamp does not hold the gate open.
 * - A page with its own limit uses that limit, and the schedule of its workflow meets the limit.
 * - A study has no limit of the engines, because it tells about the versions that it names.
 * - A study with a limit in force names the commit of each run. A study with no limit has no age rule.
 * - A limit with `startsAt` applies the age rule and the commit rule from that time. Before it, each break is a warning.
 *   The age is always the time of the check minus the date of the data. The schedule rule applies at once.
 */
export function checkFreshness(stamps: DataStamps, options: FreshnessOptions): FreshnessCheck {
  const { times, maxAgeDays: defaultAge = MAX_DATA_AGE_DAYS, maxMinorsBehind = MAX_MINORS_BEHIND, schedules = {}, workspace = {} } = options;
  const { versionGraceDays = VERSION_GRACE_DAYS, workspaceStartsAt = WORKSPACE_RULE_START } = options;
  const now = Date.parse(options.now);
  const faults: string[] = [];
  const notRun: string[] = [];
  const warnings: string[] = [];
  for (const stamp of stamps.pages) {
    for (const run of [...stamp.runs, ...(stamp.inFlight === undefined ? [] : [stamp.inFlight])]) {
      if (ageInDays(run.date, now) < 0) faults.push(`${stamp.page}: the run ${run.id} has a date after the check.`);
    }
    if (stamp.study === true && stamp.limit === undefined) continue;
    const maxAgeDays = stamp.limit?.days ?? defaultAge;
    const startsAt = stamp.limit?.startsAt;
    const inForce = startsAt === undefined || Date.parse(startsAt) <= now;
    // Before the start of the limit, a break of the age rule or of the commit rule is a warning. The age stays the same.
    const atStart = (text: string): void => {
      if (inForce) faults.push(text);
      else warnings.push(`${text} The gate fails on it from ${String(startsAt)}.`);
    };
    if (stamp.limit !== undefined) {
      const gap = schedules[stamp.limit.workflow];
      if (gap === undefined || typeof gap === "string") faults.push(`${stamp.page}: the limit of ${maxAgeDays} days has no schedule that the gate can read in ${stamp.limit.workflow}: ${gap ?? "the check has no read of this workflow"}.`);
      else if (gap > maxAgeDays) faults.push(`${stamp.page}: the schedule of ${stamp.limit.workflow} has a gap of ${gap.toFixed(1)} days, over the limit of ${maxAgeDays}.`);
    }
    const flight = stamp.inFlight;
    const flying = flight !== undefined && ageInDays(flight.date, now) <= maxAgeDays;
    if (flight !== undefined && !flying) faults.push(`${stamp.page}: the run ${flight.id} is in flight for more than ${maxAgeDays} days.`);
    for (const run of stamp.runs) {
      const age = ageInDays(run.date, now);
      if (age > maxAgeDays && !(flying && hasNewerEngine(flight, run))) {
        atStart(`${stamp.page}: the run ${run.id} is ${age.toFixed(1)} days old, over the limit of ${maxAgeDays}, and no run on newer engines is in flight.`);
      }
    }
    if (stamp.study === true) {
      for (const run of stamp.runs) if (run.commit === undefined) atStart(`${stamp.page}: the run ${run.id} names no commit.`);
      continue;
    }
    const newest = newestRun(stamp);
    if (newest === undefined) continue;
    for (const own of ownBreaks(newest, workspace, maxMinorsBehind, versionGraceDays, workspaceStartsAt)) {
      const text = `${stamp.page}: the run ${newest.id} used ${own.name} ${own.version}, and the repository has ${own.own} at the build commit. The limit is ${maxMinorsBehind} minor version behind.`;
      if (now < own.failsAt) warnings.push(`${text} The gate fails on it from ${new Date(own.failsAt).toISOString()}.`);
      else if (own.known) faults.push(text);
      else faults.push(`${text} The clone has no commit that tells when the version passed the limit, so the page has no grace.`);
    }
    for (const [name, version] of Object.entries(newest.engines)) {
      // A key of the object prototype, for example "constructor", is not a package of the repository.
      if (Object.hasOwn(workspace, name)) continue;
      const latest = latestAt(times, name, newest.date);
      if (latest === undefined) {
        notRun.push(`${stamp.page}: npm gives no version of ${name} at the start of the run ${newest.id}, and no package of the repository has that name.`);
      } else if (minorsBehind(version, latest) > maxMinorsBehind) {
        faults.push(`${stamp.page}: the run ${newest.id} used ${name} ${version}, and npm had ${latest} at its start. The limit is ${maxMinorsBehind} minor version behind.`);
      }
    }
  }
  return { faults, notRun, warnings };
}

/** A time at which the gate must fail for a page, and what the gate says at that time. */
export interface FailingCase {
  /** The path of the page. */
  readonly page: string;
  /** The ISO time of the case. */
  readonly at: string;
  /** The first fault at that time. A case with no fault tells that the gate does not hold the page. */
  readonly fault?: string;
}

/**
 * This function gives one failing case for each page, from the stamps of the site itself. The case is the first time at
 * which the gate fails on the page. That time is one day after the limit of a run or of the run in flight. When the data is
 * old at the start of the limit, the time is that start. The age always counts from the date of the data. For a version
 * break of an engine of the same repository, the time is the end of its grace.
 *
 * A study with no limit must fail before the date of its run. Stamps that pass and give a case with no fault tell that the
 * gate does not examine that page.
 */
export function failingCases(stamps: DataStamps, options: FreshnessOptions): readonly FailingCase[] {
  return stamps.pages.map((stamp) => {
    const only: DataStamps = { schema: stamps.schema, pages: [stamp] };
    const dates = [...stamp.runs, ...(stamp.inFlight === undefined ? [] : [stamp.inFlight])].map((run) => Date.parse(run.date));
    const days = stamp.limit?.days ?? options.maxAgeDays ?? MAX_DATA_AGE_DAYS;
    // The gate examines the page from the time of the check, and the age rule is in force from the start of the limit.
    const from = Math.max(Date.parse(options.now), Date.parse(stamp.limit?.startsAt ?? options.now));
    const newest = newestRun(stamp);
    const graces =
      stamp.study === true || newest === undefined
        ? []
        : ownBreaks(newest, options.workspace ?? {}, options.maxMinorsBehind ?? MAX_MINORS_BEHIND, options.versionGraceDays ?? VERSION_GRACE_DAYS, options.workspaceStartsAt ?? WORKSPACE_RULE_START).map((one) => one.failsAt);
    const later = [...dates.map((date) => date + (days + 1) * DAY_MS), ...graces].filter((time) => time > from).sort((a, b) => a - b);
    const candidates = stamp.study === true && stamp.limit === undefined ? [Math.min(...dates) - DAY_MS] : [from, ...later];
    let at = "";
    for (const time of candidates) {
      at = new Date(time).toISOString();
      const [fault] = checkFreshness(only, { ...options, now: at }).faults;
      if (fault !== undefined) return { page: stamp.page, at, fault };
    }
    return { page: stamp.page, at };
  });
}

/** The help of the command `site-pages freshness`. */
export const FRESHNESS_HELP: string = `Usage: site-pages freshness --stamps <file> [options]

Examine the data stamps of the measured pages of a site.

  --stamps <file>  The file of data stamps, schema ${DATA_STAMP_SCHEMA}. (necessary)
  --now <time>     The ISO time of the check. The default is the time of the call.
  --help           Show this text.

The exit code is 0 when the stamps pass, 1 for a fault, and 2 for an incorrect command line.
Stamps that pass also show one failing case for each page. A page with no failing case is a fault.
An engine that is a package of the repository has its version from its package.json at the build commit, not from npm.
A version break of such an engine warns until ${VERSION_GRACE_DAYS} days after the commit that raised the version.
That rule starts at ${WORKSPACE_RULE_START}. Before it, each break of that rule is a warning.
Old data before the start of its limit gives a warning, and the gate fails on it from that start.
`;

/** This function gives the largest gap of the schedule in a workflow file. It gives a text for a file that it cannot read. */
function readSchedule(path: string): number | string {
  try {
    return scheduleGapDays(readFileSync(path, "utf8"));
  } catch (error) {
    return `the file cannot be read: ${error instanceof Error ? error.message : String(error)}`;
  }
}

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
  // An engine that is a package of the repository has its version from the build commit, so the gate does not ask npm.
  const workspace = workspaceVersions(io.cwd);
  const engines = parsed.stamps.pages
    .filter((p) => p.study !== true)
    .flatMap((p) => [...p.runs, ...(p.inFlight === undefined ? [] : [p.inFlight])])
    .flatMap((r) => Object.keys(r.engines))
    .filter((name) => !Object.hasOwn(workspace, name));
  const schedules: Record<string, number | string> = {};
  for (const page of parsed.stamps.pages) {
    if (page.limit !== undefined) schedules[page.limit.workflow] = readSchedule(join(io.cwd, page.limit.workflow));
  }
  const npm = await npmPublishTimes({ packages: [...new Set(engines)], ...(fetcher === undefined ? {} : { fetch: fetcher }) });
  const options: FreshnessOptions = { now: values.now ?? new Date().toISOString(), times: npm.times, schedules, workspace };
  const result = checkFreshness(parsed.stamps, options);
  for (const problem of [...npm.problems, ...result.notRun]) io.stdout(`Not run: ${problem}\n`);
  // In GitHub Actions, a warning is an annotation of the run.
  const warning = io.env["GITHUB_ACTIONS"] === "true" ? "::warning::" : "Warning: ";
  for (const text of result.warnings) io.stdout(`${warning}${text}\n`);
  for (const fault of result.faults) io.stderr(`${fault}\n`);
  if (result.faults.length > 0) return 1;
  io.stdout(`The data stamps of ${parsed.stamps.pages.length} ${parsed.stamps.pages.length === 1 ? "page" : "pages"} pass.\n`);
  let held = true;
  for (const { page, at, fault } of failingCases(parsed.stamps, options)) {
    if (fault === undefined) {
      io.stderr(`${page}: the gate does not fail at ${at}, so it does not hold this page.\n`);
      held = false;
    } else {
      io.stdout(`Failing case at ${at}: ${fault}\n`);
    }
  }
  return held ? 0 : 1;
}
