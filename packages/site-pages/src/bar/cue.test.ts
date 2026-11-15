import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { findBrowser, launch, type Browser } from "../check/browser.ts";
import { checkSite } from "../check/check.ts";
import { applyCue, CUE_ATTRIBUTE, CUE_SCRIPT, cueAttributes, cueCss, injectCue, runCueCli } from "./cue.ts";

const css = cueCss();
const page = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("cueAttributes", () => {
  it("gives a bare block the class, a tab stop and the mark", () => {
    expect(cueAttributes("")).toBe(` class="scroll-cue" tabindex="0" ${CUE_ATTRIBUTE}`);
  });

  it("keeps the classes and the tab index of the block", () => {
    expect(cueAttributes(' class="astro-code github-dark" tabindex="-1"')).toBe(` class="astro-code github-dark scroll-cue" tabindex="-1" ${CUE_ATTRIBUTE}`);
    expect(cueAttributes(" class='code'")).toBe(` class="code scroll-cue" tabindex="0" ${CUE_ATTRIBUTE}`);
    expect(cueAttributes(" class=code id=x")).toBe(` class="code scroll-cue" id=x tabindex="0" ${CUE_ATTRIBUTE}`);
    expect(cueAttributes(' data-class="a"')).toBe(` data-class="a" class="scroll-cue" tabindex="0" ${CUE_ATTRIBUTE}`);
  });

  it("leaves a block with data-overflow-ok or with the cue as it is", () => {
    expect(cueAttributes(" data-overflow-ok")).toBeUndefined();
    expect(cueAttributes(' class="a scroll-cue"')).toBeUndefined();
  });
});

describe("injectCue", () => {
  it("writes the style into the head and the script into the body, one time", () => {
    const { html, boxes } = injectCue(page("<pre>a</pre><pre class=x>b</pre>"), css);
    expect(boxes).toBe(2);
    expect(html.match(/<style id="site-cue-css">/g)).toHaveLength(1);
    expect(html).toMatch(/<\/style><\/head>/);
    expect(html).toContain(`<script id="site-cue-js">${CUE_SCRIPT}</script></body>`);
    expect(html).toContain("animation-timeline: scroll(self inline)");
  });

  it("gives the same page at a second start", () => {
    const once = injectCue(page("<pre>a</pre>"), css).html;
    const twice = injectCue(once, css);
    expect(twice.boxes).toBe(0);
    expect(twice.html).toBe(once);
  });

  it("does not change a page with no block to change", () => {
    const html = page('<p>text</p><pre data-overflow-ok>a</pre><pre class="scroll-cue">b</pre>');
    expect(injectCue(html, css)).toEqual({ html, boxes: 0 });
  });

  it("writes the style and the script into a page with a script of its own, also with no block", () => {
    const { html, boxes } = injectCue(page('<div id="readme"></div><script type="module" src="/main.js"></script>'), css);
    expect(boxes).toBe(0);
    expect(html.match(/<style id="site-cue-css">/g)).toHaveLength(1);
    expect(html).toContain(`<script id="site-cue-js">${CUE_SCRIPT}</script></body>`);
    expect(injectCue(html, css).html).toBe(html);
    // A JSON data block makes no code block
    const data = page('<script type="application/ld+json">{"@type":"WebSite"}</script><p>text</p>');
    expect(injectCue(data, css)).toEqual({ html: data, boxes: 0 });
  });

  it("does not change the text of a script, a style or a textarea", () => {
    const script = `<script>document.body.insertAdjacentHTML("beforeend", "<pre class=\\"x\\">y</pre>");</script>`;
    const html = page(`${script}<style>pre{color:red}</style><textarea><pre>z</pre></textarea><pre>a</pre>`);
    const { html: next, boxes } = injectCue(html, css);
    expect(boxes).toBe(1);
    expect(next).toContain(script);
    expect(next).toContain("<textarea><pre>z</pre></textarea>");
  });
});

describe("applyCue and the cue command", () => {
  it("changes each page with a block, and tells the counts", () => {
    const out = mkdtempSync(join(tmpdir(), "cue-"));
    folders.push(out);
    mkdirSync(join(out, "docs"));
    writeFileSync(join(out, "index.html"), page("<p>home</p>"));
    writeFileSync(join(out, "docs", "index.html"), page("<pre>a</pre><pre>b</pre>"));
    expect(applyCue(out, css)).toEqual({ pages: 2, changed: 1, boxes: 2 });
    expect(readFileSync(join(out, "index.html"), "utf8")).toBe(page("<p>home</p>"));
    const lines: string[] = [];
    const io = { cwd: out, env: {}, stdout: (text: string) => lines.push(text), stderr: (text: string) => lines.push(text) };
    expect(runCueCli(["--out", "."], io)).toBe(0);
    expect(lines.join("")).toContain("0 code blocks in 0 of 2 pages");
    expect(runCueCli([], io)).toBe(2);
    const empty = mkdtempSync(join(tmpdir(), "cue-"));
    folders.push(empty);
    expect(runCueCli(["--out", empty], io)).toBe(1);
  });
});

const executable = findBrowser();
if (executable === undefined && process.env["CI"]) throw new Error("CI has no Chromium browser for the tests of the scroll cue step");

describe.skipIf(executable === undefined)("the scroll cue of the step in a browser", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launch(executable as string, 30_000);
    await Promise.all([browser.page.send("Page.enable"), browser.page.send("Runtime.enable")]);
    await browser.page.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 900, deviceScaleFactor: 1, mobile: false });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("shows the cue only on the block that is wider than its box", async () => {
    const { html } = injectCue(
      page(
        '<style>body{margin:0}pre{width:300px;margin:0;background:#223;color:#fff}</style>' +
          `<pre id="wide">${"x".repeat(200)}</pre><pre id="narrow">short</pre>`,
      ),
      css,
    );
    const loaded = browser.page.once("Page.loadEventFired", 30_000);
    await browser.page.send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` });
    await loaded;
    const read = await browser.page.evaluate<Record<string, { overflow: boolean; animation: string; left: string; right: string; tab: number }>>(
      `new Promise((go) => requestAnimationFrame(() => requestAnimationFrame(() => go(Object.fromEntries(["wide", "narrow"].map((id) => { ` +
        `const box = document.getElementById(id); const style = getComputedStyle(box); ` +
        `return [id, { overflow: box.scrollWidth > box.clientWidth, animation: style.animationName, tab: box.tabIndex, ` +
        `left: style.getPropertyValue("--scroll-cue-fade-left").trim(), right: style.getPropertyValue("--scroll-cue-fade-right").trim() }]; }))))))`,
    );
    expect(read["wide"]).toMatchObject({ overflow: true, animation: "scroll-cue-fades", left: "0px", tab: 0 });
    expect(read["wide"]?.right).not.toBe("0px");
    expect(read["narrow"]).toMatchObject({ overflow: false, left: "0px", right: "0px", tab: 0 });
  }, 60_000);

  it("gives the cue to each code block that a script of the page makes, by the rules of the step", async () => {
    const made =
      '<style>body{margin:0}pre{width:300px;margin:0}</style><div id="root"></div><script>' +
      `const root = document.getElementById("root"); root.innerHTML = '<pre id="now">${"x".repeat(200)}</pre>'; ` +
      `setTimeout(() => root.insertAdjacentHTML("beforeend", '<section><pre id="later" class="code">${"y".repeat(200)}</pre></section>' + ` +
      `'<pre id="ok" data-overflow-ok>z</pre><pre id="own" class="scroll-cue" tabindex="-1">w</pre>'), 50);</script>`;
    const { html, boxes } = injectCue(page(made), css);
    expect(boxes).toBe(0);
    const loaded = browser.page.once("Page.loadEventFired", 30_000);
    await browser.page.send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` });
    await loaded;
    const read = await browser.page.evaluate<Record<string, { cue: boolean; mark: boolean; tab: number; animation: string }>>(
      `new Promise((go) => setTimeout(() => requestAnimationFrame(() => go(Object.fromEntries(["now", "later", "ok", "own"].map((id) => { ` +
        `const box = document.getElementById(id); ` +
        `return [id, { cue: box.classList.contains("scroll-cue"), mark: box.hasAttribute("${CUE_ATTRIBUTE}"), tab: box.tabIndex, animation: getComputedStyle(box).animationName }]; })))), 200))`,
    );
    expect(read["now"]).toEqual({ cue: true, mark: true, tab: 0, animation: "scroll-cue-fades" });
    expect(read["later"]).toEqual({ cue: true, mark: true, tab: 0, animation: "scroll-cue-fades" });
    expect(read["ok"]).toMatchObject({ cue: false, mark: false });
    expect(read["own"]).toMatchObject({ cue: true, mark: false, tab: -1 });
  }, 60_000);

  it("makes the site check pass a wide code block that a script makes, and the check still fails it with no cue", async () => {
    const out = mkdtempSync(join(tmpdir(), "cue-check-"));
    folders.push(out);
    const site = (body: string) =>
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title></head><body>${body}</body></html>`;
    // The style of the site lets a code block scroll, as the style of most sites does
    const readme = `<style>pre{overflow-x:auto}</style><h1>Readme</h1><div id="readme"></div><script>document.getElementById("readme").innerHTML = "<pre><code>${"SELECT version FROM _migrations ORDER BY version; ".repeat(4)}</code></pre>";</script>`;
    for (const folder of ["cued", "plain"]) {
      mkdirSync(join(out, folder));
      writeFileSync(join(out, folder, "index.html"), site(readme));
    }
    const cued = join(out, "cued", "index.html");
    writeFileSync(cued, injectCue(readFileSync(cued, "utf8"), css).html);
    const result = await checkSite({ out, pages: ["/cued/", "/plain/"], widths: [360], schemes: ["light"], settleMs: 100, timeoutMs: 30_000 });
    const at = (path: string) => result.views.find((view) => view.page === path)?.problems ?? [];
    expect(at("/cued/")).toEqual([]);
    expect(at("/plain/").join(" ")).toContain("a code block goes out of view at 360 px: pre in pre");
  }, 120_000);

  it("gives the cue to a box of the page that scrolls in place of its code block, and only to a box that holds only the block", async () => {
    const wide = "z".repeat(200);
    const made =
      "<style>body{margin:0}.wrap{overflow-x:auto;width:300px}pre{width:max-content;margin:0}</style>" +
      `<div class="wrap" id="static"><pre id="static-pre">${wide}</pre></div>` +
      '<div class="wrap" id="later" tabindex="-1"><pre id="later-pre"></pre></div>' +
      `<div class="wrap" id="mixed"><p>words</p><pre id="mixed-pre">${wide}</pre></div>` +
      '<div class="wrap" id="short"><pre id="short-pre">short</pre></div>' +
      `<div class="wrap" id="ok" data-overflow-ok><pre>${wide}</pre></div>` +
      `<script>setTimeout(() => { document.getElementById("later-pre").textContent = "${wide}"; }, 50);</script>`;
    const { html } = injectCue(page(made), css);
    const loaded = browser.page.once("Page.loadEventFired", 30_000);
    await browser.page.send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` });
    await loaded;
    const read = await browser.page.evaluate<Record<string, { cue: boolean; mark: boolean; tab: number; animation: string }>>(
      `new Promise((go) => setTimeout(() => requestAnimationFrame(() => go(Object.fromEntries(["static", "later", "mixed", "short", "ok"].map((id) => { ` +
        `const box = document.getElementById(id); ` +
        `return [id, { cue: box.classList.contains("scroll-cue"), mark: box.hasAttribute("${CUE_ATTRIBUTE}"), tab: box.tabIndex, animation: getComputedStyle(box).animationName }]; })))), 200))`,
    );
    expect(read["static"]).toEqual({ cue: true, mark: true, tab: 0, animation: "scroll-cue-fades" });
    // The block gets its text after the start. The box keeps its own tab index.
    expect(read["later"]).toEqual({ cue: true, mark: true, tab: -1, animation: "scroll-cue-fades" });
    expect(read["mixed"]).toMatchObject({ cue: false, mark: false });
    expect(read["short"]).toMatchObject({ cue: false, mark: false });
    expect(read["ok"]).toMatchObject({ cue: false, mark: false });
  }, 60_000);

  it("makes the site check pass a code block whose own box scrolls, and the check still fails that box with no cue", async () => {
    const out = mkdtempSync(join(tmpdir(), "cue-outer-"));
    folders.push(out);
    const site = (body: string) =>
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title></head><body>${body}</body></html>`;
    // The pattern of a code lab: the box scrolls, and the block has the width of its text
    const lab = `<style>.sample-scroll{overflow-x:auto}pre{width:max-content;margin:0}</style><div class="sample-scroll" id="sample-scroll" tabindex="0"><pre id="sample">${"const value = compute(first, second); ".repeat(4)}</pre></div>`;
    for (const folder of ["cued", "plain"]) {
      mkdirSync(join(out, folder));
      writeFileSync(join(out, folder, "index.html"), site(lab));
    }
    const cued = join(out, "cued", "index.html");
    writeFileSync(cued, injectCue(readFileSync(cued, "utf8"), css).html);
    const result = await checkSite({ out, pages: ["/cued/", "/plain/"], widths: [360], schemes: ["light"], settleMs: 100, timeoutMs: 30_000 });
    const at = (path: string) => result.views.find((view) => view.page === path)?.problems ?? [];
    expect(at("/cued/")).toEqual([]);
    expect(at("/plain/").join(" ")).toContain("a code block goes out of view at 360 px: pre#sample in div#sample-scroll");
  }, 120_000);
});
