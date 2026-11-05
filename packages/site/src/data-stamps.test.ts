import { checkFreshness, parseDataStamps, renderDataStamp, type DataStamps, type PageStamp } from "@mark1russell7/site-pages";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RECORD_SHA256, STAMPS } from "./data-stamps.ts";

/** A time long after the study, so the age rule acts on each case with no `study` field. */
const LATER = "2030-01-01T00:00:00Z";
const page = STAMPS.pages[0] as PageStamp;
const withPage = (changed: PageStamp): DataStamps => ({ ...STAMPS, pages: [changed] });

describe("the data stamp of the home page", () => {
  it("names the record that the page shows", () => {
    const record = readFileSync(new URL("./packing-record.json", import.meta.url));
    expect(createHash("sha256").update(record).digest("hex")).toBe(RECORD_SHA256);
  });

  it("passes the gate at any later time, because it is a fixed study", () => {
    expect(checkFreshness(STAMPS, { now: LATER, times: [] }).faults).toEqual([]);
  });

  it("fails the gate with no field study, because the data is old", () => {
    const { study: _study, ...notStudy } = page;
    expect(checkFreshness(withPage(notStudy), { now: LATER, times: [] }).faults).not.toEqual([]);
  });

  it("is refused with no engine version, because a study names its version", () => {
    const [run] = page.runs;
    const parsed = parseDataStamps(withPage({ ...page, runs: [{ ...run, engines: {} } as NonNullable<typeof run>] }));
    expect(parsed.ok).toBe(false);
  });

  it("tells in plain words which version the page measured", () => {
    expect(renderDataStamp(page)).toContain("The measured numbers of this page are a fixed study of packing 0.6.1. They tell nothing about a newer release.");
  });
});
