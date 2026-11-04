import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NpmVersionTime } from "../data/types.ts";
import { checkFreshness, DATA_STAMP_SCHEMA, latestAt, minorsBehind, parseDataStamps, runFreshnessCli, type DataRun, type DataStamps } from "./freshness.ts";

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

  it("exits with 0 on correct stamps, and reads npm", async () => {
    const { code, out } = await start(["--stamps", file("good.json", stamps([run()])), "--now", NOW]);
    expect(out).toContain("The data stamps of 1 pages pass.");
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
