import { parseResponseRecord } from "@mark1russell7/rigor-statistics";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const text = readFileSync(new URL("./packing-record.json", import.meta.url), "utf8");

describe("the record of the page", () => {
  const parsed = parseResponseRecord(JSON.parse(text));

  it("is a valid record of the packing measures", () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.points).toHaveLength(660);
    expect(parsed.record.measures.map((m) => m.id)).toEqual(["fill", "aspect"]);
    expect(parsed.record.models.map((m) => m.measure)).toEqual(["fill", "aspect"]);
  });

  it("stays under 150 kB", () => {
    expect(Buffer.byteLength(text)).toBeLessThan(150 * 1024);
  });
});
