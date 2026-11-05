import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NpmVersionTime } from "../data/types.ts";
import { checkFreshness, cronLines, DATA_STAMP_SCHEMA, failingCases, latestAt, minorsBehind, parseDataStamps, runFreshnessCli, scheduleGapDays, type DataLimit, type FreshnessOptions, type DataRun, type DataStamps, type PageStamp } from "./freshness.ts";

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
    expect(check(stamps([run()]))).toEqual({ faults: [], notRun: [] });
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

  it("takes other limits", () => {
    const old = run({ date: "2026-11-09T12:00:00Z", engines: { [ENGINE]: "0.7.0" } });
    expect(checkFreshness(stamps([old]), { now: NOW, times, maxMinorsBehind: 2 }).faults).toEqual([]);
    expect(checkFreshness(stamps([old]), { now: NOW, times, maxAgeDays: 0.5 }).faults[0]).toContain("over the limit of 0.5");
  });
});

describe("a fixed study", () => {
  const page = (over: Partial<PageStamp>): DataStamps => ({ schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", runs: [run({ date: "2026-01-01T00:00:00Z", engines: { [ENGINE]: "0.1.0" } })], ...over }] });

  it("has no age limit and no limit of the engines", () => {
    expect(check(page({ study: true }))).toEqual({ faults: [], notRun: [] });
  });

  it("fails on the same old data with no field study", () => {
    expect(check(page({})).faults.length).toBeGreaterThan(0);
  });

  it("still fails on a date after the check", () => {
    const future: DataStamps = { schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", runs: [run({ date: "2027-01-01T00:00:00Z" })], study: true }] };
    expect(check(future).faults[0]).toContain("a date after the check");
  });

  it("refuses a limit and a run in flight", () => {
    const limit: DataLimit = { days: 7, reason: "Weekly.", workflow: "w.yml" };
    expect(parseDataStamps(page({ study: true, limit }))).toMatchObject({ ok: false, faults: ["index.html: a fixed study has no limit."] });
    expect(parseDataStamps(page({ study: true, inFlight: run() }))).toMatchObject({ ok: false, faults: ["index.html: a fixed study has no run in flight."] });
  });

  it("can name a two-part image tag, and another page cannot", () => {
    const tagged = [run({ engines: { redis: "7.4" } })];
    expect(parseDataStamps(page({ study: true, runs: tagged }))).toMatchObject({ ok: true });
    expect(parseDataStamps(page({ runs: tagged }))).toMatchObject({ ok: false });
    expect(parseDataStamps(page({ study: true, runs: [run({ engines: { redis: "latest" } })] }))).toMatchObject({ ok: false });
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

describe("cronLines", () => {
  it("gives the number of each line and its text, in each form that a workflow can write", () => {
    const workflow = [
      "on:",
      "  schedule:",
      '    - cron: "1 2 * * *"',
      "    - cron: '3 4 * * *' # weekly",
      "    - cron: 5 6 * * *",
      '    - "cron": "7 8 * * *"',
      "    # - cron: 9 9 * * *",
    ].join("\r\n");
    expect(cronLines(workflow)).toEqual([
      { line: 3, cron: "1 2 * * *" },
      { line: 4, cron: "3 4 * * *" },
      { line: 5, cron: "5 6 * * *" },
      { line: 6, cron: "7 8 * * *" },
    ]);
  });

  it("gives an empty text for a line with no value, so the gate names the line", () => {
    expect(cronLines("    - cron:")).toEqual([{ line: 1, cron: "" }]);
    expect(scheduleGapDays("    - cron:")).toBe("the gate cannot read the line `cron: `");
  });

  it("does not read another key that starts with the same word", () => {
    expect(cronLines("    cronjob: 1 2 * * *\n    # cron: 1 2 * * *")).toEqual([]);
  });
});

describe("scheduleGapDays", () => {
  const workflow = (...lines: readonly string[]): string => `on:\n  schedule:\n${lines.map((line) => `    - cron: "${line}"`).join("\n")}\n`;

  it("gives 1 for a daily schedule", () => {
    expect(scheduleGapDays(workflow("40 5 * * *"))).toBe(1);
  });

  it("gives 7 for a weekly schedule", () => {
    expect(scheduleGapDays(workflow("23 6 * * 1"))).toBe(7);
  });

  it("gives the longest month for a monthly schedule", () => {
    expect(scheduleGapDays(workflow("0 0 1 * *"))).toBe(31);
  });

  it("joins the lines of a workflow", () => {
    expect(scheduleGapDays(workflow("0 0 * * 1", "0 0 * * 4"))).toBe(4);
  });

  it("reads lists, ranges and steps", () => {
    expect(scheduleGapDays(workflow("0 0 * * 1,3,5"))).toBe(3);
    expect(scheduleGapDays(workflow("0 0 * * 1-5"))).toBe(3);
    expect(scheduleGapDays(workflow("0 0 */2 * *"))).toBe(2);
  });

  it("starts on a day that matches one of the two day fields", () => {
    expect(scheduleGapDays(workflow("0 0 1 * 1"))).toBe(7);
  });

  it("gives a text with no schedule and for a comment", () => {
    expect(scheduleGapDays("on:\n  push:\n")).toBe("the workflow has no line `cron:`");
    expect(scheduleGapDays('on:\n  # - cron: "0 0 * * *"\n  push:\n')).toBe("the workflow has no line `cron:`");
  });

  it("names the line of a form that it cannot read", () => {
    expect(scheduleGapDays(workflow("0 0 * * MON"))).toBe("the gate cannot read the line `cron: 0 0 * * MON`");
    expect(scheduleGapDays(workflow("0 0 * *"))).toBe("the gate cannot read the line `cron: 0 0 * *`");
    expect(scheduleGapDays(workflow("0 0 * * 1", "0 0 * * MON"))).toBe("the gate cannot read the line `cron: 0 0 * * MON`");
  });

  it("names the line of a schedule with one start in two years", () => {
    expect(scheduleGapDays(workflow("0 0 29 2 *"))).toBe("the lines `cron: 0 0 29 2 *` give fewer than two starts in two years");
  });
});

describe("failingCases", () => {
  const cases = (s: DataStamps, more: Partial<FreshnessOptions> = {}) => failingCases(s, { now: NOW, times, ...more });

  it("fails a measured page one day after the limit from the time of the check", () => {
    const [one] = cases(stamps([run()]));
    expect(one?.at).toBe("2026-11-14T12:00:00.000Z");
    expect(one?.fault).toContain("over the limit of 3");
  });

  it("uses the limit of the page, and also fails a run in flight", () => {
    const limit: DataLimit = { days: 7, reason: "The scan is weekly.", workflow: "scan.yml" };
    const [one] = cases({ schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", runs: [run()], limit }] }, { schedules: { "scan.yml": 7 } });
    expect(one?.at).toBe("2026-11-18T12:00:00.000Z");
    expect(one?.fault).toContain("over the limit of 7");
    const [flying] = cases(stamps([run()], run({ id: "8", date: "2026-11-10T00:00:00Z" })));
    expect(flying?.fault).toContain("in flight for more than 3");
  });

  it("fails a fixed study before the date of its run", () => {
    const [one] = cases({ schema: DATA_STAMP_SCHEMA, pages: [{ page: "index.html", runs: [run()], study: true }] });
    expect(one?.at).toBe("2026-11-08T00:00:00.000Z");
    expect(one?.fault).toContain("has a date after the check");
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
  const start = async (argv: readonly string[]): Promise<{ code: number; out: string; err: string }> => {
    let out = "";
    let err = "";
    const fetcher = (async () => new Response(JSON.stringify({ versions: Object.fromEntries(times.map((t) => [t.version, {}])), time: Object.fromEntries(times.map((t) => [t.version, t.date])) }))) as typeof fetch;
    const code = await runFreshnessCli(argv, { cwd: dir, env: {}, stdout: (t) => (out += t), stderr: (t) => (err += t) }, fetcher);
    return { code, out, err };
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
    expect(out).toContain("The data stamps of 1 pages pass.");
    expect(out).toContain("Failing case at 2026-11-14T12:00:00.000Z: index.html: the run 7");
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

  it("exits with 2 on an incorrect command line, and gives the help", async () => {
    expect((await start([])).code).toBe(2);
    expect((await start(["--other"])).code).toBe(2);
    const help = await start(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("Usage: site-pages freshness");
  });
});
