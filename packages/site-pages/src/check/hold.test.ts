import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunProgress } from "../data/github.ts";
import type { NpmVersionTime } from "../data/types.ts";
import { checkFreshness, DATA_STAMP_SCHEMA, failingCases, MAX_HOLD_HOURS, MAX_STALL_HOURS, parseDataStamps, runFreshnessCli, type DataRun, type DataStamps, type FlightHold } from "./freshness.ts";

const ENGINE = "@scope/engine";
const times: readonly NpmVersionTime[] = [
  { name: ENGINE, version: "0.6.0", date: "2026-11-01T00:00:00Z" },
  { name: ENGINE, version: "0.7.0", date: "2026-11-05T00:00:00Z" },
];
/** The check is 3.75 days after the start of the run in flight, so the run is past the default limit of 3 days. */
const NOW = "2026-11-10T06:00:00Z";
const old: DataRun = { id: "6", url: "https://github.com/o/r/actions/runs/6", date: "2026-11-01T00:00:00Z", engines: { [ENGINE]: "0.6.0" } };
const flight: DataRun = { id: "41", url: "https://github.com/o/r/actions/runs/41", date: "2026-11-06T12:00:00Z", engines: { [ENGINE]: "0.7.0" } };
const hold: FlightHold = { until: "2026-11-10T12:00:00Z", stallHours: 6, reason: "The shared queue of CI is full, and the run still ends its jobs." };
const stamps = (over: { hold?: FlightHold | undefined; inFlight?: DataRun | undefined } = {}): DataStamps => {
  const page = { page: "index.html", runs: [old], inFlight: flight, hold, ...over };
  return { schema: DATA_STAMP_SCHEMA, pages: [Object.fromEntries(Object.entries(page).filter(([, v]) => v !== undefined)) as unknown as DataStamps["pages"][number]] };
};
const progress = (over: Partial<RunProgress> = {}): RunProgress => ({ status: "in_progress", conclusion: null, lastJobEnd: "2026-11-10T01:00:00Z", ...over });
const check = (read: RunProgress | string | undefined, now = NOW, s = stamps()) => checkFreshness(s, { now, times, ...(read === undefined ? {} : { progress: { [flight.id]: read } }) }).faults;

describe("the hold of a run in flight", () => {
  it("keeps a slow run in flight past the age limit while its jobs end", () => {
    expect(check(progress())).toEqual([]);
  });

  it("flip: a run whose last job ended 7 hours ago fails, and 5 hours ago passes", () => {
    expect(check(progress({ lastJobEnd: "2026-11-10T01:00:00Z" }))).toEqual([]);
    const [fault] = check(progress({ lastJobEnd: "2026-11-09T23:00:00Z" }));
    expect(fault).toBe("index.html: the run 41 is in flight for more than 3 days, and its hold ends: no job of the run ended in the last 6 hours, and the last job ended at 2026-11-09T23:00:00Z.");
  });

  it("flip: a run past the end of its hold fails, though a job ended 30 minutes ago", () => {
    expect(check(progress({ lastJobEnd: "2026-11-10T11:30:00Z" }), "2026-11-10T12:00:00Z")).toEqual([]);
    const [fault] = check(progress({ lastJobEnd: "2026-11-10T12:00:00Z" }), "2026-11-10T12:30:00Z");
    expect(fault).toContain("its hold ends: the hold ended at 2026-11-10T12:00:00Z");
  });

  it("ends at once when the run fails or is cancelled", () => {
    expect(check(progress({ status: "completed", conclusion: "failure" }))[0]).toContain("the run ended with the result failure");
    expect(check(progress({ status: "completed", conclusion: "cancelled" }))[0]).toContain("the run ended with the result cancelled");
  });

  it("keeps a run that passed while its data lands, inside the stall hours", () => {
    expect(check(progress({ status: "completed", conclusion: "success", lastJobEnd: "2026-11-10T04:00:00Z" }))).toEqual([]);
  });

  it("counts from the start of the run when no job ended", () => {
    expect(check(progress({ lastJobEnd: null }))[0]).toContain("no job of the run ended in the last 6 hours.");
  });

  it("fails when the gate has no read of the progress, so a failed read of GitHub is not a pass", () => {
    expect(check(undefined)[0]).toContain("the gate has no read of the progress of the run");
    expect(check("GitHub answered with HTTP 502")[0]).toContain("the gate cannot read the progress of the run: GitHub answered with HTTP 502");
  });

  it("needs no read while the run in flight is inside the age limit", () => {
    expect(check(undefined, "2026-11-08T12:00:00Z")).toEqual([]);
  });

  it("gives a failing case one day after the limit", () => {
    const [found] = failingCases(stamps(), { now: NOW, times, progress: { [flight.id]: progress() } });
    expect(found?.fault).toContain("its hold ends");
  });
});

describe("the parse of a hold", () => {
  const faults = (raw: unknown): readonly string[] => {
    const parsed = parseDataStamps(raw);
    return parsed.ok ? [] : parsed.faults;
  };

  it("takes a correct hold", () => {
    expect(faults(stamps())).toEqual([]);
  });

  it(`refuses a hold with no run in flight, or more than ${MAX_HOLD_HOURS} hours after the start of the run`, () => {
    expect(faults(stamps({ inFlight: undefined }))).toContain("index.html: a hold needs a run in flight.");
    expect(faults(stamps({ hold: { ...hold, until: "2026-11-10T12:00:01Z" } }))).toContain(`index.html: the hold ends more than ${MAX_HOLD_HOURS} hours after the start of the run in flight.`);
    expect(faults(stamps({ hold: { ...hold, until: "2026-11-06T11:00:00Z" } }))).toContain("index.html: the hold ends before the start of the run in flight.");
    expect(faults(stamps({ hold: { ...hold, until: "soon" } }))).toContain("index.html: the hold has no end time.");
  });

  it(`refuses stall hours of 0 or over ${MAX_STALL_HOURS}, and a hold with no reason`, () => {
    const stall = `index.html: the hold needs a count of stall hours above 0 and at most ${MAX_STALL_HOURS}.`;
    expect(faults(stamps({ hold: { ...hold, stallHours: 0 } }))).toContain(stall);
    expect(faults(stamps({ hold: { ...hold, stallHours: MAX_STALL_HOURS + 1 } }))).toContain(stall);
    expect(faults(stamps({ hold: { ...hold, stallHours: MAX_STALL_HOURS } }))).toEqual([]);
    expect(faults(stamps({ hold: { ...hold, reason: " " } }))).toContain("index.html: the hold has no reason.");
  });
});

describe("the command with a hold", () => {
  const dir = mkdtempSync(join(tmpdir(), "hold-"));
  const file = (name: string, content: unknown): string => {
    writeFileSync(join(dir, name), JSON.stringify(content));
    return name;
  };
  const npm = { versions: Object.fromEntries(times.map((t) => [t.version, {}])), time: Object.fromEntries(times.map((t) => [t.version, t.date])) };
  const start = async (lastJobEnd: string, env: Record<string, string> = { GITHUB_TOKEN: "t" }) => {
    let out = "";
    let err = "";
    const asked: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      if (url === "https://api.github.com/repos/o/r/actions/runs/41") return new Response(JSON.stringify({ status: "in_progress", conclusion: null }));
      if (url.startsWith("https://api.github.com/repos/o/r/actions/runs/41/jobs")) return new Response(JSON.stringify({ jobs: [{ completed_at: "2026-11-09T20:00:00Z" }, { completed_at: lastJobEnd }, { completed_at: null }] }));
      return new Response(JSON.stringify(npm));
    }) as typeof fetch;
    const code = await runFreshnessCli(["--stamps", file("held.json", stamps()), "--now", NOW], { cwd: dir, env, stdout: (t) => (out += t), stderr: (t) => (err += t) }, fetcher);
    return { code, out, err, asked };
  };

  it("flip: the real command passes on a run whose last job ended 5 hours ago, and fails at 7 hours", async () => {
    const live = await start("2026-11-10T01:00:00Z");
    expect(live.code).toBe(0);
    expect(live.out).toContain("Hold of the run 41 to 2026-11-10T12:00:00Z: in_progress, the last job ended at 2026-11-10T01:00:00Z.");
    expect(live.asked).toContain("https://api.github.com/repos/o/r/actions/runs/41/jobs?filter=latest&per_page=100");
    const stalled = await start("2026-11-09T23:00:00Z");
    expect(stalled.code).toBe(1);
    expect(stalled.err).toContain("no job of the run ended in the last 6 hours");
  });

  it("fails with no GitHub token, because the gate cannot read the run", async () => {
    const bare = await start("2026-11-10T01:00:00Z", {});
    expect(bare.code).toBe(1);
    expect(bare.err).toContain("the gate cannot read the progress of the run: the build had no GitHub token");
  });
});
