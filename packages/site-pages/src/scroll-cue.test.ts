import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBrowser, launch, type Browser } from "./check/browser.ts";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  files: string[];
  publishConfig: { exports: Record<string, unknown> };
};
const css = readFileSync(new URL("styles/scroll-cue.css", root), "utf8");

describe("the scroll cue style", () => {
  it("is an entry of the package, and the file is in the package", () => {
    const target = pkg.publishConfig.exports["./scroll-cue.css"];
    expect(target).toBe("./styles/scroll-cue.css");
    expect(existsSync(new URL(target as string, root))).toBe(true);
    expect(pkg.files).toContain("styles");
  });

  it("gives the class scroll-cue a sideways scroll, and a fallback with two covers and two shades", () => {
    expect(css).toMatch(/\.scroll-cue\s*\{/);
    expect(css).toContain("overflow-x: auto");
    expect(css).toContain("--scroll-cue-bg");
    expect(css).toMatch(/background-attachment:\s*local,\s*local,\s*scroll,\s*scroll/);
  });

  it("has no animation shorthand, so that a minifier has no line to merge the timeline into", () => {
    expect(css).not.toMatch(/animation:/);
    expect(css).toContain("animation-timeline: scroll(self inline)");
    // With all the longhands, a minifier also can write one line. Each one that the rule leaves out prevents this.
    expect(css).not.toMatch(/animation-duration:/);
  });

  it("sets a background only in a browser with no scroll timelines, so a code block keeps the color of its theme", () => {
    // The rule starts a line. The doc comment of the file also has an example with the class.
    const base = /^\.scroll-cue\s*\{([^}]*)\}/m.exec(css)?.[1] ?? "";
    expect(base).toContain("overflow-x: auto");
    expect(base).not.toMatch(/background/);
    expect(css).toMatch(/@supports not \(animation-timeline: scroll\(\)\)\s*\{\s*\.scroll-cue\s*\{\s*background-color: var\(--scroll-cue-bg\)/);
  });

  it("has no radial shade, which goes out toward the top and the bottom of a tall box", () => {
    expect(css).not.toContain("radial-gradient");
  });
});

const executable = findBrowser();
if (executable === undefined && process.env["CI"]) throw new Error("CI has no Chromium browser for the tests of the scroll cue");

/** The color of a cell of the table in the tests: a cue must show over it. */
const CELL = [204, 51, 51];
const WIDTH = 300;

/** This function gives a style with the merged line of a minifier: the browser refuses a timeline in the shorthand. */
const mergedLine = (style: string): string =>
  style.replace(/animation-name:[^;]*;\s*animation-timing-function:[^;]*;\s*animation-fill-mode:[^;]*;\s*animation-timeline:[^;]*;/, "animation:linear both scroll-cue-fades scroll(self inline);");

/** A page with one box of a table. Each cell has its own background color, as the verdict grid of a site has. */
const page = (rows: number, tableWidth: number): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}${css}` +
  `#box{--scroll-cue-bg:#fff;width:${WIDTH}px}table{border-collapse:collapse;width:${tableWidth}px}` +
  `td{background:rgb(${CELL.join(",")});height:40px;padding:0}</style></head><body>` +
  `<div id="box" class="scroll-cue"><table>${"<tr><td></td></tr>".repeat(rows)}</table></div></body></html>`;

describe.skipIf(executable === undefined)("the scroll cue in a browser", () => {
  let browser: Browser;

  /** This function shows the page, scrolls the box, and returns the color of the top row at each edge and in the middle. */
  const edges = async (html: string, scroll: "start" | "end", y = 20, focus = false): Promise<{ left: number[]; middle: number[]; right: number[] }> => {
    const { page: tab } = browser;
    const loaded = tab.once("Page.loadEventFired", 30_000);
    await tab.send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` });
    await loaded;
    await tab.evaluate(
      `(() => { const box = document.getElementById("box"); box.scrollLeft = ${scroll === "end" ? "box.scrollWidth" : "0"}; ${focus ? "box.focus();" : ""} ` +
        `return new Promise((go) => requestAnimationFrame(() => requestAnimationFrame(go))); })()`,
    );
    const height = await tab.evaluate<number>(`document.documentElement.scrollHeight`);
    const shot = (await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: WIDTH, height, scale: 1 } })) as { data: string };
    const read = await tab.evaluate<number[][]>(
      `new Promise((go, stop) => { const image = new Image(); image.onerror = stop; image.onload = () => { ` +
        `const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height; ` +
        `const draw = canvas.getContext("2d"); draw.drawImage(image, 0, 0); ` +
        `go([1, ${WIDTH / 2}, ${WIDTH - 2}].map((x) => Array.from(draw.getImageData(x, ${y}, 1, 1).data).slice(0, 3))); }; ` +
        `image.src = "data:image/png;base64,${shot.data}"; })`,
    );
    return { left: read[0] as number[], middle: read[1] as number[], right: read[2] as number[] };
  };

  beforeAll(async () => {
    browser = await launch(executable as string, 30_000);
    await Promise.all([browser.page.send("Page.enable"), browser.page.send("Runtime.enable")]);
    await browser.page.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 900, deviceScaleFactor: 1, mobile: false });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("shows the cue over cells with a color, at the top of a tall box, on the edge with more content", async () => {
    const { left, middle, right } = await edges(page(100, 900), "start");
    expect(middle).toEqual(CELL);
    expect(left).toEqual(CELL);
    expect(right).not.toEqual(CELL);
  }, 60_000);

  it("shows no cue with the merged line of a minifier: the browser refuses a timeline in the shorthand", async () => {
    const merged = mergedLine(css);
    expect(merged).not.toBe(css);
    const { right } = await edges(page(100, 900).replace(css, merged), "start");
    expect(right).toEqual(CELL);
  }, 60_000);

  it("shows the cue in the middle of a tall box", async () => {
    const { right } = await edges(page(100, 900), "start", 2000);
    expect(right).not.toEqual(CELL);
  }, 60_000);

  it("moves the cue to the other edge at the end of the box", async () => {
    const { left, middle, right } = await edges(page(100, 900), "end");
    expect(middle).toEqual(CELL);
    expect(left).not.toEqual(CELL);
    expect(right).toEqual(CELL);
  }, 60_000);

  describe("the ring of the keyboard focus", () => {
    const RING = [0, 0, 255];
    const TOP_MARGIN = 10;
    const focusable = (html: string): string =>
      html
        .replace(`id="box"`, `id="box" tabindex="0"`)
        .replace("</style>", `#box{margin-top:${TOP_MARGIN}px}#box:focus-visible{outline:2px solid rgb(${RING.join(",")})}</style>`);
    const rule = /\.scroll-cue:focus-visible\s*\{[^}]*\}/;

    beforeAll(async () => {
      await browser.page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    });

    it("shows inside the box, where the mask keeps it", async () => {
      const { middle } = await edges(focusable(page(100, 900)), "start", TOP_MARGIN, true);
      expect(middle).toEqual(RING);
    }, 60_000);

    it("goes out of view with no rule of its own: the mask hides the ring outside the box", async () => {
      const bare = css.replace(rule, "");
      expect(bare).not.toBe(css);
      const html = focusable(page(100, 900).replace(css, bare));
      expect((await edges(html, "start", TOP_MARGIN - 1, true)).middle).not.toEqual(RING);
      expect((await edges(html, "start", TOP_MARGIN, true)).middle).not.toEqual(RING);
    }, 60_000);

    it("goes out of view on a dead cue too, because the mask does not need a live animation", async () => {
      const dead = mergedLine(css.replace(rule, ""));
      expect(dead).not.toBe(css.replace(rule, ""));
      const html = focusable(page(100, 900).replace(css, dead));
      expect((await edges(html, "start", TOP_MARGIN - 1, true)).middle).not.toEqual(RING);
      expect((await edges(html, "start", TOP_MARGIN, true)).middle).not.toEqual(RING);
    }, 60_000);

    it("shows inside the box on a dead cue, with the rule", async () => {
      const { middle } = await edges(focusable(page(100, 900).replace(css, mergedLine(css))), "start", TOP_MARGIN, true);
      expect(middle).toEqual(RING);
    }, 60_000);

    it("shows outside a box with no mask, so that the other test reads the mask and not a page with no ring", async () => {
      const html = focusable(page(100, 900).replace(css, css.replace(rule, "").replace(/(-webkit-)?mask-image:[^;]*;/g, "")));
      expect((await edges(html, "start", TOP_MARGIN - 1, true)).middle).toEqual(RING);
    }, 60_000);
  });

  it("shows no cue on a box with no overflow", async () => {
    const { left, right } = await edges(page(5, WIDTH), "start");
    expect(left).toEqual(CELL);
    expect(right).toEqual(CELL);
  }, 60_000);
});
