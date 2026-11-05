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

  it("has no radial shade, which goes out toward the top and the bottom of a tall box", () => {
    expect(css).not.toContain("radial-gradient");
  });
});

const executable = findBrowser();
if (executable === undefined && process.env["CI"]) throw new Error("CI has no Chromium browser for the tests of the scroll cue");

/** The color of a cell of the table in the tests: a cue must show over it. */
const CELL = [204, 51, 51];
const WIDTH = 300;

/** A page with one box of a table. Each cell has its own background color, as the verdict grid of a site has. */
const page = (rows: number, tableWidth: number): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}${css}` +
  `#box{--scroll-cue-bg:#fff;width:${WIDTH}px}table{border-collapse:collapse;width:${tableWidth}px}` +
  `td{background:rgb(${CELL.join(",")});height:40px;padding:0}</style></head><body>` +
  `<div id="box" class="scroll-cue"><table>${"<tr><td></td></tr>".repeat(rows)}</table></div></body></html>`;

describe.skipIf(executable === undefined)("the scroll cue in a browser", () => {
  let browser: Browser;

  /** This function shows the page, scrolls the box, and returns the color of the top row at each edge and in the middle. */
  const edges = async (html: string, scroll: "start" | "end", y = 20): Promise<{ left: number[]; middle: number[]; right: number[] }> => {
    const { page: tab } = browser;
    const loaded = tab.once("Page.loadEventFired", 30_000);
    await tab.send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` });
    await loaded;
    await tab.evaluate(
      `(() => { const box = document.getElementById("box"); box.scrollLeft = ${scroll === "end" ? "box.scrollWidth" : "0"}; ` +
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

  it("shows no cue on a box with no overflow", async () => {
    const { left, right } = await edges(page(5, WIDTH), "start");
    expect(left).toEqual(CELL);
    expect(right).toEqual(CELL);
  }, 60_000);
});
