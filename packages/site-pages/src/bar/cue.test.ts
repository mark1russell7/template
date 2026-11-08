import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { findBrowser, launch, type Browser } from "../check/browser.ts";
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
});
