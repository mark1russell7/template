import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBrowser } from "./browser.ts";
import { cell, checkSite, cutProblems, pageSlug, PHONE_WIDTH, runCheckCli, summary, type CheckOptions } from "./check.ts";
import { MEASURE, type Cut } from "./measure.ts";
import { resolveFile, serve } from "./serve.ts";

let root: string;

const LONG = "A long sentence with enough words to pass the right edge of a phone screen, and of the card around it, on one line";
const NOWRAP = "white-space: nowrap";
/** The rows of an API table. */
const ROWS = `<thead><tr><th>Call</th><th>Result</th><th>Note</th></tr></thead><tbody><tr><td>runMigrations(db, migrations)</td><td>The number of applied versions</td><td>${LONG}</td></tr></tbody>`;
/** The CSS of the API table of docker-mongo#49: the card clips, the box in it scrolls, and the table has a minimum width. */
const CARD_CSS = `<style>.table-card{padding:0;overflow:hidden}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:0}.api-table{min-width:46rem}</style>`;
/** The CSS of docker-sqlite#42: the phone layout stacks the rows, and the later minimum width beats it. */
const STACKED_CSS = `<style>.table-scroll{overflow-x:auto}table{min-width:0}@media (max-width:640px){.stacked,.stacked tbody,.stacked tr,.stacked td{display:block;min-width:0}}.stacked{min-width:46rem}</style>`;
/** A script that gives the box #box the width of its text #text, plus the given number of pixels. */
const fit = (pixels: number) => `<div id="box" style="overflow: hidden; width: max-content; ${NOWRAP}"><span id="text">A short text</span></div><script>document.getElementById("box").style.width = document.getElementById("text").getBoundingClientRect().width + (${pixels}) + "px";</script>`;

const page = (body: string, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">${head}</head><body>${body}</body></html>`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "site-check-test-"));
  const write = (file: string, text: string) => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write("index.html", page(`<h1>Home</h1><button id="go">Go</button><output id="out"></output><script src="app.js"></script>`));
  write("app.js", `document.getElementById("go").addEventListener("click", () => { document.getElementById("out").textContent = "done"; });`);
  write("wide/index.html", page(`<h1>Wide</h1><div id="wide" style="width: 900px">A wide block</div>`));
  write("fixed-empty/index.html", page(`<h1>Panel</h1><aside id="panel" style="position: fixed; top: 0; left: 200px; width: 100%; height: 100vh"><div id="inner" style="width: 100%"><p style="width: 100px">Short</p></div></aside>`));
  write("fixed-text/index.html", page(`<h1>Panel</h1><aside id="over" style="position: fixed; top: 0; left: 200px; width: 100%; white-space: nowrap">This text is long, and the screen cuts it at the right edge of the view</aside>`));
  write("scroller/index.html", page(`<h1>Scroller</h1><div data-overflow-ok style="overflow-x: auto"><table><tr><td style="min-width: 900px">A wide table in a scroller</td></tr></table></div><pre style="overflow-x:auto">a long line of code that is wider than a phone screen, in a pre that scrolls</pre>`));
  write("broken/index.html", page(`<h1>Broken</h1><img src="missing.png" alt=""><script>console.error("bad thing")</script>`));
  write("throws/index.html", page(`<h1>Throws</h1><script>throw new Error("boom")</script>`));
  write("empty/index.html", page(``));
  const OTHER_SITE = `<meta name="site-check-other-paths" content="^/site/other-[a-z]+/$">`;
  const FETCH_OTHER = `<script>fetch("../other-one/", { method: "HEAD" })</script><iframe src="../other-two/" title="Other site"></iframe>`;
  write("other-sites/index.html", page(`<h1>Other sites</h1>${FETCH_OTHER}`, OTHER_SITE));
  write("other-sites-own/index.html", page(`<h1>Other sites</h1><img src="missing.png" alt=""><script>fetch("../other-one/", { method: "HEAD" })</script>`, OTHER_SITE));
  write("other-sites-none/index.html", page(`<h1>Other sites</h1><script>fetch("../other-one/", { method: "HEAD" })</script>`));
  // A table with the class of the cue, and with the merged line of a minifier that the browser refuses: no cue shows.
  write("dead-cue/index.html", page(`<h1>Dead cue</h1><div class="scroll-cue" style="overflow-x: auto"><table style="min-width: 46rem"><tr><td>${LONG}</td></tr></table></div>`, `<style>@keyframes fades{to{opacity:1}}@supports (animation-timeline:scroll()){.scroll-cue{background-image:none;animation:linear both fades scroll(self inline)}}</style>`));
  // A clean copy of the same page: the two lines stay apart, and the cue shows.
  write("live-cue/index.html", page(`<h1>Live cue</h1><div class="scroll-cue" style="overflow-x: auto"><table style="min-width: 46rem"><tr><td>${LONG}</td></tr></table></div>`, `<style>@keyframes fades{to{opacity:1}}@supports (animation-timeline:scroll()){.scroll-cue{background-image:none;animation-name:fades;animation-timeline:scroll(self inline)}}</style>`));
  write("other-sites-bad/index.html", page(`<h1>Other sites</h1>`, `<meta name="site-check-other-paths" content="(">`));
  write("module/index.html", page(`<h1>Module</h1><p>A module script that imports a Node.js module</p><script type="module" src="page.js"></script>`));
  write("module/page.js", `import "node:perf_hooks";\ndocument.querySelector("p").textContent = "ran";`);
  write("clip/index.html", page(`<h1>Clip</h1><textarea id="ed" style="overflow: hidden; height: 2em">${"a line\n".repeat(20)}</textarea>`));
  write("api-card/index.html", page(`<h1>API</h1><section class="table-card"><div class="table-scroll"><table class="api-table">${ROWS}</table></div></section>`, CARD_CSS));
  write("api-stacked/index.html", page(`<h1>API</h1><section><div class="table-scroll"><table class="stacked">${ROWS}</table></div></section>`, STACKED_CSS));
  write("grid/index.html", page(`<h1>Grid</h1><div id="sc" style="overflow-x: auto"><div role="grid" style="width: 900px"><div role="row"><span role="gridcell" style="${NOWRAP}">${LONG}</span></div></div></div>`));
  write("clip-table/index.html", page(`<h1>Clip</h1><div id="card" style="overflow: hidden"><table style="min-width: 46rem"><tr><td>${LONG}</td></tr></table></div>`));
  write("clip-text/index.html", page(`<h1>Clip</h1><div id="card" style="overflow-x: clip"><p id="line" style="${NOWRAP}">${LONG} ${LONG}</p></div>`));
  write("clip-scroller/index.html", page(`<h1>Clip</h1><div id="card" style="overflow: hidden"><div style="width: 4000px; overflow-x: auto"><p style="${NOWRAP}">${LONG} ${LONG}</p></div></div>`));
  write("wide-table/index.html", page(`<h1>Wide table</h1><div style="overflow-x: auto"><table style="min-width: 2000px"><tr><td>${LONG} ${LONG} ${LONG}</td></tr></table></div>`));
  write("over-1px/index.html", page(`<h1>Over</h1>${fit(-3)}`));
  write("under-1px/index.html", page(`<h1>Under</h1>${fit(-0.6)}`));
  write(
    "fine/index.html",
    page(
      [
        `<h1>Fine</h1>`,
        `<pre id="code" style="overflow-x: auto">${LONG}</pre>`,
        `<div style="overflow: hidden"><pre id="code-in-card" style="overflow-x: auto">${LONG}</pre></div>`,
        `<div id="hex" style="overflow-x: auto; ${NOWRAP}; font-family: monospace"><div>00000000  47 49 46 38 39 61 01 00  01 00 80 00 00 ff ff ff 00 00 00 21 f9 04 01 00 00 00 00 2c 00 00 00 00</div></div>`,
        `<nav style="overflow-x: auto; ${NOWRAP}">${LONG}</nav>`,
        `<div data-overflow-ok style="overflow-x: auto"><table style="min-width: 46rem"><tr><td>${LONG}</td></tr></table></div>`,
        `<div style="overflow-x: auto"><table data-overflow-ok style="min-width: 46rem"><tr><td>${LONG}</td></tr></table></div>`,
        `<div class="scroll-cue" style="overflow-x: auto; background-image: linear-gradient(#fff, #eee)"><table style="min-width: 46rem"><tr><td>${LONG}</td></tr></table></div>`,
        `<div data-overflow-ok style="overflow: hidden"><div style="${NOWRAP}">${LONG}</div></div>`,
        `<p id="ellipsis" style="overflow: hidden; text-overflow: ellipsis; ${NOWRAP}">${LONG}</p>`,
        `<div style="overflow: hidden"><span style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); ${NOWRAP}">${LONG}</span></div>`,
        `<div style="overflow: hidden"><span class="sr-only" style="display: inline-block; ${NOWRAP}">${LONG}</span></div>`,
        `<table><thead style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%)"><tr><th style="${NOWRAP}">${LONG}</th></tr></thead><tbody><tr><td>A cell</td></tr></tbody></table>`,
        `<div style="overflow: hidden"><p style="display: none; ${NOWRAP}">${LONG}</p><p style="visibility: hidden; ${NOWRAP}">${LONG}</p><p style="opacity: 0; ${NOWRAP}">${LONG}</p></div>`,
        `<div style="overflow: hidden; height: 2rem"><div style="width: 900px; height: 2rem; background: currentColor"></div></div>`,
        `<div style="overflow: hidden"><div aria-hidden="true" style="${NOWRAP}">${LONG}</div></div>`,
        `<div style="overflow-x: auto"><table style="width: 900px"><tr><td>Short</td><td></td></tr></table></div>`,
      ].join(""),
    ),
  );
  write("404.html", page(`<h1>Not found</h1>`));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("resolveFile", () => {
  it("gives the index.html of a folder and of the home", () => {
    expect(resolveFile(root, "/site/", "/site/")).toBe(join(root, "index.html"));
    expect(resolveFile(root, "/site/", "/site")).toBe(join(root, "index.html"));
    expect(resolveFile(root, "/site/", "/site/wide/")).toBe(join(root, "wide", "index.html"));
    expect(resolveFile(root, "/site/", "/site/wide")).toBe(join(root, "wide", "index.html"));
    expect(resolveFile(root, "/", "/app.js")).toBe(join(root, "app.js"));
  });
  it("refuses a path outside the base or the folder", () => {
    expect(resolveFile(root, "/site/", "/other/index.html")).toBeUndefined();
    expect(resolveFile(root, "/site/", "/site/../../etc/passwd")).toBeUndefined();
    expect(resolveFile(root, "/site/", "/site/%2e%2e/%2e%2e/x")).toBeUndefined();
    expect(resolveFile(root, "/site/", "/site/%E0%A4%A")).toBeUndefined();
    expect(resolveFile(root, "/site/", "/site/nothing.html")).toBeUndefined();
  });
});

describe("serve", () => {
  it("serves the folder at the base, with 404.html and a redirect of the bare base", async () => {
    const server = await serve(root, "/site/");
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/site\/$/);
      const home = await fetch(server.url);
      expect(home.status).toBe(200);
      expect(home.headers.get("content-type")).toContain("text/html");
      expect(await home.text()).toContain("<h1>Home</h1>");
      const script = await fetch(new URL("app.js", server.url));
      expect(script.headers.get("content-type")).toContain("text/javascript");
      const missing = await fetch(new URL("nothing/", server.url));
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain("Not found");
      const bare = await fetch(server.url.slice(0, -1), { redirect: "manual" });
      expect(bare.status).toBe(301);
      expect(bare.headers.get("location")).toBe("/site/");
    } finally {
      await server.close();
    }
  });
});

describe("pageSlug", () => {
  it("names the pages", () => {
    expect(pageSlug("/")).toBe("home");
    expect(pageSlug("/releases/")).toBe("releases");
    expect(pageSlug("docs/a b/")).toBe("docs_a_b");
  });
});

describe("cell", () => {
  it("escapes the text for a Markdown table cell", () => {
    expect(cell("a|b \\| c <x>\nd")).toBe("a\\|b \\\\\\| c &lt;x&gt; d");
  });
});

describe("cutProblems", () => {
  const cut = (kind: Cut["kind"]): Cut => ({ kind, box: "div.card", element: "table.api", scrollWidth: 736, clientWidth: 302, text: "runMigrations" });

  it("tells the element, the box, the widths, the width of the view and the two fixes", () => {
    expect(cutProblems([{ ...cut("table"), deadCue: true }], 1280)).toEqual([]);
    expect(cutProblems([{ ...cut("table"), deadCue: true }], 360)[0]).toContain("The box has the class scroll-cue, but its computed style has no animation and no shade.");
    expect(cutProblems([cut("table")], 360)).toEqual([`a table goes out of view at 360 px: table.api in div.card: content of 736 px in a box of 302 px, "runMigrations". Make the table fit, give the box the class scroll-cue, or add data-overflow-ok to the box.`]);
    expect(cutProblems([cut("clip")], 400)).toEqual([`a box cuts text at 400 px: table.api in div.card: content of 736 px in a box of 302 px, "runMigrations". Make the content fit, or add data-overflow-ok to the box.`]);
  });
  it("reports a clip at each width, and a table in a scroller only on a phone", () => {
    expect(cutProblems([cut("clip")], 1280)).toHaveLength(1);
    expect(cutProblems([cut("table")], PHONE_WIDTH - 1)).toHaveLength(1);
    expect(cutProblems([cut("table")], PHONE_WIDTH)).toEqual([]);
    expect(cutProblems([], 360)).toEqual([]);
  });
});

describe("MEASURE", () => {
  it("is a valid script", () => {
    expect(() => new Script(MEASURE)).not.toThrow();
  });
  it("gets a whitespace class into the page, not a bare letter", () => {
    expect(MEASURE).toContain(String.raw`replace(/\s+/g, " ")`);
  });
});

describe("runCheckCli", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { cwd: root, env: {}, stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) } };
  };
  it("shows the help", async () => {
    const run = io();
    expect(await runCheckCli(["--help"], run.io)).toBe(0);
    expect(run.out.join("")).toContain("Usage: site-pages check");
  });
  it("refuses a wrong command line with code 2", async () => {
    for (const argv of [[], ["--out", ".", "--url", "http://x/"], ["--out", "."], ["--url", "http://x/", "--widths", "10"], ["--url", "http://x/", "--schemes", "blue"], ["--url", "http://x/", "--probe", "no-such-file.js"], ["--nope"]]) {
      const run = io();
      expect(await runCheckCli(argv, run.io), argv.join(" ")).toBe(2);
      expect(run.err.join("")).toContain("site-pages check:");
    }
  });
});

// In CI, a browser is necessary: a check with no browser must not pass in silence.
const browser = findBrowser();
if (browser === undefined && process.env["CI"]) throw new Error("CI has no Chromium browser for the tests of site-pages check");

describe.skipIf(browser === undefined)("checkSite in a browser", () => {
  const options = (pages: string[], extra: Partial<CheckOptions> = {}): CheckOptions => ({
    out: root,
    base: "/site/",
    pages,
    widths: [360, 1280],
    schemes: ["light", "dark"],
    settleMs: 100,
    timeoutMs: 30_000,
    ...extra,
  });

  it("fails a table with the class of the cue when the served CSS gives no cue, and passes a clean copy", async () => {
    const result = await checkSite(options(["/dead-cue/", "/live-cue/"], { widths: [360], schemes: ["light"] }));
    const problems = (page: string) => result.views.find((view) => view.page === page)?.problems;
    expect(problems("/dead-cue/")?.join(" ")).toContain("The box has the class scroll-cue, but its computed style has no animation and no shade.");
    expect(problems("/live-cue/")).toEqual([]);
  });

  it("passes a good page and writes a screenshot of each view", async () => {
    const shots = join(root, "..", `${root.split(/[\\/]/).pop()}-shots`);
    try {
      const result = await checkSite(options(["/", "/scroller/"], { shots }));
      expect(result.views.map((view) => view.problems)).toEqual([[], [], [], [], [], [], [], []]);
      expect(result.ok).toBe(true);
      for (const name of ["home-360-light", "home-360-dark", "home-1280-light", "scroller-360-dark"]) expect(existsSync(join(shots, `${name}.png`)), name).toBe(true);
      const png = readFileSync(join(shots, "home-360-light.png"));
      expect(png.readUInt32BE(16)).toBe(360);
      expect(JSON.parse(readFileSync(join(shots, "report.json"), "utf8")).ok).toBe(true);
      expect(readFileSync(join(shots, "summary.md"), "utf8")).toContain("8 of 8 views passed");
    } finally {
      rmSync(shots, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails each kind of problem", async () => {
    const result = await checkSite(options(["/wide/", "/broken/", "/throws/", "/empty/", "/clip/", "/module/", "/nothing/"], { widths: [360], schemes: ["light"] }));
    const problems = Object.fromEntries(result.views.map((view) => [view.page, view.problems.join("\n")]));
    expect(result.ok).toBe(false);
    expect(problems["/wide/"]).toMatch(/wider than the screen: 9\d\d > 360/);
    expect(problems["/wide/"]).toContain("past the right edge: div#wide");
    expect(problems["/broken/"]).toContain("console.error: bad thing");
    expect(problems["/broken/"]).toMatch(/HTTP 404: .*missing\.png/);
    expect(problems["/throws/"]).toContain("exception: Error: boom");
    expect(problems["/empty/"]).toContain("the page shows no text");
    expect(problems["/clip/"]).toContain("a text area hides its text: textarea#ed");
    expect(problems["/module/"]).toContain("console.error: failed to load script: page.js");
    expect(problems["/nothing/"]).toMatch(/HTTP 404: .*\/nothing\//);
  }, 120_000);

  it("counts a fixed box only for the text past the edge", async () => {
    const result = await checkSite(options(["/fixed-empty/", "/fixed-text/"], { widths: [360], schemes: ["light"] }));
    const problems = Object.fromEntries(result.views.map((view) => [view.page, view.problems.join("\n")]));
    expect(problems["/fixed-empty/"]).toBe("");
    expect(problems["/fixed-text/"]).toContain("past the right edge: aside#over");
  }, 120_000);

  it("does not count a refused request to a path of another site that the page names", async () => {
    const result = await checkSite(options(["/other-sites/"], { widths: [360], schemes: ["light"] }));
    expect(result.views[0]?.problems).toEqual([]);
  }, 120_000);

  it("counts each other refused request, also on a page that names other sites", async () => {
    const result = await checkSite(options(["/other-sites-own/", "/other-sites-none/", "/other-sites-bad/"], { widths: [360], schemes: ["light"] }));
    const problems = Object.fromEntries(result.views.map((view) => [view.page, view.problems.join("\n")]));
    expect(problems["/other-sites-own/"]).toMatch(/HTTP 404: .*missing\.png/);
    expect(problems["/other-sites-own/"]).not.toContain("other-one");
    expect(problems["/other-sites-none/"]).toMatch(/HTTP 404: .*other-one/);
    expect(problems["/other-sites-bad/"]).toContain("Invalid regular expression");
  }, 120_000);

  it("finds the two real faults: an API table in a scroller at the phone widths", async () => {
    const result = await checkSite(options(["/api-card/", "/api-stacked/", "/grid/"], { widths: [360, 400, 1280], schemes: ["light"] }));
    const at = (page: string, width: number) => result.views.find((view) => view.page === page && view.width === width)?.problems ?? [];
    expect(at("/api-card/", 360)).toHaveLength(1);
    expect(at("/api-card/", 360)[0]).toMatch(/^a table goes out of view at 360 px: table\.api-table in div\.table-scroll: content of 736 px in a box of 344 px, "/);
    expect(at("/api-card/", 400)[0]).toMatch(/at 400 px: .* a box of 384 px/);
    expect(at("/api-stacked/", 360)).toHaveLength(1);
    expect(at("/api-stacked/", 360)[0]).toMatch(/^a table goes out of view at 360 px: table\.stacked in div\.table-scroll: content of 736 px/);
    expect(at("/grid/", 360)[0]).toContain("a table goes out of view at 360 px: div in div#sc");
    expect(at("/api-card/", 1280)).toEqual([]);
    expect(at("/api-stacked/", 1280)).toEqual([]);
    const report = summary(result);
    expect(report).toContain("| `/api-card/` | 360 | light | **fail** | a table goes out of view at 360 px: table.api-table");
  }, 120_000);

  it("finds a box that cuts text at each width, also around a scroller", async () => {
    const result = await checkSite(options(["/clip-table/", "/clip-text/", "/clip-scroller/"], { widths: [360, 1280], schemes: ["light"] }));
    const at = (page: string, width: number) => result.views.find((view) => view.page === page && view.width === width)?.problems.join("\n") ?? "";
    expect(at("/clip-table/", 360)).toMatch(/a box cuts text at 360 px: td in div#card: content of 7\d\d px in a box of 344 px, "A long sentence/);
    expect(at("/clip-table/", 1280)).toBe("");
    expect(at("/clip-text/", 360)).toContain("a box cuts text at 360 px: p#line in div#card");
    expect(at("/clip-text/", 1280)).toContain("a box cuts text at 1280 px: p#line in div#card");
    expect(at("/clip-scroller/", 360)).toContain("a box cuts text at 360 px: p in div#card");
  }, 120_000);

  it("reports a table in a scroller on a desktop in the measure, not as a problem", async () => {
    const result = await checkSite(options(["/wide-table/"], { schemes: ["light"] }));
    const [phone, desktop] = result.views;
    expect(phone?.problems.join("\n")).toContain("a table goes out of view at 360 px");
    expect(desktop?.problems).toEqual([]);
    expect(desktop?.measure?.cut[0]).toMatchObject({ kind: "table", element: "table", scrollWidth: 2000, clientWidth: 1264 });
  }, 120_000);

  it("uses a tolerance of 1 px", async () => {
    const result = await checkSite(options(["/over-1px/", "/under-1px/"], { widths: [360], schemes: ["light"] }));
    expect(result.views[0]?.problems.join("\n")).toContain("a box cuts text at 360 px: span#text in div#box");
    expect(result.views[1]?.problems).toEqual([]);
  }, 120_000);

  it("passes a scroller that is meant to scroll, an ellipsis, a screen-reader element, a hidden element and a decoration", async () => {
    const result = await checkSite(options(["/fine/"], { widths: [360, 400, 1280] }));
    expect(result.views.map((view) => view.problems)).toEqual([[], [], [], [], [], []]);
    expect(result.views.every((view) => view.measure?.cut.length === 0)).toBe(true);
  }, 120_000);

  it("runs the probe on the first page at each width, and fails a failed check", async () => {
    const good = await checkSite(options(["/", "/wide/"], { schemes: ["light"], probe: `click("#go"); check("the button writes done", await until(() => $("#out").textContent === "done"), $("#out").textContent);` }));
    expect(good.views.map((view) => view.probe?.length ?? 0)).toEqual([1, 1, 0, 0]);
    expect(good.views[0]?.ok).toBe(true);
    const bad = await checkSite(options(["/"], { widths: [1280], schemes: ["light"], probe: `check("a missing thing", $("#missing"), "no #missing")` }));
    expect(bad.views[0]?.problems).toEqual(["probe: a missing thing (no #missing)"]);
    const thrown = await checkSite(options(["/"], { widths: [1280], schemes: ["light"], probe: `click("#missing")` }));
    expect(thrown.views[0]?.problems.join("\n")).toContain("probe: the probe runs to its end (Error: no element: #missing");
    const none = await checkSite(options(["/"], { widths: [1280], schemes: ["light"], probe: `await wait(1)` }));
    expect(none.views[0]?.problems).toEqual(["the probe made no check"]);
  }, 120_000);
});
