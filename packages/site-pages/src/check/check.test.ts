import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBrowser } from "./browser.ts";
import { checkSite, pageSlug, runCheckCli, type CheckOptions } from "./check.ts";
import { resolveFile, serve } from "./serve.ts";

let root: string;

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
  write("scroller/index.html", page(`<h1>Scroller</h1><div style="overflow-x: auto"><table><tr><td style="min-width: 900px">A wide table in a scroller</td></tr></table></div><pre style="overflow-x:auto">a long line of code that is wider than a phone screen, in a pre that scrolls</pre>`));
  write("broken/index.html", page(`<h1>Broken</h1><img src="missing.png" alt=""><script>console.error("bad thing")</script>`));
  write("throws/index.html", page(`<h1>Throws</h1><script>throw new Error("boom")</script>`));
  write("empty/index.html", page(``));
  write("clip/index.html", page(`<h1>Clip</h1><textarea id="ed" style="overflow: hidden; height: 2em">${"a line\n".repeat(20)}</textarea>`));
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
    const result = await checkSite(options(["/wide/", "/broken/", "/throws/", "/empty/", "/clip/", "/nothing/"], { widths: [360], schemes: ["light"] }));
    const problems = Object.fromEntries(result.views.map((view) => [view.page, view.problems.join("\n")]));
    expect(result.ok).toBe(false);
    expect(problems["/wide/"]).toMatch(/wider than the screen: 9\d\d > 360/);
    expect(problems["/wide/"]).toContain("past the right edge: div#wide");
    expect(problems["/broken/"]).toContain("console.error: bad thing");
    expect(problems["/broken/"]).toMatch(/HTTP 404: .*missing\.png/);
    expect(problems["/throws/"]).toContain("exception: Error: boom");
    expect(problems["/empty/"]).toContain("the page shows no text");
    expect(problems["/clip/"]).toContain("a text area hides its text: textarea#ed");
    expect(problems["/nothing/"]).toMatch(/HTTP 404: .*\/nothing\//);
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
