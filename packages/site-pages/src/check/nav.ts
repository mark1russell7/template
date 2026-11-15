/**
 * The navigation check of a site (`site-pages nav`). It opens the home page in a headless Chromium.
 * It follows the links that the browser shows, and counts the clicks from home to each page.
 * The check fails when a page of the sitemap is more than `maxClicks` clicks from home.
 * It also fails when a page has no visible link back to home, or when a link of the site opens a new tab.
 * A link to a missing page fails too.
 *
 * The check clicks each link to the Releases page and the Status page.
 * A single-page application can catch such a click and show its own page in place of the page of site-pages.
 * The rules are functions with no I/O, so the tests call them with no browser.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { barHtml, injectBar, parsePages, type BarOptions } from "../bar/bar.ts";
import { findBrowser, launch, type Browser, type Page } from "./browser.ts";
import { cell, PHONE_WIDTH, pageSlug, type CheckIo } from "./check.ts";
import { serve } from "./serve.ts";

/** One link of a page, as the browser shows it. */
export interface NavLink {
  /** The absolute URL of the link, with no fragment. */
  readonly href: string;
  /** The text of the link, or its label. */
  readonly text: string;
  /** The value of the attribute `target`, or an empty text. */
  readonly target: string;
  /** True when the link has a size and the page does not hide it. */
  readonly visible: boolean;
}

/** One page that the crawl opened. */
export interface NavPage {
  /** The path of the page from the site home, for example `releases/`. The home is an empty text. */
  readonly path: string;
  /** The number of clicks from home. */
  readonly clicks: number;
  /** The HTTP status of the document. */
  readonly status: number;
  /** The path of the page that linked to this page first, or undefined for the home. */
  readonly from: string | undefined;
  /** The links of the page at the desktop width. */
  readonly links: readonly NavLink[];
  /** True when the page shows a link to home at the phone width. */
  readonly homeAtPhone: boolean;
  /** True when the page has the shared site bar (`[data-site-bar]`). */
  readonly bar: boolean;
}

/** The result of a click on a link to a page of site-pages. */
export interface NavClick {
  /** The page with the link. */
  readonly from: string;
  /** The path of the link. */
  readonly to: string;
  /** The path of the page after the click. */
  readonly landed: string;
  /** True when the page after the click has the header of site-pages (`.sp-header`) or the site bar. */
  readonly shown: boolean;
}

/** The options of `crawlSite`. */
export interface NavOptions {
  /** The built site folder. The crawl serves it at `base`. */
  readonly out?: string | undefined;
  /** The URL of a live site home, in place of `out`. */
  readonly url?: string | undefined;
  /** The path of the site home, for `out`. */
  readonly base?: string | undefined;
  /** The largest number of clicks from home to a page. */
  readonly maxClicks: number;
  /** The largest number of pages to open. */
  readonly maxPages: number;
  /** True: each page must have the shared site bar. */
  readonly requireBar: boolean;
  /** A folder for the screenshots, report.json and summary.md. */
  readonly shots?: string | undefined;
  /** The paths of the pages to take screenshots of, from the site home. */
  readonly shotPages: readonly string[];
  readonly browser?: string | undefined;
  readonly settleMs: number;
  readonly timeoutMs: number;
  readonly log?: ((line: string) => void) | undefined;
  /**
   * The content of a bar for a preview, or undefined for no preview. The browser writes this bar into each page of
   * the site as it loads, as the Pages workflow does after the build. Thus the crawl shows a live site with the bar.
   */
  readonly previewBar?: BarOptions | undefined;
}

/** The result of `crawlSite`. */
export interface NavResult {
  readonly ok: boolean;
  readonly home: string;
  readonly pages: readonly NavPage[];
  /** The paths of the sitemap, or an empty list when the site has no sitemap. */
  readonly sitemap: readonly string[];
  readonly clicks: readonly NavClick[];
  readonly problems: readonly string[];
  /**
   * The paths that the crawl did not open, because it stopped at the limit `maxPages`. A path of this list is a no-read: the
   * crawl does not know its problems. A result with a no-read is not `ok`.
   */
  readonly unread: readonly string[];
}

/**
 * This function gives the no-reads of a crawl: the paths left in its queue, and each path of the sitemap that it did not
 * open. A crawl with an empty queue read each page that a link reaches, so it has no no-read.
 */
export function navUnread(queue: readonly string[], pages: readonly Pick<NavPage, "path">[], sitemap: readonly string[]): string[] {
  if (queue.length === 0) return [];
  const opened = new Set(pages.map((page) => page.path));
  return [...new Set([...queue, ...sitemap.filter((path) => !opened.has(path))])];
}

/** The phone width of the check of the way back. */
export const NAV_PHONE_WIDTH = 360;
/** The desktop width of the crawl. */
export const NAV_DESKTOP_WIDTH = 1280;

/**
 * This function gives the path of a URL from the site home, or undefined when the URL is not a page
 * of the site. A file with an extension other than `.html` is not a page. `index.html` is its folder.
 */
export function sitePath(href: string, home: URL): string | undefined {
  let url: URL;
  try {
    url = new URL(href, home);
  } catch {
    return undefined;
  }
  if (url.origin !== home.origin || !url.pathname.startsWith(home.pathname)) return undefined;
  const path = url.pathname.slice(home.pathname.length).replace(/(^|\/)index\.html$/, "$1");
  const last = path.split("/").at(-1) ?? "";
  if (last.includes(".") && !last.endsWith(".html")) return undefined;
  return path;
}

/** This function gives the paths of the `<loc>` entries of a sitemap that are pages of the site. */
export function sitemapPaths(xml: string, home: URL): string[] {
  const paths = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => sitePath(match[1] ?? "", home));
  return [...new Set(paths.filter((path): path is string => path !== undefined))];
}

/** The name of a page in a message: its path, or "the home page". */
const named = (path: string) => (path === "" ? "the home page" : `/${path}`);

/** This function gives the problems of a crawl. It reads no file and opens no page. */
export function navProblems(result: Pick<NavResult, "pages" | "sitemap" | "clicks"> & { readonly unread?: readonly string[] }, home: URL, options: Pick<NavOptions, "maxClicks" | "requireBar">): string[] {
  const problems: string[] = [];
  const byPath = new Map(result.pages.map((page) => [page.path, page]));
  const unread = new Set(result.unread ?? []);
  for (const path of result.sitemap) {
    const page = byPath.get(path);
    // A page that the crawl did not open is a no-read, not a problem (refer to `navUnread`)
    if (page === undefined && unread.has(path)) continue;
    if (page === undefined) problems.push(`${named(path)} is in the sitemap, and no chain of links from home reaches it`);
    else if (page.clicks > options.maxClicks) problems.push(`${named(path)} is ${page.clicks} clicks from home, over the limit of ${options.maxClicks}`);
  }
  for (const page of result.pages) {
    if (page.status >= 400) {
      problems.push(`a link of ${named(page.from ?? "")} goes to ${named(page.path)}, which gives HTTP ${page.status}`);
      continue;
    }
    if (page.path !== "") {
      const back = page.links.some((link) => link.visible && sitePath(link.href, home) === "");
      if (!back) problems.push(`${named(page.path)} shows no link back to home at ${NAV_DESKTOP_WIDTH} px`);
      else if (!page.homeAtPhone) problems.push(`${named(page.path)} shows no link back to home at ${NAV_PHONE_WIDTH} px`);
    }
    if (options.requireBar && !page.bar) problems.push(`${named(page.path)} has no site bar`);
    for (const link of page.links) {
      if (link.target !== "" && link.target !== "_self" && sitePath(link.href, home) !== undefined) {
        problems.push(`the link "${link.text}" of ${named(page.path)} opens ${named(sitePath(link.href, home) ?? "")} in a new tab, so the back button of the browser does not go back`);
      }
    }
  }
  for (const click of result.clicks) {
    if (click.landed !== click.to) problems.push(`a click on the link to ${named(click.to)} of ${named(click.from)} shows ${named(click.landed)}`);
    else if (!click.shown) problems.push(`a click on the link to ${named(click.to)} of ${named(click.from)} does not show that page: the site shows its own page at that path`);
  }
  return [...new Set(problems)];
}

/**
 * The function that clicks the first link of the page to the path in its argument, in the same tab. It gives true when
 * the page has such a link. The path is an argument of the call, so it is not a part of the code.
 */
const CLICK_LINK = `function (pathname) {
  const a = [...document.querySelectorAll("a[href]")].find((el) => new URL(el.getAttribute("href"), location.href).pathname === pathname);
  if (a) { a.removeAttribute("target"); a.click(); }
  return Boolean(a);
}`;

/** The expression that gives the links of the page and the marks of its header. */
export const NAV_SCAN = `(() => {
  const shown = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    }
    return box.right > 0 && box.left < innerWidth;
  };
  const links = [...document.querySelectorAll("a[href]")].map((a) => {
    const url = new URL(a.getAttribute("href"), location.href);
    url.hash = "";
    const text = (a.textContent || a.getAttribute("aria-label") || a.getAttribute("title") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    return { href: url.href, text, target: a.getAttribute("target") || "", visible: shown(a) };
  });
  return { links, bar: document.querySelector("[data-site-bar]") !== null, spHeader: document.querySelector(".sp-header") !== null, path: location.pathname };
})()`;

interface Scan {
  links: NavLink[];
  bar: boolean;
  spHeader: boolean;
  path: string;
}

async function open(page: Page, target: string, width: number, options: NavOptions): Promise<{ status: number; scan: Scan }> {
  await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < PHONE_WIDTH });
  const loaded = page.once("Page.loadEventFired", options.timeoutMs);
  const navigation = (await page.send("Page.navigate", { url: target })) as { errorText?: string };
  if (navigation.errorText) {
    loaded.catch(() => {});
    return { status: 0, scan: { links: [], bar: false, spHeader: false, path: "" } };
  }
  await loaded;
  await new Promise((done) => setTimeout(done, options.settleMs));
  return { status: await documentStatus(target), scan: await page.evaluate<Scan>(NAV_SCAN) };
}

/** This function gives the HTTP status of the document at the URL, or 0 when the request fails. */
async function documentStatus(target: string): Promise<number> {
  try {
    const response = await fetch(target, { redirect: "follow" });
    await response.body?.cancel();
    return response.status;
  } catch {
    return 0;
  }
}

async function shot(page: Page, file: string, width: number): Promise<void> {
  const height = Math.min(Math.max(await page.evaluate<number>("document.documentElement.scrollHeight"), 1), 3000);
  const data = (await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } })) as { data: string };
  writeFileSync(file, Buffer.from(data.data, "base64"));
}

/** The fields of the event `Fetch.requestPaused` of a response. */
interface PausedResponse {
  requestId: string;
  request: { url: string };
  responseStatusCode?: number;
  responseHeaders?: { name: string; value: string }[];
}

/**
 * This function makes the browser write the bar into each HTML document of the site, at the response stage of the
 * request. A response that is not HTML, or a redirect, goes on with no change.
 */
async function previewBar(page: Page, home: URL, bar: BarOptions): Promise<void> {
  const fulfill = async (paused: PausedResponse) => {
    const status = paused.responseStatusCode ?? 200;
    const headers = paused.responseHeaders ?? [];
    const type = headers.find((header) => header.name.toLowerCase() === "content-type")?.value ?? "";
    if (!type.includes("text/html") || (status >= 300 && status < 400)) {
      await page.send("Fetch.continueRequest", { requestId: paused.requestId });
      return;
    }
    const body = (await page.send("Fetch.getResponseBody", { requestId: paused.requestId })) as { body: string; base64Encoded: boolean };
    const html = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
    const next = injectBar(html, barHtml(bar, sitePath(paused.request.url, home) ?? ""));
    await page.send("Fetch.fulfillRequest", {
      requestId: paused.requestId,
      responseCode: status,
      responseHeaders: headers.filter((header) => !/^(content-length|content-encoding)$/i.test(header.name)),
      body: Buffer.from(next, "utf8").toString("base64"),
    });
  };
  page.on("Fetch.requestPaused", (params) => {
    const paused = params as unknown as PausedResponse;
    fulfill(paused).catch(() => page.send("Fetch.continueRequest", { requestId: paused.requestId }).catch(() => {}));
  });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: `${home.origin}${home.pathname}*`, resourceType: "Document", requestStage: "Response" }] });
}

/**
 * This function gives the repository of a site of GitHub Pages from the URL of its home, for example `owner/name`
 * for `https://owner.github.io/name/`. It gives undefined for a URL of another host.
 */
export function repositoryOfUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const owner = /^([a-z0-9-]+)\.github\.io$/i.exec(parsed.hostname)?.[1];
  if (owner === undefined) return undefined;
  const name = parsed.pathname.split("/").filter(Boolean)[0];
  return `${owner}/${name ?? `${owner}.github.io`}`;
}

/** This function crawls the site, clicks the links to the pages of site-pages, and gives the result. */
export async function crawlSite(options: NavOptions): Promise<NavResult> {
  const log = options.log ?? (() => {});
  const executable = findBrowser(options.browser);
  if (executable === undefined) throw new Error("no Chromium browser was found: give --browser, set SITE_CHECK_BROWSER, or install the Chromium of Playwright");
  const server = options.out !== undefined ? await serve(options.out, options.base ?? "/") : undefined;
  const start = server?.url ?? options.url;
  if (start === undefined) throw new Error("give out or url");
  const home = new URL(start.endsWith("/") ? start : `${start}/`);
  let browser: Browser | undefined;
  const pages: NavPage[] = [];
  const clicks: NavClick[] = [];
  let sitemap: string[] = [];
  let left: string[] = [];
  try {
    browser = await launch(executable, options.timeoutMs);
    const { page } = browser;
    await Promise.all([page.send("Page.enable"), page.send("Runtime.enable")]);
    if (options.previewBar !== undefined) await previewBar(page, home, options.previewBar);
    try {
      const response = await fetch(new URL("sitemap.xml", home));
      if (response.ok) sitemap = sitemapPaths(await response.text(), home);
    } catch {
      sitemap = [];
    }
    if (options.shots) mkdirSync(options.shots, { recursive: true });
    const queue: { path: string; clicks: number; from: string | undefined }[] = [{ path: "", clicks: 0, from: undefined }];
    const seen = new Set<string>([""]);
    while (queue.length > 0 && pages.length < options.maxPages) {
      const next = queue.shift();
      if (next === undefined) break;
      const target = new URL(next.path, home).href;
      const desktop = await open(page, target, NAV_DESKTOP_WIDTH, options);
      const phone = await open(page, target, NAV_PHONE_WIDTH, options);
      const homeAtPhone = phone.scan.links.some((link) => link.visible && sitePath(link.href, home) === "");
      const entry: NavPage = { path: next.path, clicks: next.clicks, status: desktop.status, from: next.from, links: desktop.scan.links, homeAtPhone, bar: desktop.scan.bar };
      pages.push(entry);
      log(`${next.clicks} ${named(next.path)} HTTP ${desktop.status}, ${desktop.scan.links.length} links${homeAtPhone ? "" : ", no home link at 360 px"}`);
      if (desktop.status >= 400) continue;
      for (const link of desktop.scan.links) {
        const path = sitePath(link.href, home);
        if (path === undefined || seen.has(path)) continue;
        seen.add(path);
        queue.push({ path, clicks: next.clicks + 1, from: next.path });
      }
    }
    left = queue.map((entry) => entry.path);
    // A click on each link to a page of site-pages, from each page that the crawl opened at most one click from home.
    for (const from of pages.filter((entry) => entry.clicks <= 1 && entry.status < 400)) {
      const targets = [...new Set(from.links.map((link) => sitePath(link.href, home)).filter((path): path is string => path === "releases/" || path === "status/"))];
      for (const to of targets) {
        if (to === from.path) continue;
        await open(page, new URL(from.path, home).href, NAV_DESKTOP_WIDTH, options);
        const landed = page.once("Page.loadEventFired", options.timeoutMs).catch(() => undefined);
        await page.call(CLICK_LINK, new URL(to, home).pathname);
        await Promise.race([landed, new Promise((done) => setTimeout(done, 3000))]);
        await new Promise((done) => setTimeout(done, options.settleMs));
        const scan = await page.evaluate<Scan>(NAV_SCAN);
        const click: NavClick = { from: from.path, to, landed: sitePath(new URL(scan.path, home).href, home) ?? scan.path, shown: scan.spHeader || scan.bar };
        clicks.push(click);
        log(`click ${named(from.path)} -> ${named(to)}: ${named(click.landed)}${click.shown ? "" : ", not the page of site-pages"}`);
      }
    }
    if (options.shots) {
      for (const path of options.shotPages) {
        for (const width of [NAV_DESKTOP_WIDTH, NAV_PHONE_WIDTH]) {
          const clean = path.replace(/^\/+/, "");
          await open(page, new URL(clean, home).href, width, options);
          await shot(page, join(options.shots, `${pageSlug(path)}-${width}.png`), width);
        }
      }
    }
  } finally {
    // A browser that does not start throws in the try. The server then also closes, so the process can exit.
    await browser?.close();
    await server?.close();
  }
  const unread = navUnread(left, pages, sitemap);
  const problems = navProblems({ pages, sitemap, clicks, unread }, home, options);
  const result: NavResult = { ok: problems.length === 0 && unread.length === 0, home: home.href, pages, sitemap, clicks, problems, unread };
  if (options.shots) {
    writeFileSync(join(options.shots, "report.json"), `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(join(options.shots, "summary.md"), navSummary(result));
  }
  return result;
}

/** This function gives the text of the no-reads of a crawl, with their count and the first 10 paths. */
export function navUnreadText(result: Pick<NavResult, "pages" | "unread">): string {
  const first = result.unread.slice(0, 10).map(named).join(", ");
  const more = result.unread.length > 10 ? `, and ${String(result.unread.length - 10)} more` : "";
  return `the crawl stopped at the limit of ${result.pages.length} ${result.pages.length === 1 ? "page" : "pages"}, so it did not read ${result.unread.length} ${result.unread.length === 1 ? "page" : "pages"}: ${first}${more}.`;
}

/** This function gives the summary of a crawl as Markdown. */
export function navSummary(result: NavResult): string {
  const lines = [`### Navigation of ${result.home}`, "", `${result.pages.length} ${result.pages.length === 1 ? "page" : "pages"} opened, ${result.sitemap.length} in the sitemap, ${result.problems.length} ${result.problems.length === 1 ? "problem" : "problems"}.`, ""];
  if (result.unread.length > 0) lines.push(`**No read:** ${navUnreadText(result)}`, "");
  for (const problem of result.problems) lines.push(`- ${cell(problem)}`);
  lines.push("", "| Clicks | Page | HTTP | Home link at 360 px | Site bar |", "|---|---|---|---|---|");
  for (const page of result.pages) lines.push(`| ${page.clicks} | ${named(page.path)} | ${page.status} | ${page.homeAtPhone ? "yes" : "no"} | ${page.bar ? "yes" : "no"} |`);
  return `${lines.join("\n")}\n`;
}

export const NAV_HELP = `Usage: site-pages nav (--out <dir> | --url <url>) [options]

Opens the home page of the site in a headless Chromium and follows the links that the page shows,
page by page. It fails when a page of sitemap.xml is more than --max-clicks clicks from home, when
a page shows no link back to home at 1280 px or at 360 px, when a link of the site opens a new tab,
or when a link goes to a missing page. It clicks each link to releases/ and status/, and fails when
the page after the click does not have the header of site-pages.

Options:
  --out <dir>          The built site folder. The crawl serves it at --base.
  --url <url>          The URL of a live site home, in place of --out
  --repo <owner/name>  The GitHub repository, for the default base (default: $GITHUB_REPOSITORY)
  --base </name/>      The path of the site home (default: "/<name>/", or "/" for <owner>.github.io)
  --max-clicks <n>     The largest number of clicks from home to a page (default: 2)
  --max-pages <n>      The largest number of pages to open (default: 60)
  --require-bar        Each page must have the shared site bar ([data-site-bar])
  --preview-bar        The browser writes the shared site bar into each page of the site as it
                       loads, with Releases and Status. Thus a live site shows the bar before its
                       Pages workflow adds it. The repository comes from a github.io URL, or --repo.
  --bar-pages <list>   The pages of the preview bar, as label=path pairs separated by commas
  --bar-npm <name>     The npm name of the package, for the npm link of the preview bar
  --shots <dir>        The folder for the screenshots, report.json and summary.md
  --shot-pages <list>  The pages to take screenshots of, separated by commas (default: /,releases/,status/)
  --browser <file>     The Chromium executable (default: $SITE_CHECK_BROWSER, the Chromium of
                       Playwright, else Chrome or Edge)
  --settle <ms>        The wait after the load event (default: 800)
  --timeout <ms>       The time limit of a page load (default: 30000)
  --help               Shows this text

With $GITHUB_STEP_SUMMARY, the crawl adds its table to the job summary.
`;

/** This function starts the `nav` command with its arguments, without the word `nav`. */
export async function runNavCli(argv: readonly string[], io: CheckIo): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        out: { type: "string" },
        url: { type: "string" },
        repo: { type: "string" },
        base: { type: "string" },
        "max-clicks": { type: "string" },
        "max-pages": { type: "string" },
        "require-bar": { type: "boolean" },
        "preview-bar": { type: "boolean" },
        "bar-pages": { type: "string" },
        "bar-npm": { type: "string" },
        shots: { type: "string" },
        "shot-pages": { type: "string" },
        browser: { type: "string" },
        settle: { type: "string" },
        timeout: { type: "string" },
        help: { type: "boolean" },
      },
    }));
  } catch (error) {
    io.stderr(`site-pages nav: ${error instanceof Error ? error.message : String(error)}\n\n${NAV_HELP}`);
    return 2;
  }
  if (values["help"]) {
    io.stdout(NAV_HELP);
    return 0;
  }
  const usage = (message: string) => {
    io.stderr(`site-pages nav: ${message}\n\n${NAV_HELP}`);
    return 2;
  };
  const text = (key: string) => (typeof values[key] === "string" ? (values[key] as string) : undefined);
  const out = text("out");
  const url = text("url");
  if ((out === undefined) === (url === undefined)) return usage("give --out or --url, not both");
  const maxClicks = Number(text("max-clicks") ?? 2);
  const maxPages = Number(text("max-pages") ?? 60);
  if (!Number.isInteger(maxClicks) || maxClicks < 1 || !Number.isInteger(maxPages) || maxPages < 1) return usage("--max-clicks and --max-pages must be whole numbers of 1 or more");
  const settleMs = Number(text("settle") ?? 800);
  const timeoutMs = Number(text("timeout") ?? 30000);
  if (!(settleMs >= 0) || !(timeoutMs > 0)) return usage("--settle and --timeout must be numbers of milliseconds");
  const shotPages = (text("shot-pages") ?? "/,releases/,status/").split(",").map((entry) => entry.trim()).filter(Boolean);
  const notPath = shotPages.find((entry) => entry.includes(":") || entry.includes("\\"));
  if (notPath !== undefined) return usage(`a page is a path from the site home, not "${notPath}" (in Git Bash, set MSYS_NO_PATHCONV=1)`);
  let base = text("base");
  if (out !== undefined && base === undefined) {
    const name = (text("repo") ?? io.env["GITHUB_REPOSITORY"] ?? "").split("/")[1];
    if (!name) return usage("give --base, --repo or set GITHUB_REPOSITORY");
    base = /\.github\.io$/i.test(name) ? "/" : `/${name}/`;
  }
  if (base !== undefined) base = `/${base.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
  let preview: BarOptions | undefined;
  if (values["preview-bar"] === true) {
    const repository = text("repo") ?? (url === undefined ? io.env["GITHUB_REPOSITORY"] : repositoryOfUrl(url));
    if (repository === undefined || !repository.includes("/")) return usage("--preview-bar needs --repo for a site that is not on github.io");
    const pages = parsePages(text("bar-pages") ?? "");
    if (pages instanceof Error) return usage(pages.message);
    const previewBase = base ?? (url === undefined ? "/" : new URL(url.endsWith("/") ? url : `${url}/`).pathname);
    const [owner = ""] = repository.split("/");
    const ownerSite = repository.toLowerCase() === `${owner.toLowerCase()}/${owner.toLowerCase()}.github.io`;
    preview = { repository, base: previewBase, pages, sitePages: true, npm: text("bar-npm"), portfolio: ownerSite ? undefined : `https://${owner.toLowerCase()}.github.io/` };
  }
  const shots = text("shots");
  const result = await crawlSite({
    out: out === undefined ? undefined : isAbsolute(out) ? out : resolve(io.cwd, out),
    url,
    base,
    maxClicks,
    maxPages,
    requireBar: values["require-bar"] === true,
    previewBar: preview,
    shots: shots === undefined ? undefined : isAbsolute(shots) ? shots : resolve(io.cwd, shots),
    shotPages,
    browser: text("browser"),
    settleMs,
    timeoutMs,
    log: (line) => io.stdout(`${line}\n`),
  });
  for (const problem of result.problems) io.stdout(`FAIL ${problem}\n`);
  if (result.unread.length > 0) io.stdout(`NO READ ${navUnreadText(result)}\n`);
  io.stdout(`site-pages nav: ${result.pages.length} ${result.pages.length === 1 ? "page" : "pages"}, ${result.problems.length} ${result.problems.length === 1 ? "problem" : "problems"}, ${result.unread.length} ${result.unread.length === 1 ? "page" : "pages"} not read.\n`);
  const step = io.env["GITHUB_STEP_SUMMARY"];
  if (step) appendFileSync(step, navSummary(result));
  return result.ok ? 0 : 1;
}
