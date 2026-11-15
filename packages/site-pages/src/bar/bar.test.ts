import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyBar, barHtml, barPages, currentLink, htmlFiles, injectBar, pagePath, parsePages, runBarCli, type BarOptions } from "./bar.ts";

const options: BarOptions = {
  repository: "owner/packing",
  base: "/packing/",
  pages: [
    { label: "Demo", path: "demo/" },
    { label: "Docs", path: "docs/" },
  ],
  sitePages: true,
  npm: "@owner/packing",
  portfolio: "https://owner.github.io/",
};

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const site = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "site-bar-"));
  folders.push(root);
  for (const [file, html] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), html);
  }
  return root;
};
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { cwd: ".", env: {}, stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) } };
};

describe("the links of the bar", () => {
  it("gives the home, the pages, Releases and Status, one time each", () => {
    expect(barPages(options).map((entry) => entry.label)).toEqual(["Home", "Demo", "Docs", "Releases", "Status"]);
    expect(barPages({ ...options, sitePages: false, pages: [{ label: "Again", path: "" }, { label: "Docs", path: "docs/" }, { label: "Docs 2", path: "docs/" }] }).map((entry) => entry.label)).toEqual(["Home", "Docs"]);
  });

  it("marks the link with the longest path that starts the page path, and the home only on the home page", () => {
    const pages = barPages(options);
    expect(currentLink(pages, "")?.label).toBe("Home");
    expect(currentLink(pages, "docs/guide/start.html")?.label).toBe("Docs");
    expect(currentLink(pages, "releases/")?.label).toBe("Releases");
    expect(currentLink(pages, "other/")).toBeUndefined();
    expect(currentLink([{ label: "A", path: "docs/" }, { label: "B", path: "docs/api/" }], "docs/api/x.html")?.label).toBe("B");
  });

  it("gives the path of a file from the site home", () => {
    expect(pagePath("index.html")).toBe("");
    expect(pagePath(join("docs", "index.html"))).toBe("docs/");
    expect(pagePath(join("docs", "page.html"))).toBe("docs/page.html");
  });
});

describe("barHtml", () => {
  it("has the portfolio, the site, the pages, GitHub and npm, and marks the current page", () => {
    const html = barHtml(options, "docs/");
    expect(html).toContain('data-site-bar aria-label="Site"');
    expect(html).toContain('<a class="spb-owner" href="https://owner.github.io/">owner</a>');
    expect(html).toContain('<a class="spb-site" href="/packing/">packing</a>');
    expect(html).toContain('<a href="/packing/docs/" target="_self" aria-current="page">Docs</a>');
    expect(html).toContain('<a href="/packing/" target="_self">Home</a>');
    expect(html).toContain('href="https://github.com/owner/packing">GitHub</a>');
    expect(html).toContain('href="https://www.npmjs.com/package/@owner/packing">npm</a>');
    expect(html.match(/aria-current/g)).toHaveLength(1);
  });

  it("has no portfolio link and no npm link without them, and escapes the names", () => {
    const html = barHtml({ ...options, portfolio: undefined, npm: undefined, siteName: "<b>Pack</b>" }, "");
    expect(html).not.toContain("spb-owner");
    expect(html).not.toContain("npmjs");
    expect(html).toContain("&lt;b&gt;Pack&lt;/b&gt;");
    expect(barHtml({ ...options, portfolio: "javascript:alert(1)" }, "")).not.toContain("javascript:");
  });
});

describe("injectBar", () => {
  const page = '<!doctype html><html><head><title>t</title></head><body class="x"><div id="root"></div></body></html>';

  it("puts the bar first in the body and its CSS last in the head", () => {
    const html = injectBar(page, barHtml(options, ""));
    expect(html.indexOf('<style id="site-bar-css">')).toBeLessThan(html.indexOf("</head>"));
    expect(html).toMatch(/<body class="x">\n<nav class="spb" data-site-bar/);
    expect(html.indexOf("data-site-bar")).toBeLessThan(html.indexOf('<div id="root">'));
  });

  it("gives the same page when it starts two times", () => {
    const once = injectBar(page, barHtml(options, ""));
    expect(injectBar(once, barHtml(options, ""))).toBe(once);
  });

  it("takes the place of the header of a page of site-pages", () => {
    const releases = '<html><head></head><body>\n<a class="sp-skip" href="#main">Skip</a>\n<header class="sp-header"><nav aria-label="Site"><a class="sp-home" href="/packing/">packing</a></nav></header>\n<main id="main"></main></body></html>';
    const html = injectBar(releases, barHtml(options, "releases/"));
    expect(html).not.toContain("sp-header");
    expect(html).toContain('<a class="sp-skip" href="#main">Skip</a>');
  });

  it("changes no page with no body", () => {
    expect(injectBar("<svg></svg>", barHtml(options, ""))).toBe("<svg></svg>");
  });
});

describe("applyBar", () => {
  it("writes the bar into each HTML page of the folder, with the current page of each", () => {
    const root = site({ "index.html": "<html><head></head><body></body></html>", "docs/index.html": "<html><head></head><body></body></html>", "data/x.json": "{}" });
    expect(htmlFiles(root)).toEqual(["docs/index.html", "index.html"].map((file) => join(...file.split("/"))));
    expect(applyBar(root, options)).toBe(2);
    expect(readFileSync(join(root, "docs", "index.html"), "utf8")).toContain('aria-current="page">Docs</a>');
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain('aria-current="page">Home</a>');
    expect(readFileSync(join(root, "data", "x.json"), "utf8")).toBe("{}");
  });
});

describe("runBarCli", () => {
  it("writes the bar with the default base and portfolio", () => {
    const root = site({ "index.html": "<html><head></head><body></body></html>" });
    const run = io();
    expect(runBarCli(["--out", root, "--repo", "Owner/packing", "--pages", "Demo=demo/", "--site-pages", "--npm", "@owner/packing"], run.io)).toBe(0);
    const html = readFileSync(join(root, "index.html"), "utf8");
    expect(html).toContain('href="https://owner.github.io/">Owner</a>');
    expect(html).toContain('href="/packing/demo/"');
    expect(run.out.join("")).toContain("the bar is in 1 pages, with Home, Demo, Releases, Status.");
  });

  it("gives the site of the owner the base / and no portfolio link", () => {
    const root = site({ "index.html": "<html><head></head><body></body></html>" });
    expect(runBarCli(["--out", root, "--repo", "owner/owner.github.io"], io().io)).toBe(0);
    const html = readFileSync(join(root, "index.html"), "utf8");
    expect(html).toContain('<a class="spb-site" href="/">owner.github.io</a>');
    // The style of the bar has a rule for the class, so the test examines the link only
    expect(html).not.toContain('class="spb-owner"');
  });

  it("refuses a wrong command line with exit code 2, and a folder with no page with exit code 1", () => {
    for (const argv of [[], ["--out", "x"], ["--out", "x", "--repo", "o/r", "--pages", "Docs"], ["--out", "x", "--repo", "o/r", "--pages", "Docs=C:/x"], ["--bad"]]) {
      const run = io();
      expect(runBarCli(argv, run.io), argv.join(" ")).toBe(2);
      expect(run.err.join("")).toContain("site-pages bar:");
    }
    expect(runBarCli(["--out", site({}), "--repo", "o/r"], io().io)).toBe(1);
  });

  it("parses the pages", () => {
    expect(parsePages(" Demo = /demo/ , Docs=docs/ ")).toEqual([
      { label: "Demo", path: "demo/" },
      { label: "Docs", path: "docs/" },
    ]);
    expect(parsePages("")).toEqual([]);
    expect(parsePages("=docs/")).toBeInstanceOf(Error);
  });
});
