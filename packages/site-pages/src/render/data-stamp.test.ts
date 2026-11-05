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

  it("escapes each text of the stamp", () => {
    expect(renderDataStamp({ page: "index.html", runs: [{ ...run, id: "<b>" }] })).toContain("&lt;b&gt;");
  });
});
