import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { NpmVersionTime, WorkspaceVersion } from "../data/types.ts";
import { checkFreshness, DATA_STAMP_SCHEMA, failingCases, latestAt, minorsBehind, parseDataStamps, runFreshnessCli, VERSION_GRACE_DAYS, WORKSPACE_RULE_START, type DataLimit, type NoAgeLimit, type FreshnessCheck, type FreshnessOptions, type DataRun, type DataStamps, type PageStamp } from "./freshness.ts";
import { scheduleGapDays } from "./schedule.ts";

const ENGINE = "@scope/engine";
const NOW = "2026-11-10T12:00:00Z";
const times: readonly NpmVersionTime[] = [
  { name: ENGINE, version: "0.5.0", date: "2026-10-01T00:00:00Z" },
  { name: ENGINE, version: "0.6.0", date: "2026-11-01T00:00:00Z" },
  { name: ENGINE, version: "0.7.0", date: "2026-11-05T00:00:00Z" },
  { name: ENGINE, version: "0.8.0-rc.1", date: "2026-11-06T00:00:00Z" },
  { name: ENGINE, version: "0.9.0", date: "2026-11-09T00:00:00Z" },
];
const run = (over: Partial<DataRun> = {}): DataRun => ({ id: "7", url: "https://example.com/7", date: "2026-11-09T00:00:00Z", engines: { [ENGINE]: "0.9.0" }, ...over });
const stamps = (runs: readonly DataRun[], inFlight?: DataRun): DataStamps => ({ schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", runs, ...(inFlight === undefined ? {} : { inFlight }) }] });
const check = (s: DataStamps) => checkFreshness(s, { now: NOW, times });
// A start of the version rule before NOW, so that a version break with no grace is a fault.
const STARTED = "2026-11-01T00:00:00Z";
const OWN_TEXT = "index.html: the run 7 used @scope/own 0.4.0, and the repository has 0.6.0 at the build commit. The limit is 1 minor version behind.";
const ownRun = (): DataStamps => stamps([run({ engines: { [ENGINE]: "0.9.0", "@scope/own": "0.4.0" } })]);

describe("parseDataStamps", () => {
  const faults = (raw: unknown): readonly string[] => {
    const parsed = parseDataStamps(raw);
    return parsed.ok ? [] : parsed.faults;
  };

  it("takes a correct file", () => {
    expect(parseDataStamps(stamps([run()])).ok).toBe(true);
  });

  it("fails on a page with no versions", () => {
    expect(faults(stamps([run({ engines: {} })]))[0]).toContain("names no engine versions");
  });

  it("fails on a page with no run date", () => {
    expect(faults(stamps([run({ date: "" })]))[0]).toContain("has no date");
    const { date: _date, ...undated } = run();
    expect(faults(stamps([undated as DataRun]))[0]).toContain("has no date");
  });

  it("fails on a page with no run, and on a version that is not a version", () => {
    expect(faults(stamps([]))[0]).toContain("names no run");
    expect(faults(stamps([run({ engines: { [ENGINE]: "latest" } })]))[0]).toContain("is not a version");
  });

  it("fails on each other wrong shape", () => {
    expect(faults(null)).toEqual(["The file is not an object."]);
    expect(faults({ schema: "other", pages: [] })[0]).toContain("The schema");
    expect(faults({ schema: DATA_STAMP_SCHEMA, pages: [] })).toEqual(["The file has no pages."]);
    expect(faults({ schema: DATA_STAMP_SCHEMA, pages: [{}] })).toEqual(["A stamp has no page."]);
    expect(faults(stamps([run({ id: "" })]))[0]).toContain("has no id");
    expect(faults(stamps([run({ url: "http://example.com" })]))[0]).toContain("no https link");
    expect(faults(stamps([run({ method: " " })]))[0]).toContain("method of the run is not text");
    expect(faults(stamps([run({ method: "lab run" })]))).toEqual([]);
    expect(faults(stamps(["run" as unknown as DataRun]))[0]).toContain("is not an object");
    expect(faults(stamps([run()], run({ engines: {} })))[0]).toContain("in flight");
  });
});

describe("minorsBehind and latestAt", () => {
  it("counts minor versions, and a newer major version has no limit", () => {
    expect(minorsBehind("0.7.0", "0.9.1")).toBe(2);
    expect(minorsBehind("0.9.0", "0.9.0")).toBe(0);
    expect(minorsBehind("0.9.0", "0.8.0")).toBe(0);
    expect(minorsBehind("1.9.0", "2.0.0")).toBe(Number.POSITIVE_INFINITY);
    expect(minorsBehind("2.0.0", "1.9.0")).toBe(0);
    expect(minorsBehind("x", "1.0.0")).toBe(Number.POSITIVE_INFINITY);
  });

  it("gives the newest stable version at a time, not a later one", () => {
    expect(latestAt(times, ENGINE, "2026-11-07T00:00:00Z")).toBe("0.7.0");
    expect(latestAt(times, ENGINE, "2026-09-01T00:00:00Z")).toBeUndefined();
    expect(latestAt(times, "@scope/other", NOW)).toBeUndefined();
  });
});

describe("checkFreshness", () => {
  it("passes on current data", () => {
    expect(check(stamps([run()]))).toEqual({ faults: [], notRun: [], warnings: [] });
  });

  it("fails on data over the age limit with no run in flight", () => {
    const old = run({ date: "2026-11-06T00:00:00Z", engines: { [ENGINE]: "0.7.0" } });
    expect(check(stamps([old])).faults[0]).toContain("4.5 days old, over the limit of 3");
  });

  it("passes on old data when a newer run is in flight", () => {
    const old = run({ id: "1", date: "2026-10-01T00:00:00Z", engines: { [ENGINE]: "0.5.0" } });
    expect(check(stamps([old], run({ id: "2", date: "2026-11-10T00:00:00Z" }))).faults).toEqual([]);
  });

  it("fails on a run in flight over the age limit, so an old stamp does not hold the gate open", () => {
    const old = run({ id: "1", date: "2026-10-01T00:00:00Z", engines: { [ENGINE]: "0.5.0" } });
    const stuck = run({ id: "2", date: "2026-11-05T00:00:00Z", engines: { [ENGINE]: "0.7.0" } });
    const { faults } = check(stamps([old], stuck));
    expect(faults[0]).toContain("in flight for more than 3 days");
    expect(faults[1]).toContain("no run on newer engines is in flight");
  });

  it("does not take a run in flight on the same engines", () => {
    const old = run({ id: "1", date: "2026-11-05T00:00:00Z", engines: { [ENGINE]: "0.9.0" } });
    expect(check(stamps([old], run({ id: "2", date: "2026-11-10T00:00:00Z" }))).faults[0]).toContain("no run on newer engines is in flight");
  });

  it("does not count a release after the start of a run", () => {
    const started = run({ date: "2026-11-08T00:00:00Z", engines: { [ENGINE]: "0.6.0" } });
    expect(check(stamps([started])).faults).toEqual([]);
  });

  it("fails on a run that started more than 1 minor version behind npm", () => {
    const started = run({ date: "2026-11-09T12:00:00Z", engines: { [ENGINE]: "0.7.0" } });
    expect(check(stamps([started])).faults[0]).toContain("used @scope/engine 0.7.0, and npm had 0.9.0");
  });

  it("reads the versions of the run in flight, not of the old data", () => {
    const old = run({ id: "1", date: "2026-10-01T00:00:00Z", engines: { [ENGINE]: "0.5.0" } });
    const behind = run({ id: "2", date: "2026-11-09T12:00:00Z", engines: { [ENGINE]: "0.7.0" } });
    expect(check(stamps([old], behind)).faults[0]).toContain("the run 2 used");
  });

  it("reads the newest of the runs of a page", () => {
    const newer = run({ id: "2" });
    const older = run({ id: "1", date: "2026-11-08T00:00:00Z", engines: { [ENGINE]: "0.6.0" } });
    expect(check(stamps([newer, older])).faults).toEqual([]);
  });

  it("fails on a date after the check", () => {
    expect(check(stamps([run({ date: "2026-12-01T00:00:00Z" })])).faults[0]).toContain("a date after the check");
  });

  it("says that a rule did not run when npm has no version", () => {
    const result = checkFreshness(stamps([run()]), { now: NOW, times: [] });
    expect(result.faults).toEqual([]);
    expect(result.notRun[0]).toContain("npm gives no version");
  });

  it("reads an engine of the same repository from the workspace at the build commit, not from npm", () => {
    const own = (used: string, version: string): FreshnessCheck =>
      checkFreshness(stamps([run({ engines: { [ENGINE]: "0.9.0", "@scope/own": used } })]), { now: NOW, times, workspace: { "@scope/own": [{ version, since: "2026-10-01T00:00:00Z" }] }, workspaceStartsAt: STARTED });
    expect(own("0.4.0", "0.5.0")).toEqual({ faults: [], notRun: [], warnings: [] });
    expect(own("0.4.0", "0.6.0").faults).toEqual(["index.html: the run 7 used @scope/own 0.4.0, and the repository has 0.6.0 at the build commit. The limit is 1 minor version behind."]);
    // The workspace and not npm gives the version of an engine of the repository.
    const behindNpm = run({ date: "2026-11-09T12:00:00Z", engines: { [ENGINE]: "0.7.0" } });
    expect(checkFreshness(stamps([behindNpm]), { now: NOW, times, workspace: { [ENGINE]: [{ version: "0.7.1" }] } }).faults).toEqual([]);
    const ahead = { [ENGINE]: [{ version: "0.11.0", since: "2026-10-01T00:00:00Z" }] };
    expect(checkFreshness(stamps([run()]), { now: NOW, times, workspace: ahead, workspaceStartsAt: STARTED }).faults[0]).toContain("the repository has 0.11.0 at the build commit");
  });

  it("warns on a version break until the grace after the commit that raised the version ends, and fails from then", () => {
    const at = (now: string, history: readonly WorkspaceVersion[], more: Partial<FreshnessOptions> = {}): FreshnessCheck =>
      checkFreshness(ownRun(), { now, times, workspace: { "@scope/own": history }, workspaceStartsAt: STARTED, ...more });
    const raised: readonly WorkspaceVersion[] = [
      { version: "0.6.0", since: "2026-11-09T00:00:00Z" },
      { version: "0.5.0", since: "2026-10-01T00:00:00Z" },
    ];
    expect(VERSION_GRACE_DAYS).toBe(3);
    expect(at(NOW, raised)).toEqual({ faults: [], notRun: [], warnings: [`${OWN_TEXT} The gate fails on it from 2026-11-12T00:00:00.000Z.`] });
    expect(at("2026-11-12T00:00:00Z", raised)).toEqual({ faults: [OWN_TEXT], notRun: [], warnings: [] });
    expect(at(NOW, raised, { versionGraceDays: 0 }).faults).toEqual([OWN_TEXT]);
    // The grace counts from the first version past the limit, not from a later raise.
    const twice: readonly WorkspaceVersion[] = [{ version: "0.7.0", since: "2026-11-10T00:00:00Z" }, ...raised];
    expect(at(NOW, twice).warnings).toEqual([`${OWN_TEXT.replace("0.6.0", "0.7.0")} The gate fails on it from 2026-11-12T00:00:00.000Z.`]);
  });

  it("gives no grace when the clone does not have the commit that raised the version", () => {
    const result = checkFreshness(ownRun(), { now: NOW, times, workspace: { "@scope/own": [{ version: "0.6.0" }] }, workspaceStartsAt: STARTED });
    expect(result.faults).toEqual([`${OWN_TEXT} The clone has no commit that tells when the version passed the limit, so the page has no grace.`]);
  });

  it("warns on each version break before the start of the rule", () => {
    expect(WORKSPACE_RULE_START).toBe("2026-11-30T00:00:00Z");
    const result = checkFreshness(ownRun(), { now: NOW, times, workspace: { "@scope/own": [{ version: "0.6.0" }] } });
    expect(result).toEqual({ faults: [], notRun: [], warnings: [`${OWN_TEXT} The gate fails on it from 2026-11-30T00:00:00.000Z.`] });
  });

  it("says that a rule did not run only for an engine that neither npm nor the workspace has", () => {
    const result = checkFreshness(stamps([run({ engines: { constructor: "1.0.0" } })]), { now: NOW, times: [], workspace: { "@scope/other": [{ version: "1.0.0" }] } });
    expect(result.faults).toEqual([]);
    expect(result.notRun).toEqual(["index.html: npm gives no version of constructor at the start of the run 7, and no package of the repository has that name."]);
  });

  it("takes other limits", () => {
    const old = run({ date: "2026-11-09T12:00:00Z", engines: { [ENGINE]: "0.7.0" } });
    expect(checkFreshness(stamps([old]), { now: NOW, times, maxMinorsBehind: 2 }).faults).toEqual([]);
    expect(checkFreshness(stamps([old]), { now: NOW, times, maxAgeDays: 0.5 }).faults[0]).toContain("over the limit of 0.5");
  });
});

describe("a study with no limit", () => {
  const page = (over: Partial<PageStamp>): DataStamps => ({ schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", runs: [run({ date: "2026-01-01T00:00:00Z", engines: { [ENGINE]: "0.1.0" } })], ...over }] });
  const noLimit: NoAgeLimit = { reproduce: "The code of the study is gone.", today: "The page tells of one day." };

  it("has no age limit and no limit of the engines", () => {
    expect(check(page({ study: true, noLimit }))).toEqual({ faults: [], notRun: [], warnings: [] });
    expect(parseDataStamps(page({ study: true, noLimit })).ok).toBe(true);
  });

  it("needs both statements, or a limit", () => {
    expect(parseDataStamps(page({ study: true }))).toMatchObject({ ok: false, faults: ["index.html: a study needs a limit, or the field noLimit."] });
    expect(parseDataStamps(page({ study: true, noLimit: { ...noLimit, reproduce: " " } }))).toMatchObject({ ok: false, faults: ["index.html: the field noLimit does not say why no run of the current code can reproduce the numbers."] });
    expect(parseDataStamps(page({ study: true, noLimit: { ...noLimit, today: "" } }))).toMatchObject({ ok: false, faults: ["index.html: the field noLimit does not say why the page claims nothing about today."] });
    expect(parseDataStamps(page({ noLimit }))).toMatchObject({ ok: false, faults: ["index.html: only a study has the field noLimit."] });
  });

  it("fails on the same old data with no field study", () => {
    expect(check(page({})).faults.length).toBeGreaterThan(0);
  });

  it("still fails on a date after the check", () => {
    const future: DataStamps = { schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", runs: [run({ date: "2027-01-01T00:00:00Z" })], study: true, noLimit }] };
    expect(check(future).faults[0]).toContain("a date after the check");
  });

  it("refuses a limit together with the statements, and a run in flight", () => {
    const limit: DataLimit = { days: 7, reason: "Weekly.", workflow: "w.yml" };
    expect(parseDataStamps(page({ study: true, limit, noLimit }))).toMatchObject({ ok: false, faults: ["index.html: a page has a limit or the field noLimit, not both."] });
    expect(parseDataStamps(page({ study: true, noLimit, inFlight: run() }))).toMatchObject({ ok: false, faults: ["index.html: a study has no run in flight."] });
  });

  it("can name a two-part image tag, and another page cannot", () => {
    const tagged = [run({ engines: { redis: "7.4" } })];
    expect(parseDataStamps(page({ study: true, noLimit, runs: tagged }))).toMatchObject({ ok: true });
    expect(parseDataStamps(page({ runs: tagged }))).toMatchObject({ ok: false });
    expect(parseDataStamps(page({ study: true, noLimit, runs: [run({ engines: { redis: "latest" } })] }))).toMatchObject({ ok: false });
  });
});

describe("a study with a limit", () => {
  const WORKFLOW = ".github/workflows/study.yml";
  const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
  const limit: DataLimit = { days: 30, reason: "The runs are heavy.", workflow: WORKFLOW, ruling: "https://example.com/ruling" };
  const aged = (days: number, over: Partial<DataRun> = {}): DataRun =>
    run({ date: new Date(Date.parse(NOW) - days * 86_400_000).toISOString(), commit: COMMIT, engines: { [ENGINE]: "0.1.0", redis: "7.4" }, ...over });
  const page = (runs: readonly DataRun[], over: Partial<DataLimit> = {}): DataStamps => ({ schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", study: true, runs, limit: { ...limit, ...over } }] });
  const faults = (stamp: DataStamps, gap: number = 28): readonly string[] => checkFreshness(stamp, { now: NOW, times, schedules: { [WORKFLOW]: gap } }).faults;

  it("passes inside the limit, with no limit of the engines and with a two-part tag", () => {
    expect(parseDataStamps(page([aged(29)])).ok).toBe(true);
    expect(faults(page([aged(29)]))).toEqual([]);
  });

  it("fails over the limit, and for each old run of the page", () => {
    expect(faults(page([aged(31)]))).toEqual(["index.html: the run 7 is 31.0 days old, over the limit of 30, and no run on newer engines is in flight."]);
    expect(faults(page([aged(1), aged(31, { id: "8" })]))).toEqual(["index.html: the run 8 is 31.0 days old, over the limit of 30, and no run on newer engines is in flight."]);
  });

  it("fails on a schedule slower than the limit: a monthly line has a gap of 31 days", () => {
    expect(scheduleGapDays('on:\n  schedule:\n    - cron: "0 5 1 * *"\n')).toBe(31);
    expect(scheduleGapDays('on:\n  schedule:\n    - cron: "0 5 8,30 * *"\n')).toBeLessThanOrEqual(30);
    expect(faults(page([aged(1)]), 31)[0]).toContain("a gap of 31.0 days, over the limit of 30");
  });

  it("fails on a run with no commit, and refuses a commit that is not full", () => {
    expect(faults(page([aged(1, { commit: undefined as unknown as string })]))).toEqual(["index.html: the run 7 names no commit."]);
    expect(parseDataStamps(page([aged(1, { commit: "abcdef0" })]))).toMatchObject({ ok: false, faults: ["index.html, run 7: the commit of the run is not a full commit."] });
  });

  it("takes up to 14 days with no ruling, up to 30 days with a ruling, and no more", () => {
    const { ruling: _ruling, ...noRuling } = limit;
    const bare = (days: number): DataStamps => ({ schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", study: true, runs: [aged(1)], limit: { ...noRuling, days } }] });
    expect(parseDataStamps(bare(14)).ok).toBe(true);
    expect(parseDataStamps(bare(20))).toMatchObject({ ok: false, faults: ["index.html: a limit over 14 days needs a ruling for this site."] });
    expect(parseDataStamps(page([aged(1)], { days: 30 })).ok).toBe(true);
    expect(parseDataStamps(page([aged(1)], { days: 31 }))).toMatchObject({ ok: false, faults: ["index.html: the limit of a study is at most 30 days."] });
    const notStudy: DataStamps = { schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", runs: [run()], limit: { ...limit, days: 31 } }] };
    expect(parseDataStamps(notStudy).ok).toBe(true);
  });

  it("warns on the age rule and the commit rule before the start, fails from the start, and keeps the schedule rule on", () => {
    const old = aged(60, { commit: undefined as unknown as string });
    const start = { startsAt: "2026-12-07T00:00:00Z" };
    expect(parseDataStamps(page([old], start)).ok).toBe(true);
    expect(faults(page([old], start))).toEqual([]);
    expect(checkFreshness(page([old], start), { now: NOW, times, schedules: { [WORKFLOW]: 28 } }).warnings).toEqual([
      "index.html: the run 7 is 60.0 days old, over the limit of 30, and no run on newer engines is in flight. The gate fails on it from 2026-12-07T00:00:00Z.",
      "index.html: the run 7 names no commit. The gate fails on it from 2026-12-07T00:00:00Z.",
    ]);
    expect(faults(page([old], start), 31)[0]).toContain("a gap of 31.0 days");
    const after = checkFreshness(page([old], start), { now: "2026-12-07T00:00:00Z", times, schedules: { [WORKFLOW]: 28 } });
    expect(after.faults[0]).toContain("over the limit of 30");
    expect(after.faults).toContain("index.html: the run 7 names no commit.");
    expect(after.warnings).toEqual([]);
  });

  it("refuses a start after the last start, and a start with no date", () => {
    expect(parseDataStamps(page([aged(1)], { startsAt: "2026-12-07T00:00:01Z" }))).toMatchObject({ ok: false, faults: ["index.html: the start of the limit is after 2026-12-07."] });
    expect(parseDataStamps(page([aged(1)], { startsAt: "soon" }))).toMatchObject({ ok: false, faults: ["index.html: the start of the limit has no date."] });
  });

  it("gives a failing case after the start of the limit, with the age from the date of the data", () => {
    const [one] = failingCases(page([aged(1)], { startsAt: "2026-12-07T00:00:00Z" }), { now: NOW, times, schedules: { [WORKFLOW]: 28 } });
    expect(one?.at).toBe("2026-12-10T12:00:00.000Z");
    expect(one?.fault).toContain("the run 7 is 31.0 days old, over the limit of 30");
  });

  it("gives the start as the failing case of data that is old at the start, so the start never moves the clock", () => {
    const [one] = failingCases(page([aged(60)], { startsAt: "2026-12-07T00:00:00Z" }), { now: NOW, times, schedules: { [WORKFLOW]: 28 } });
    expect(one?.at).toBe("2026-12-07T00:00:00.000Z");
    expect(one?.fault).toContain("the run 7 is 86.5 days old, over the limit of 30");
  });
});

describe("the limit of a page", () => {
  const WORKFLOW = ".github/workflows/scan.yml";
  const limit: DataLimit = { days: 7, reason: "The scan is weekly.", workflow: WORKFLOW };
  const aged = (days: number): DataRun => run({ date: new Date(Date.parse(NOW) - days * 86_400_000).toISOString() });
  const page = (runs: readonly DataRun[], over: Partial<DataLimit> = {}): DataStamps => ({ schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", runs, limit: { ...limit, ...over } }] });

  it("replaces the default age, when the schedule meets it", () => {
    expect(checkFreshness(page([aged(6)]), { now: NOW, times, schedules: { [WORKFLOW]: 7 } }).faults).toEqual([]);
  });

  it("fails on data over the limit", () => {
    expect(checkFreshness(page([aged(8)]), { now: NOW, times, schedules: { [WORKFLOW]: 7 } }).faults[0]).toContain("over the limit of 7");
  });

  it("fails on a limit with no schedule", () => {
    expect(checkFreshness(page([aged(1)]), { now: NOW, times, schedules: {} }).faults[0]).toContain("has no schedule that the gate can read");
    expect(checkFreshness(page([aged(1)]), { now: NOW, times, schedules: { [WORKFLOW]: "the workflow has no line `cron:`" } }).faults[0]).toContain("the workflow has no line `cron:`");
  });

  it("fails on a schedule slower than the limit", () => {
    expect(checkFreshness(page([aged(1)]), { now: NOW, times, schedules: { [WORKFLOW]: 31 } }).faults[0]).toContain("a gap of 31.0 days, over the limit of 7");
  });

  it("needs a ruling for a limit over 14 days", () => {
    expect(parseDataStamps(page([aged(1)], { days: 15 }))).toMatchObject({ ok: false, faults: ["index.html: a limit over 14 days needs a ruling for this site."] });
    expect(parseDataStamps(page([aged(1)], { days: 15, ruling: "https://example.com/ruling" })).ok).toBe(true);
    expect(parseDataStamps(page([aged(1)], { days: 14 })).ok).toBe(true);
  });

  it("refuses a limit with no reason, no days or no workflow", () => {
    expect(parseDataStamps(page([aged(1)], { reason: " " }))).toMatchObject({ ok: false, faults: ["index.html: the limit has no reason."] });
    expect(parseDataStamps(page([aged(1)], { days: 0 }))).toMatchObject({ ok: false, faults: ["index.html: the limit has no count of days."] });
    expect(parseDataStamps(page([aged(1)], { workflow: "" }))).toMatchObject({ ok: false, faults: ["index.html: the limit names no workflow."] });
  });
});

describe("failingCases", () => {
  const cases = (s: DataStamps, more: Partial<FreshnessOptions> = {}) => failingCases(s, { now: NOW, times, ...more });

  it("fails a measured page one day after the limit, from the date of its data", () => {
    const [one] = cases(stamps([run()]));
    expect(one?.at).toBe("2026-11-13T00:00:00.000Z");
    expect(one?.fault).toContain("the run 7 is 4.0 days old, over the limit of 3");
    const [older] = cases(stamps([run({ id: "2" }), run({ id: "1", date: "2026-11-08T00:00:00Z" })]));
    expect(older?.at).toBe("2026-11-12T00:00:00.000Z");
    expect(older?.fault).toContain("the run 1 is 4.0 days old");
  });

  it("uses the limit of the page, and also fails a run in flight", () => {
    const limit: DataLimit = { days: 7, reason: "The scan is weekly.", workflow: "scan.yml" };
    const [one] = cases({ schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", runs: [run()], limit }] }, { schedules: { "scan.yml": 7 } });
    expect(one?.at).toBe("2026-11-17T00:00:00.000Z");
    expect(one?.fault).toContain("over the limit of 7");
    const [flying] = cases(stamps([run()], run({ id: "8", date: "2026-11-10T00:00:00Z", engines: { [ENGINE]: "0.10.0" } })));
    expect(flying?.at).toBe("2026-11-14T00:00:00.000Z");
    expect(flying?.fault).toContain("in flight for more than 3");
  });

  it("fails a study with no limit before the date of its run", () => {
    const [one] = cases({ schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", runs: [run()], study: true, noLimit: { reproduce: "Gone.", today: "One day." } }] });
    expect(one?.at).toBe("2026-11-08T00:00:00.000Z");
    expect(one?.fault).toContain("has a date after the check");
  });

  it("fails a version break at the end of its grace, and not before the start of the rule", () => {
    const workspace = { "@scope/own": [{ version: "0.6.0", since: "2026-11-09T00:00:00Z" }] };
    const [one] = cases(ownRun(), { workspace, workspaceStartsAt: STARTED });
    expect(one).toEqual({ page: "index.html", at: "2026-11-12T00:00:00.000Z", fault: OWN_TEXT });
    // With a long age limit, the start of the rule is the first fault.
    const [late] = cases(ownRun(), { workspace, maxAgeDays: 60 });
    expect(late).toEqual({ page: "index.html", at: "2026-11-30T00:00:00.000Z", fault: OWN_TEXT });
  });

  it("gives one case for each page", () => {
    const pages = [{ page: "a.html", runs: [run()] }, { page: "b.html", runs: [run()] }];
    expect(cases({ schema: DATA_STAMP_SCHEMA, pages }).map((one) => one.page)).toEqual(["a.html", "b.html"]);
  });
});

describe("runFreshnessCli", () => {
  const dir = mkdtempSync(join(tmpdir(), "stamps-"));
  const file = (name: string, content: unknown): string => {
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
    return name;
  };
  const start = async (argv: readonly string[], env: NodeJS.ProcessEnv = {}, cwd: string = dir): Promise<{ code: number; out: string; err: string; asked: string[] }> => {
    let out = "";
    let err = "";
    const asked: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      asked.push(decodeURIComponent(input instanceof Request ? input.url : input.toString()));
      return new Response(JSON.stringify({ versions: Object.fromEntries(times.map((t) => [t.version, {}])), time: Object.fromEntries(times.map((t) => [t.version, t.date])) }));
    }) as typeof fetch;
    const code = await runFreshnessCli(argv, { cwd, env, stdout: (t) => (out += t), stderr: (t) => (err += t) }, fetcher);
    return { code, out, err, asked };
  };

  it("reads the schedule of a limit from the workflow file", async () => {
    file("scan.yml", 'on:\n  schedule:\n    - cron: "23 6 * * 1"\n');
    const limit: DataLimit = { days: 7, reason: "The scan is weekly.", workflow: "scan.yml" };
    const good = await start(["--stamps", file("limit.json", { schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", runs: [run()], limit }] }), "--now", NOW]);
    expect(good.code).toBe(0);
    const lost = await start(["--stamps", file("lost.json", { schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", runs: [run()], limit: { ...limit, workflow: "gone.yml" } }] }), "--now", NOW]);
    expect(lost.code).toBe(1);
    expect(lost.err).toContain("no schedule that the gate can read in gone.yml: the file cannot be read");
  });

  it("fails a page with a limit on a line that it cannot read, and names the line", async () => {
    file("named.yml", 'on:\n  schedule:\n    - cron: "23 6 * * MON"\n');
    const limit: DataLimit = { days: 7, reason: "The scan is weekly.", workflow: "named.yml" };
    const { code, err } = await start(["--stamps", file("named.json", { schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", runs: [run()], limit }] }), "--now", NOW]);
    expect(code).toBe(1);
    expect(err).toContain("in named.yml: the gate cannot read the line `cron: 23 6 * * MON`.");
  });

  it("exits with 0 on correct stamps, and reads npm", async () => {
    const { code, out } = await start(["--stamps", file("good.json", stamps([run()])), "--now", NOW]);
    expect(out).toContain("The data stamps of 1 page pass.");
    expect(out).toContain("Failing case at 2026-11-13T00:00:00.000Z: index.html: the run 7");
    expect(out).not.toContain("Not run");
    expect(code).toBe(0);
  });

  it("exits with 1 on a fault, and on a bad file", async () => {
    const old = await start(["--stamps", file("old.json", stamps([run({ date: "2026-11-01T00:00:00Z", engines: { [ENGINE]: "0.6.0" } })])), "--now", NOW]);
    expect(old.code).toBe(1);
    expect(old.err).toContain("over the limit of 3");
    const empty = await start(["--stamps", file("none.json", stamps([run({ engines: {} })])), "--now", NOW]);
    expect(empty.code).toBe(1);
    expect(empty.err).toContain("names no engine versions");
    const broken = await start(["--stamps", file("bad.json", "{"), "--now", NOW]);
    expect(broken.code).toBe(1);
    expect(broken.err).toContain("cannot be read");
  });

  // The flip of the age check: one stamp with an old date fails, and a clean copy passes, in the same test.
  it("flip: the age check of a study fails on old data, and a clean copy passes", async () => {
    file("study.yml", 'on:\n  schedule:\n    - cron: "0 5 8,30 * *"\n');
    const limit: DataLimit = { days: 30, reason: "The runs are heavy.", workflow: "study.yml", ruling: "https://example.com/ruling" };
    const page = (date: string) => ({ schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", study: true, limit, runs: [run({ date, commit: "abcdef0123456789abcdef0123456789abcdef01", engines: { redis: "7.4" } })] }] });
    const clean = await start(["--stamps", file("clean-study.json", page("2026-11-09T00:00:00Z")), "--now", NOW]);
    expect(clean.code).toBe(0);
    expect(clean.out).toContain("Failing case at 2026-12-10T00:00:00.000Z: index.html: the run 7");
    const old = await start(["--stamps", file("old-study.json", page("2026-10-10T00:00:00Z")), "--now", NOW]);
    expect(old.code).toBe(1);
    expect(old.err).toContain("the run 7 is 31.5 days old, over the limit of 30");
  });

  it("flip: a study with a limit of 20 days and no ruling fails, and a clean copy with a ruling passes", async () => {
    file("study20.yml", 'on:\n  schedule:\n    - cron: "0 5 * * 1"\n');
    const limit: DataLimit = { days: 20, reason: "The runs are heavy.", workflow: "study20.yml" };
    const page = (more: Partial<DataLimit>) => ({ schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", study: true, limit: { ...limit, ...more }, runs: [run({ commit: "abcdef0123456789abcdef0123456789abcdef01" })] }] });
    const clean = await start(["--stamps", file("ruled-study.json", page({ ruling: "https://example.com/ruling" })), "--now", NOW]);
    expect(clean.code).toBe(0);
    const bare = await start(["--stamps", file("bare-study.json", page({})), "--now", NOW]);
    expect(bare.code).toBe(1);
    expect(bare.err).toContain("index.html: a limit over 14 days needs a ruling for this site.");
  });

  it("flip: the age check of a page with the default limit fails on old data, and a clean copy passes", async () => {
    const clean = await start(["--stamps", file("clean-page.json", stamps([run()])), "--now", NOW]);
    expect(clean.code).toBe(0);
    const old = await start(["--stamps", file("old-page.json", stamps([run({ date: "2026-11-06T00:00:00Z" })])), "--now", NOW]);
    expect(old.code).toBe(1);
    expect(old.err).toContain("the run 7 is 4.5 days old, over the limit of 3");
  });

  it("warns on old data before the start of its limit, and gives the start as the failing case", async () => {
    file("later.yml", 'on:\n  schedule:\n    - cron: "0 5 8,30 * *"\n');
    const limit: DataLimit = { days: 30, reason: "The runs are heavy.", workflow: "later.yml", ruling: "https://example.com/ruling", startsAt: "2026-12-07T00:00:00Z" };
    const run7 = run({ date: "2026-10-08T00:00:00Z", commit: "abcdef0123456789abcdef0123456789abcdef01", engines: { redis: "7.4" } });
    const later = file("later.json", { schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", study: true, limit, runs: [run7] }] });
    const local = await start(["--stamps", later, "--now", NOW]);
    expect(local.code).toBe(0);
    expect(local.out).toContain("Warning: index.html: the run 7 is 33.5 days old, over the limit of 30, and no run on newer engines is in flight. The gate fails on it from 2026-12-07T00:00:00Z.\n");
    expect(local.out).toContain("Failing case at 2026-12-07T00:00:00.000Z: index.html: the run 7 is 60.0 days old");
    const actions = await start(["--stamps", later, "--now", NOW], { GITHUB_ACTIONS: "true" });
    expect(actions.out).toContain("::warning::index.html: the run 7 is 33.5 days old");
  });

  it("reads an engine of the same repository from its package.json in git, and does not ask npm for it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "stamps-repo-"));
    writeFileSync(join(repo, ".gitconfig-empty"), "");
    const git = (date: string, ...args: string[]): void => {
      const who = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
      const env = { ...process.env, ...who, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_GLOBAL: join(repo, ".gitconfig-empty"), GIT_CONFIG_NOSYSTEM: "1" };
      execFileSync("git", args, { cwd: repo, stdio: "ignore", env });
    };
    mkdirSync(join(repo, "packages", "own"), { recursive: true });
    mkdirSync(join(repo, "packages", "loose"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", private: true }));
    writeFileSync(join(repo, "packages", "own", "package.json"), JSON.stringify({ name: "@scope/own", version: "0.4.1" }));
    git(STARTED, "init", "-q");
    git(STARTED, "add", "package.json", "packages/own/package.json");
    git(STARTED, "commit", "-q", "-m", "one");
    // A file that git does not track is not a file of the build commit, so its higher version does not count.
    writeFileSync(join(repo, "packages", "loose", "package.json"), JSON.stringify({ name: "@scope/own", version: "0.9.0" }));
    // The check is after the start of the version rule, and the data is one day old.
    const now = "2026-12-01T00:00:00Z";
    const page = (used: string) => ({ schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", runs: [run({ date: "2026-11-30T00:00:00Z", engines: { [ENGINE]: "0.9.0", "@scope/own": used } })] }] });
    writeFileSync(join(repo, "same.json"), JSON.stringify(page("0.4.0")));
    writeFileSync(join(repo, "behind.json"), JSON.stringify(page("0.2.0")));
    const same = await start(["--stamps", "same.json", "--now", now], {}, repo);
    expect(same.code).toBe(0);
    expect(same.out).not.toContain("Not run");
    expect(same.asked.some((url) => url.includes("@scope/own"))).toBe(false);
    expect(same.asked.some((url) => url.includes(ENGINE))).toBe(true);
    const behind = await start(["--stamps", "behind.json", "--now", now], {}, repo);
    expect(behind.code).toBe(1);
    expect(behind.err).toContain("index.html: the run 7 used @scope/own 0.2.0, and the repository has 0.4.1 at the build commit. The limit is 1 minor version behind.\n");
    // A commit of 2026-11-29 raises the version past the limit, so the grace ends on 2026-12-02.
    writeFileSync(join(repo, "packages", "own", "package.json"), JSON.stringify({ name: "@scope/own", version: "0.6.0" }));
    git("2026-11-29T00:00:00Z", "commit", "-q", "-a", "-m", "two");
    const raised = await start(["--stamps", "same.json", "--now", now], {}, repo);
    expect(raised.code).toBe(0);
    expect(raised.out).toContain(`Warning: ${OWN_TEXT} The gate fails on it from 2026-12-02T00:00:00.000Z.\n`);
    expect(raised.out).toContain(`Failing case at 2026-12-02T00:00:00.000Z: ${OWN_TEXT}\n`);
    // A shallow clone does not have the commit that raised the version, so the page has no grace.
    const shallow = mkdtempSync(join(tmpdir(), "stamps-shallow-"));
    git(now, "clone", "-q", "--depth", "1", pathToFileURL(repo).href, shallow);
    writeFileSync(join(shallow, "same.json"), JSON.stringify(page("0.4.0")));
    const clone = await start(["--stamps", "same.json", "--now", now], {}, shallow);
    expect(clone.code).toBe(1);
    expect(clone.err).toContain(`${OWN_TEXT} The clone has no commit that tells when the version passed the limit, so the page has no grace.\n`);
  });

  it("exits with 2 on an incorrect command line, and gives the help", async () => {
    expect((await start([])).code).toBe(2);
    expect((await start(["--other"])).code).toBe(2);
    const help = await start(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("Usage: site-pages freshness");
  });
});
