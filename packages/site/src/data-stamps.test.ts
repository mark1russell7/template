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

describe("the section of the explorer", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const words = (text: string): string => text.replace(/<[^>]+>/g, "");

  it("says first what the chart is, with the version of the stamp", () => {
    const what = /<p class="lead small" id="response-what">(.*?)<\/p>/.exec(html)?.[1] ?? "";
    const version = STAMPS.pages[0]?.runs[0]?.engines["@mark1russell7/packing"];
    expect(words(what).startsWith(`This is the explorer that @mark1russell7/site-pages gives any site. The sample data is a fixed study of packing ${version}.`)).toBe(true);
  });

  it("links to the live explorer of packing", () => {
    expect(html).toContain('href="https://mark1russell7.github.io/packing/explorer/"');
  });

  it("shows the entry and the function that this page mounts", () => {
    const mount = /<pre id="response-mount">([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? "";
    const style = readFileSync(new URL("./style.css", import.meta.url), "utf8");
    expect(mount).toContain('from "@mark1russell7/site-pages/explorer"');
    expect(main).toContain('import("@mark1russell7/site-pages/explorer")');
    expect(mount).toContain('import "@mark1russell7/site-pages/explorer.css"');
    expect(style).toContain('@import "@mark1russell7/site-pages/explorer.css"');
    expect(mount).toContain("mountExplorer(document.getElementById");
    expect(main).toContain("explorer.mountExplorer(");
  });
});
