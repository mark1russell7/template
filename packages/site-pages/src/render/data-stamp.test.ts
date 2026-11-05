import { describe, expect, it } from "vitest";
import type { DataRun } from "../check/freshness.ts";
import { renderDataStamp } from "./data-stamp.ts";

const run: DataRun = { id: "42", url: "https://example.com/42", date: "2026-11-05T01:02:03Z", engines: { "@scope/packing": "0.7.0", highways: "0.14.0" } };

describe("renderDataStamp", () => {
  it("names the run, its date and each engine version", () => {
    const html = renderDataStamp({ page: "index.html", runs: [run] });
    expect(html).toContain('href="https://example.com/42"');
    expect(html).toContain("of 2026-11-05");
    expect(html).toContain("packing 0.7.0");
    expect(html).toContain("highways 0.14.0");
    expect(html).not.toContain("in flight");
  });

  it("shows the words of a method in place of the word run", () => {
    const html = renderDataStamp({ page: "index.html", runs: [{ ...run, method: "lab run" }] });
    expect(html).toContain('The data comes from lab run <a href="https://example.com/42"');
    expect(html).not.toContain("from run");
    expect(renderDataStamp({ page: "index.html", runs: [run] })).toContain("from run");
  });

  it("names a run in flight", () => {
    const html = renderDataStamp({ page: "index.html", runs: [run], inFlight: { ...run, id: "43", url: "https://example.com/43" } });
    expect(html).toContain("A newer run is in flight");
    expect(html).toContain('href="https://example.com/43"');
  });

  it("says in plain words that the measured numbers of a page are a fixed study of its versions", () => {
    const html = renderDataStamp({ page: "index.html", runs: [run, { ...run, id: "43" }], study: true });
    expect(html).toContain("The measured numbers of this page are a fixed study of packing 0.7.0");
    expect(html).toContain("They tell nothing about a newer release.");
    expect(html).not.toContain("This page is a fixed study");
    expect(html.match(/packing 0\.7\.0/g)).toHaveLength(3);
  });

  it("shows a longer limit with its reason", () => {
    const limit = { days: 7, reason: "The scan <runs> each week.", workflow: ".github/workflows/scan.yml" };
    const html = renderDataStamp({ page: "index.html", runs: [run], limit });
    expect(html).toContain("The age limit of this data is 7 days. The scan &lt;runs&gt; each week.");
  });

  it("shows the age of the oldest run at the time of the build", () => {
    const old = { ...run, id: "41", date: "2026-10-05T01:02:03Z" };
    expect(renderDataStamp({ page: "index.html", runs: [run, old] }, "2026-11-05T12:00:00Z")).toContain("The oldest data of this page is 31 days old at this build, on 2026-11-05.");
    expect(renderDataStamp({ page: "index.html", runs: [run] }, "2026-11-06T12:00:00Z")).toContain("is 1 day old");
    expect(renderDataStamp({ page: "index.html", runs: [run] }, "2026-11-01T12:00:00Z")).toContain("is 0 days old");
  });

  it("says a study with a limit is not fixed, and shows the commit and the start of the limit", () => {
    const limit = { days: 30, reason: "A scheduled run refreshes it.", workflow: "w.yml", startsAt: "2026-12-07T00:00:00Z" };
    const html = renderDataStamp({ page: "index.html", runs: [{ ...run, commit: "abcdef0123456789abcdef0123456789abcdef01" }], study: true, limit });
    expect(html).toContain("The measured numbers of this page are a study of packing 0.7.0");
    expect(html).not.toContain("fixed study");
    expect(html).not.toContain("They tell nothing");
    expect(html).toContain("of 2026-11-05, at commit abcdef0, on");
    expect(html).toContain("The age limit of this data is 30 days, from 2026-12-07. A scheduled run refreshes it.");
  });

  it("shows both statements of a study with no limit", () => {
    const html = renderDataStamp({ page: "index.html", runs: [run], study: true, noLimit: { reproduce: "The <code> is gone.", today: "The page tells of one day." } });
    expect(html).toContain("They tell nothing about a newer release. The &lt;code&gt; is gone. The page tells of one day.");
  });

  it("escapes each text of the stamp", () => {
    expect(renderDataStamp({ page: "index.html", runs: [{ ...run, id: "<b>" }] })).toContain("&lt;b&gt;");
  });
});
