import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build as viteBuild, type Plugin } from "vite";
import { findBrowser } from "../check/browser.ts";
import { checkSite, runCheckCli, type CheckOptions } from "../check/check.ts";
import { siteOffline, type SiteOfflineOptions } from "./plugin.ts";

const browser = findBrowser();
if (browser === undefined && process.env["CI"]) throw new Error("CI has no Chromium browser, so the offline check cannot run");

let dir: string;

/** This function builds the test site into the folder `name`, with the plugin of the offline shell when it has options. */
async function buildSite(name: string, offline: SiteOfflineOptions | undefined): Promise<string> {
  const site = join(dir, "site");
  const outDir = join(dir, name);
  const plugins: Plugin[] = offline === undefined ? [] : [siteOffline(offline)];
  await viteBuild({
    configFile: false,
    logLevel: "silent",
    root: site,
    base: "/site/",
    plugins,
    build: { outDir, emptyOutDir: true, rolldownOptions: { input: [join(site, "index.html"), join(site, "notes", "index.html")] } },
  });
  return outDir;
}

const options = (out: string, timeoutMs = 30_000): CheckOptions => ({
  out,
  base: "/site/",
  pages: ["/", "/notes/"],
  widths: [400],
  schemes: ["light"],
  settleMs: 100,
  timeoutMs,
  offline: true,
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "site-offline-check-"));
  const site = join(dir, "site");
  mkdirSync(join(site, "notes"), { recursive: true });
  const page = (title: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><link rel="icon" href="data:,"></head><body><h1>${title}</h1><p id="state">waiting</p><script type="module" src="/main.js"></script></body></html>`;
  writeFileSync(join(site, "index.html"), page("Home"));
  writeFileSync(join(site, "notes", "index.html"), page("Notes"));
  writeFileSync(join(site, "main.js"), 'document.getElementById("state").textContent = "ready";\n');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("runCheckCli --offline", () => {
  it("refuses --offline with --url", async () => {
    let err = "";
    const code = await runCheckCli(["--url", "https://example.test/", "--offline"], { cwd: ".", env: {}, stdout: () => {}, stderr: (text) => (err += text) });
    expect(code).toBe(2);
    expect(err).toContain("--offline needs --out");
  });

  it("refuses the option offline with url in checkSite", async () => {
    await expect(checkSite({ ...options(""), out: undefined, url: "https://example.test/", browser: browser ?? process.execPath })).rejects.toThrow("the offline check needs out");
  });
});

describe.skipIf(browser === undefined)("checkSite --offline in a browser", { timeout: 60_000 }, () => {
  it("passes a site whose service worker keeps each page", async () => {
    const out = await buildSite("kept", { manifest: { name: "Field notes" } });
    const result = await checkSite(options(out));
    const offline = result.views.filter((view) => view.offline === true);
    expect(offline.map((view) => [view.page, view.ok, view.problems])).toEqual([
      ["/", true, []],
      ["/notes/", true, []],
    ]);
    expect(result.ok).toBe(true);
  });

  it("fails each page of a site with no service worker", async () => {
    const out = await buildSite("none", undefined);
    const result = await checkSite(options(out, 3_000));
    const offline = result.views.filter((view) => view.offline === true);
    expect(offline).toHaveLength(2);
    for (const view of offline) {
      expect(view.ok, view.page).toBe(false);
      expect(view.problems.join("\n"), view.page).toContain("no service worker of the site became active");
    }
    expect(result.views.filter((view) => view.offline !== true).every((view) => view.ok)).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("fails a page that the service worker does not keep", async () => {
    const out = await buildSite("partial", { manifest: false, exclude: [/^notes\//] });
    const result = await checkSite(options(out));
    const offline = new Map(result.views.filter((view) => view.offline === true).map((view) => [view.page, view]));
    expect(offline.get("/")?.ok).toBe(true);
    expect(offline.get("/notes/")?.ok).toBe(false);
    expect(offline.get("/notes/")?.problems.join("\n")).toContain("it gave the home page in its place");
  });
});
