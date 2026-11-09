import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KPI_FORMAT, KpiError, kpiFile, kpiProblems, kpiText, readKpi, writeKpi, type KpiInput } from "./kpi.ts";

const COMMIT = "a".repeat(40);
const NOW = Date.parse("2026-11-04T12:00:00Z");
const INPUT: KpiInput = {
  project: "packing",
  at: "2026-11-03T09:30:00Z",
  commit: COMMIT,
  measures: [{ id: "strategies-covered", value: 12, unit: "strategies" }, { id: "data-age-days", value: 1.5 }],
};

const faults = (change: Record<string, unknown>): string[] => kpiProblems({ format: KPI_FORMAT, ...INPUT, ...change }, NOW);

describe("kpiFile", () => {
  it("gives the file of the format, with its fields in a fixed order", () => {
    const file = kpiFile({ measures: INPUT.measures, commit: COMMIT, at: INPUT.at, project: "packing" }, NOW);
    expect(Object.keys(file)).toEqual(["format", "project", "at", "commit", "measures"]);
    expect(file.format).toBe("kpi/1");
    expect(file.measures[1]).toEqual({ id: "data-age-days", value: 1.5 });
  });

  it("keeps the engines, and drops a field that the format does not have", () => {
    const measures = [{ id: "cases", value: 3, note: "x" }];
    const file = kpiFile({ ...INPUT, measures, engines: [{ name: "@acme/engine", version: "1.2.3" }] }, NOW);
    expect(file.engines).toEqual([{ name: "@acme/engine", version: "1.2.3" }]);
    expect(file.measures).toEqual([{ id: "cases", value: 3 }]);
  });

  it("keeps the time of a measure, after its unit", () => {
    const measures = [{ at: "2026-11-04T08:00:00Z", unit: "cases", value: 3, id: "cases" }];
    const [measure] = kpiFile({ ...INPUT, measures }, NOW).measures;
    expect(measure).toEqual({ id: "cases", value: 3, unit: "cases", at: "2026-11-04T08:00:00Z" });
    expect(Object.keys(measure ?? {})).toEqual(["id", "value", "unit", "at"]);
  });

  it("keeps the text of what a measure does not count, as its last field", () => {
    const measures = [{ notCounted: "Lists that a script draws.", id: "stale-text", value: 0, at: "2026-11-04T08:00:00Z" }];
    const [measure] = kpiFile({ ...INPUT, measures }, NOW).measures;
    expect(measure).toEqual({ id: "stale-text", value: 0, at: "2026-11-04T08:00:00Z", notCounted: "Lists that a script draws." });
    expect(Object.keys(measure ?? {})).toEqual(["id", "value", "at", "notCounted"]);
  });

  it("throws an error with each fault", () => {
    const error = (() => {
      try {
        return kpiFile({ ...INPUT, project: "Bad Name", commit: "abc" }, NOW);
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(KpiError);
    expect((error as KpiError).problems).toHaveLength(2);
    expect((error as KpiError).message).toContain("kpi.json is not correct");
  });
});

describe("kpiProblems", () => {
  it("accepts a correct file", () => {
    expect(faults({})).toEqual([]);
    expect(faults({ at: "2026-11-04T12:00Z" })).toEqual([]);
    expect(faults({ at: "2026-11-04T12:00:00.250Z" })).toEqual([]);
  });

  it("refuses a time with no zone, a time that is not valid and a time after the check", () => {
    expect(faults({ at: "2026-11-04T12:00:00" })).toHaveLength(1);
    expect(faults({ at: "2026-13-40T12:00:00Z" })).toHaveLength(1);
    expect(faults({ at: "2026-11-04" })).toHaveLength(1);
    expect(faults({ at: "2026-11-04T12:06:00Z" })[0]).toContain("after the time of the check");
  });

  it("accepts a correct time on a measure, and a measure with no time", () => {
    expect(faults({ measures: [{ id: "cases", value: 1, at: "2026-11-04T08:00Z" }, { id: "drift", value: 2 }] })).toEqual([]);
  });

  it("refuses a time on a measure with the rules of the time of the file", () => {
    expect(faults({ measures: [{ id: "cases", value: 1, at: "2026-11-04" }] })[0]).toContain("The field at of measure 0");
    expect(faults({ measures: [{ id: "cases", value: 1, at: 3 }] })).toHaveLength(1);
    expect(faults({ measures: [{ id: "cases", value: 1, at: "2026-11-04T12:06:00Z" }] })[0]).toContain("after the time of the check");
  });

  it("accepts a small difference of the clocks", () => {
    expect(faults({ at: "2026-11-04T12:04:00Z" })).toEqual([]);
  });

  it("refuses a wrong format and a short commit", () => {
    expect(faults({ format: "kpi/2" })).toHaveLength(1);
    expect(faults({ commit: "abc1234" })).toHaveLength(1);
  });

  it("refuses a slug that breaks the file name of a reading", () => {
    expect(faults({ project: "two--parts" })).toHaveLength(1);
    expect(faults({ measures: [{ id: "two--parts", value: 1 }] })).toHaveLength(1);
    expect(faults({ measures: [{ id: "Upper", value: 1 }] })).toHaveLength(1);
  });

  it("refuses no measures, a value that is not finite and an id that occurs two times", () => {
    expect(faults({ measures: [] })).toHaveLength(1);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "3", null]) expect(faults({ measures: [{ id: "cases", value }] })).toHaveLength(1);
    expect(faults({ measures: [{ id: "cases", value: 1 }, { id: "cases", value: 2 }] })[0]).toContain("two times");
  });

  it("accepts a value of zero and a negative value", () => {
    expect(faults({ measures: [{ id: "cases", value: 0 }, { id: "drift", value: -2 }] })).toEqual([]);
  });

  it("refuses an empty unit and an engine with no version", () => {
    expect(faults({ measures: [{ id: "cases", value: 1, unit: " " }] })).toHaveLength(1);
    expect(faults({ measures: [{ id: "cases", value: 1, notCounted: " " }] })).toHaveLength(1);
    expect(faults({ measures: [{ id: "cases", value: 1, notCounted: 3 }] })).toHaveLength(1);
    expect(faults({ engines: [{ name: "x" }] })).toHaveLength(1);
    expect(faults({ engines: "x" })).toHaveLength(1);
  });

  it("gives one fault for a value that is not an object", () => {
    expect(kpiProblems([], NOW)).toHaveLength(1);
    expect(kpiProblems(null, NOW)).toHaveLength(1);
  });
});

describe("the targets of a measure", () => {
  const TARGETS = [{ value: 120, by: "2026-11-15" }, { value: 250, by: "2026-11-22" }];
  const withTargets = (targets: unknown): string[] => faults({ measures: [{ id: "operators", value: 41, targets }] });

  it("accepts targets in the order of their dates, a target of zero and a date in the past", () => {
    expect(withTargets(TARGETS)).toEqual([]);
    expect(withTargets([{ value: 0, by: "2020-01-01" }])).toEqual([]);
  });

  it("refuses a date that is not a calendar date of the form YYYY-MM-DD", () => {
    expect(withTargets([{ value: 1, by: "2026-02-30" }])).toEqual(["Target 0 of measure 0 has no date of the form YYYY-MM-DD in its field by."]);
    expect(withTargets([{ value: 1, by: "2026-11-15T00:00:00Z" }])).toHaveLength(1);
    expect(withTargets([{ value: 1 }])).toHaveLength(1);
  });

  it("refuses a list that is not in the order of its dates, and a date that occurs two times", () => {
    expect(withTargets([...TARGETS].reverse())).toEqual(["Target 1 of measure 0 has the date 2026-11-15, which is not after the date 2026-11-22 before it."]);
    expect(withTargets([TARGETS[0], { value: 130, by: "2026-11-15" }])).toHaveLength(1);
  });

  it("refuses a negative value and a value that is not finite", () => {
    expect(withTargets([{ value: -1, by: "2026-11-15" }])).toEqual(["Target 0 of measure 0 has no finite value of 0 or more."]);
    expect(withTargets([{ value: Number.POSITIVE_INFINITY, by: "2026-11-15" }])).toHaveLength(1);
  });

  it("refuses an empty list, a field that is not a list and a target that is not an object", () => {
    expect(withTargets([])).toHaveLength(1);
    expect(withTargets({ value: 1, by: "2026-11-15" })).toHaveLength(1);
    expect(withTargets(["2026-11-15"])).toEqual(["Target 0 of measure 0 is not an object."]);
  });

  it("keeps the targets as the last field of a measure, with only their known fields", () => {
    const measures = [{ id: "operators", value: 41, notCounted: "Param values.", targets: [{ value: 120, by: "2026-11-15", note: "x" }] }];
    const file = kpiFile({ ...INPUT, measures }, NOW);
    expect(file.measures[0]).toEqual({ id: "operators", value: 41, notCounted: "Param values.", targets: [{ value: 120, by: "2026-11-15" }] });
    expect(Object.keys(file.measures[0]!)).toEqual(["id", "value", "notCounted", "targets"]);
    expect(readKpi(kpiText(file), NOW).measures[0]).toEqual(file.measures[0]);
  });
});

describe("readKpi", () => {
  it("reads the text that kpiText writes", () => {
    const file = kpiFile({ ...INPUT, engines: [{ name: "a", version: "1.0.0" }] }, NOW);
    expect(readKpi(kpiText(file), NOW)).toEqual(file);
  });

  it("keeps the time of a measure", () => {
    const file = kpiFile({ ...INPUT, measures: [{ id: "cases", value: 1, at: "2026-11-04T08:00:00Z" }] }, NOW);
    expect(readKpi(kpiText(file), NOW).measures[0]?.at).toBe("2026-11-04T08:00:00Z");
  });

  it("refuses a text that is not JSON and a file of a new format", () => {
    expect(() => readKpi("{", NOW)).toThrow(KpiError);
    expect(() => readKpi(JSON.stringify({ ...INPUT, format: "kpi/2" }), NOW)).toThrow("The format is not kpi/1.");
  });
});

describe("writeKpi", () => {
  const out = mkdtempSync(join(tmpdir(), "site-pages-kpi-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("writes the file at the root of the folder", () => {
    const file = writeKpi(join(out, "dist"), INPUT, NOW);
    expect(file).toBe(join(out, "dist", "kpi.json"));
    expect(readKpi(readFileSync(file, "utf8"), NOW).project).toBe("packing");
  });

  it("writes nothing when the data is not correct", () => {
    expect(() => writeKpi(join(out, "bad"), { ...INPUT, measures: [] }, NOW)).toThrow(KpiError);
    expect(() => readFileSync(join(out, "bad", "kpi.json"))).toThrow();
  });
});
