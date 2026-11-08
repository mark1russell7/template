import { describe, expect, it } from "vitest";
import { navProblems, navSummary, runNavCli, sitemapPaths, sitePath, type NavLink, type NavPage } from "./nav.ts";

const home = new URL("https://owner.github.io/repo/");

const link = (href: string, extra: Partial<NavLink> = {}): NavLink => ({ href, text: href, target: "", visible: true, ...extra });
const page = (path: string, clicks: number, links: NavLink[], extra: Partial<NavPage> = {}): NavPage => ({
  path,
  clicks,
  status: 200,
  from: clicks === 0 ? undefined : "",
  links,
  homeAtPhone: true,
  bar: false,
  ...extra,
});
const back = link("https://owner.github.io/repo/");
const rules = { maxClicks: 2, requireBar: false };

describe("sitePath", () => {
  it("gives the path of a page of the site from its home", () => {
    expect(sitePath("https://owner.github.io/repo/", home)).toBe("");
    expect(sitePath("https://owner.github.io/repo/index.html", home)).toBe("");
    expect(sitePath("releases/", home)).toBe("releases/");
    expect(sitePath("/repo/docs/index.html", home)).toBe("docs/");
    expect(sitePath("/repo/docs/page.html", home)).toBe("docs/page.html");
    expect(sitePath("/repo/demo", home)).toBe("demo");
  });

  it("gives undefined for another site, another repository, a file and a bad URL", () => {
    expect(sitePath("https://github.com/owner/repo", home)).toBeUndefined();
    expect(sitePath("https://owner.github.io/other/", home)).toBeUndefined();
    expect(sitePath("/repo/data/bench.json", home)).toBeUndefined();
    expect(sitePath("http://[bad", home)).toBeUndefined();
  });
});

describe("sitemapPaths", () => {
  it("gives the pages of the site in the sitemap, one time each", () => {
    const xml = "<urlset><url><loc>https://owner.github.io/repo/</loc></url><url><loc> https://owner.github.io/repo/releases/ </loc></url><url><loc>https://owner.github.io/repo/releases/</loc></url><url><loc>https://example.com/</loc></url></urlset>";
    expect(sitemapPaths(xml, home)).toEqual(["", "releases/"]);
  });
});

describe("navProblems", () => {
  it("passes a site where each page links back to home", () => {
    const pages = [page("", 0, [link("releases/"), link("status/")]), page("releases/", 1, [back]), page("status/", 1, [back])];
    expect(navProblems({ pages, sitemap: ["", "releases/", "status/"], clicks: [] }, home, rules)).toEqual([]);
  });

  it("fails a page of the sitemap that no link reaches, and a page too many clicks from home", () => {
    const pages = [page("", 0, [link("a/")]), page("a/", 1, [back, link("b/")]), page("b/", 2, [back, link("c/")]), page("c/", 3, [back])];
    expect(navProblems({ pages, sitemap: ["c/", "hidden/"], clicks: [] }, home, rules)).toEqual([
      "/c/ is 3 clicks from home, over the limit of 2",
      "/hidden/ is in the sitemap, and no chain of links from home reaches it",
    ]);
  });

  it("fails a page with no visible link back to home, at the desktop width and at the phone width", () => {
    const pages = [
      page("", 0, [link("a/"), link("b/")]),
      page("a/", 1, [link("https://owner.github.io/repo/", { visible: false })]),
      page("b/", 1, [back], { homeAtPhone: false }),
    ];
    expect(navProblems({ pages, sitemap: [], clicks: [] }, home, rules)).toEqual(["/a/ shows no link back to home at 1280 px", "/b/ shows no link back to home at 360 px"]);
  });

  it("fails a link of the site that opens a new tab, and accepts a new tab for another site", () => {
    const pages = [page("", 0, [link("releases/", { text: "Releases", target: "_blank" }), link("https://github.com/owner/repo", { target: "_blank" })])];
    expect(navProblems({ pages, sitemap: [], clicks: [] }, home, rules)).toEqual([
      'the link "Releases" of the home page opens /releases/ in a new tab, so the back button of the browser does not go back',
    ]);
  });

  it("fails a link to a missing page, and does not ask that page for a link back", () => {
    const pages = [page("", 0, [link("gone/")]), page("gone/", 1, [], { status: 404 })];
    expect(navProblems({ pages, sitemap: [], clicks: [] }, home, rules)).toEqual(["a link of the home page goes to /gone/, which gives HTTP 404"]);
  });

  it("fails a click on Releases that shows another page, or the page of the site at that path", () => {
    const clicks = [
      { from: "", to: "releases/", landed: "", shown: false },
      { from: "", to: "status/", landed: "status/", shown: false },
      { from: "releases/", to: "status/", landed: "status/", shown: true },
    ];
    expect(navProblems({ pages: [page("", 0, [])], sitemap: [], clicks }, home, rules)).toEqual([
      "a click on the link to /releases/ of the home page shows the home page",
      "a click on the link to /status/ of the home page does not show that page: the site shows its own page at that path",
    ]);
  });

  it("asks each page for the site bar with requireBar", () => {
    const pages = [page("", 0, [link("a/")], { bar: true }), page("a/", 1, [back])];
    expect(navProblems({ pages, sitemap: [], clicks: [] }, home, { maxClicks: 2, requireBar: true })).toEqual(["/a/ has no site bar"]);
  });
});

describe("navSummary", () => {
  it("lists the problems and the pages", () => {
    const text = navSummary({ ok: false, home: home.href, pages: [page("", 0, [])], sitemap: [], clicks: [], problems: ["a | b"] });
    expect(text).toContain("1 pages opened, 0 in the sitemap, 1 problems.");
    expect(text).toContain("- a \\| b");
    expect(text).toContain("| 0 | the home page | 200 | yes | no |");
  });
});

describe("runNavCli", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { cwd: ".", env: {}, stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) } };
  };

  it("shows the help", async () => {
    const run = io();
    expect(await runNavCli(["--help"], run.io)).toBe(0);
    expect(run.out.join("")).toContain("Usage: site-pages nav");
  });

  it("refuses a wrong command line with exit code 2", async () => {
    for (const argv of [[], ["--out", "a", "--url", "b"], ["--url", "u", "--max-clicks", "0"], ["--url", "u", "--settle", "x"], ["--out", "a"], ["--url", "u", "--shot-pages", "C:/x"], ["--bad"]]) {
      const run = io();
      expect(await runNavCli(argv, run.io), argv.join(" ")).toBe(2);
      expect(run.err.join("")).toContain("site-pages nav:");
    }
  });
});
