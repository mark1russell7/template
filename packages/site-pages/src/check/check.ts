/**
 * The `site-pages check` command. It opens the pages of a built site (or of a live URL) in a
 * headless Chromium at phone and desktop widths, in the light and the dark scheme.
 *
 * A view fails when the page is wider than the screen or an element goes past the right edge. It
 * also fails when a text area hides its text, a box cuts text (`cutProblems`) or the page shows no text. A console error, an
 * exception and a failed request of the site also fail it. A script that does not load and a failed check of the probe
 * fail it too. The command
 * writes a screenshot of each view.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { findBrowser, launch, NoReplyError, type Browser, type Page } from "./browser.ts";
import { MEASURE, probeExpression, type Cut, type Measure, type ProbeCheck } from "./measure.ts";
import { probeScript, TYPESCRIPT_PROBE } from "./probe.ts";
import { serve } from "./serve.ts";

/** A view narrower than this width in CSS pixels is a phone. */
export const PHONE_WIDTH = 768;

/** The options of `checkSite`. */
export interface CheckOptions {
  /** The built site folder. Give `out` or `url`. */
  out?: string | undefined;
  /** The path of the site home, for `out`, for example `/client/`. */
  base?: string | undefined;
  /** The URL of a live site home. Give `out` or `url`. */
  url?: string | undefined;
  /** The pages, from the site home, for example `/` and `/releases/`. */
  pages: readonly string[];
  /** The widths in CSS pixels. A width under `PHONE_WIDTH` is a phone. */
  widths: readonly number[];
  /** The color schemes. */
  schemes: readonly ("light" | "dark")[];
  /** The code of a probe: the body of an async function (see `probeExpression`). It runs on the first page, in the light scheme, at each width. */
  probe?: string | undefined;
  /**
   * The probe of each page: a map from a page of `pages` to the code of its probe. Each probe operates on its page, in the first
   * scheme, at each width. A page with no entry has no probe. The first page takes `probe` or an entry of this map, not both.
   */
  probes?: Readonly<Record<string, string>> | undefined;
  /** The folder for the screenshots, `report.json` and `summary.md`. */
  shots?: string | undefined;
  /** The browser executable. */
  browser?: string | undefined;
  /** The time to wait after the load event, for the scripts of the page. */
  settleMs: number;
  /** The time limit of a page load. */
  timeoutMs: number;
  /** The time limit of one call of the browser. The default is `CALL_LIMIT_MS`. After a call with no reply, the next view gets a new browser. */
  callMs?: number | undefined;
  /** The time limit of the scroll and of the islands of a view, for `revealExpression`. The default is `ISLAND_LIMIT_MS`. */
  islandMs?: number | undefined;
  log?: ((line: string) => void) | undefined;
}

/** The default time limit of the scroll and of the islands of a view, in milliseconds. */
export const ISLAND_LIMIT_MS = 10_000;

/**
 * This function gives a page expression that scrolls the page to its end, one screen at a time, and then back to the top.
 * Thus each part that starts when it comes into view starts before the measure. Examples are an Astro island with
 * `client:visible` and an image with `loading="lazy"`. Then the expression waits until no Astro island waits to start.
 * An island that the page does not show and an island of a media query that does not match do not count.
 * The expression gives the islands that did not start in `limitMs`.
 */
export function revealExpression(limitMs: number): string {
  return `(async () => {
  const end = performance.now() + ${String(limitMs)};
  const frame = () => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)));
  const root = document.scrollingElement ?? document.documentElement;
  const step = Math.max(Math.round(innerHeight * 0.8), 100);
  for (let top = 0; top < root.scrollHeight && performance.now() < end; top += step) {
    scrollTo({ top, behavior: "instant" });
    await frame();
    await frame();
  }
  scrollTo({ top: root.scrollHeight, behavior: "instant" });
  await frame();
  const waiting = () => [...document.querySelectorAll("astro-island[ssr]")].filter((island) => {
    const client = island.getAttribute("client") ?? "";
    if (client === "media") {
      try {
        const query = JSON.parse(island.getAttribute("opts") ?? "{}").value;
        if (typeof query === "string" && !matchMedia(query).matches) return false;
      } catch {}
    }
    if (client === "visible" && ![...island.children].some((child) => child.getClientRects().length > 0)) return false;
    return true;
  });
  while (waiting().length > 0 && performance.now() < end) await new Promise((done) => setTimeout(done, 50));
  scrollTo({ top: 0, behavior: "instant" });
  await frame();
  await frame();
  return waiting().map((island) => (island.getAttribute("component-url") ?? "").split("/").pop() + " (client:" + (island.getAttribute("client") ?? "") + ")");
})()`;
}

/** The result of one page at one width and scheme. */
export interface ViewResult {
  page: string;
  width: number;
  scheme: "light" | "dark";
  ok: boolean;
  /** What failed. */
  problems: string[];
  measure?: Measure | undefined;
  probe?: ProbeCheck[] | undefined;
  /** The file of the screenshot. */
  shot?: string | undefined;
}

/** The result of `checkSite`. */
export interface CheckResult {
  ok: boolean;
  url: string;
  browser: string;
  views: ViewResult[];
}

/**
 * This function gives the problems of the cuts of a view with the given width. A box that clips text is a problem at each width.
 * A table or a code block in a box that scrolls is a problem only on a phone. A phone shows no scroll bar, but a desktop shows one.
 * The summary and the log give the page of each problem.
 */
export function cutProblems(cuts: readonly Cut[], width: number): string[] {
  const widths = (cut: Cut) => `${cut.element} in ${cut.box}: content of ${cut.scrollWidth} px in a box of ${cut.clientWidth} px, "${cut.text}"`;
  return cuts.flatMap((cut) => {
    if (cut.kind === "clip") return [`a box cuts text at ${width} px: ${widths(cut)}. Make the content fit, or add data-overflow-ok to the box.`];
    const what = cut.kind === "code" ? "a code block" : "a table";
    if (cut.deadCue === true) return width < PHONE_WIDTH ? [`${what} goes out of view at ${width} px: ${widths(cut)}. The box has the class scroll-cue, but its computed style has no animation and no shade. Read the served CSS.`] : [];
    if (width < PHONE_WIDTH) return [`${what} goes out of view at ${width} px: ${widths(cut)}. Make ${cut.kind === "code" ? "the lines" : "the table"} fit, give the box the class scroll-cue, or add data-overflow-ok to the box.`];
    return [];
  });
}

/** This function gives the file name part of a page: `/` is `home`, `/releases/` is `releases`. */
export function pageSlug(page: string): string {
  const slug = page.replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9._-]+/g, "_");
  return slug === "" ? "home" : slug;
}

/**
 * This function gives the code of the probe of each page of `pages`, in the same order. A page with no probe gives undefined.
 * `probe` goes to the first page, and each entry of `probes` goes to its page.
 *
 * @throws Error when a key of `probes` is not a page, or when the first page has `probe` and an entry of `probes`
 */
export function pageProbes(options: Pick<CheckOptions, "pages" | "probe" | "probes">): (string | undefined)[] {
  const probes = options.probes ?? {};
  const unknown = Object.keys(probes).filter((page) => !options.pages.includes(page));
  if (unknown.length > 0) throw new Error(`a probe names a page that the check does not open: ${unknown.join(", ")}. The pages are ${options.pages.join(", ")}.`);
  const first = options.pages[0];
  if (options.probe !== undefined && first !== undefined && Object.hasOwn(probes, first)) throw new Error(`the first page ${first} has two probes: give it probe or an entry of probes, not both`);
  return options.pages.map((page, index) => (Object.hasOwn(probes, page) ? probes[page] : index === 0 ? options.probe : undefined));
}

/**
 * This function checks the site. It starts one browser and, for `out`, one server, and stops both at
 * the end.
 *
 * @throws Error when there is no browser, or the browser does not start
 */
export async function checkSite(options: CheckOptions): Promise<CheckResult> {
  const log = options.log ?? (() => {});
  const executable = findBrowser(options.browser);
  if (executable === undefined) throw new Error("no Chromium browser was found: give --browser, set SITE_CHECK_BROWSER, or install the Chromium of Playwright");
  if (options.pages.length === 0) throw new Error("no page to check");
  const probes = pageProbes(options);
  if (options.out === undefined && options.url === undefined) throw new Error("give out or url");
  const server = options.out !== undefined ? await serve(options.out, options.base ?? "/") : undefined;
  const views: ViewResult[] = [];
  let homeUrl: URL;
  let browser: Browser | undefined;
  // The server stops also when the browser does not start. An open server keeps the process alive, and the check does not end.
  try {
    const home = server?.url ?? options.url ?? "";
    homeUrl = new URL(home.endsWith("/") ? home : `${home}/`);
    const origin = homeUrl.origin;
    const start = async (): Promise<{ page: Page; events: Events }> => {
      browser = await launch(executable, options.timeoutMs, options.callMs);
      const { page } = browser;
      const events = watch(page, origin);
      await Promise.all([page.send("Page.enable"), page.send("Runtime.enable"), page.send("Network.enable")]);
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: LOAD_WATCH });
      return { page, events };
    };
    let { page, events } = await start();
    if (options.shots) mkdirSync(options.shots, { recursive: true });
    for (const [index, path] of options.pages.entries()) {
      const target = new URL(path.replace(/^\/+/, ""), homeUrl).href;
      for (const width of options.widths) {
        for (const scheme of options.schemes) {
          const probe = scheme === options.schemes[0] ? probes[index] : undefined;
          const { view, hung } = await checkView(page, events, { target, path, width, scheme, probe, options });
          views.push(view);
          // A page that does not answer can hold the browser. The next view gets a new browser, so one hung view fails alone.
          if (hung) {
            log(`the browser did not answer at ${path} ${width} ${scheme}: the check starts a new browser`);
            await browser?.close();
            browser = undefined;
            ({ page, events } = await start());
          }
          log(`${view.ok ? "PASS" : "FAIL"} ${path} ${width} ${scheme}${view.measure ? ` scrollWidth=${view.measure.scrollWidth} innerWidth=${view.measure.innerWidth}` : ""}${view.probe ? ` probe ${view.probe.filter((c) => c.ok).length}/${view.probe.length}` : ""}${view.problems.length > 0 ? `\n  - ${view.problems.join("\n  - ")}` : ""}`);
        }
      }
    }
  } finally {
    await browser?.close();
    await server?.close();
  }
  const result: CheckResult = { ok: views.length > 0 && views.every((view) => view.ok), url: homeUrl.href, browser: executable, views };
  if (options.shots) {
    writeFileSync(join(options.shots, "report.json"), `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(join(options.shots, "summary.md"), summary(result));
  }
  return result;
}

/**
 * A script that each page starts before its own scripts. A script or a style sheet that does not load fires `error` on its
 * element. This script writes that event as a console error. Thus a module script whose imports do not load is a problem too.
 * Such a script throws no exception. Its failed request can go to another origin, for example `node:perf_hooks` in a page bundle.
 */
export const LOAD_WATCH = `addEventListener("error", (event) => {
  const element = event.target;
  if (!(element instanceof HTMLScriptElement || element instanceof HTMLLinkElement)) return;
  console.error("failed to load " + element.tagName.toLowerCase() + ": " + (element.getAttribute("src") ?? element.getAttribute("href") ?? "(inline)"));
}, true);`;

/** This expression reads the pattern of the paths that other sites of the origin serve. An empty text means no pattern. */
const OTHER_PATHS = `document.querySelector('meta[name="site-check-other-paths"]')?.content ?? ""`;

/** The problems that the events of the page gave, since the last `reset`. */
interface Events {
  reset(): void;
  /** This function gives the problems. A refused request to a path that `other` matches is not a problem. */
  problems(other?: RegExp): string[];
}

function watch(page: Page, origin: string): Events {
  let problems: string[] = [];
  let refused: { url: string; status: number }[] = [];
  const urls = new Map<string, string>();
  const own = (url: string) => {
    try {
      const parsed = new URL(url);
      // A browser asks for /favicon.ico on its own, also for a site under a path.
      return parsed.origin === origin && parsed.pathname !== "/favicon.ico";
    } catch {
      return false;
    }
  };
  page.on("Runtime.exceptionThrown", (params) => {
    const details = params["exceptionDetails"] as { text?: string; exception?: { description?: string } };
    problems.push(`exception: ${(details.exception?.description ?? details.text ?? "").split("\n")[0]}`);
  });
  page.on("Runtime.consoleAPICalled", (params) => {
    if (params["type"] !== "error" && params["type"] !== "assert") return;
    const args = (params["args"] as { value?: unknown; description?: string }[]) ?? [];
    problems.push(`console.error: ${args.map((arg) => String(arg.value ?? arg.description ?? "")).join(" ").slice(0, 300)}`);
  });
  page.on("Network.requestWillBeSent", (params) => {
    urls.set(String(params["requestId"]), String((params["request"] as { url: string }).url));
  });
  page.on("Network.responseReceived", (params) => {
    const response = params["response"] as { url: string; status: number };
    if (response.status >= 400 && own(response.url)) refused.push(response);
  });
  page.on("Network.loadingFailed", (params) => {
    const url = urls.get(String(params["requestId"])) ?? "";
    // A script of any origin counts: without it, the page does not work.
    if ((own(url) || params["type"] === "Script") && params["canceled"] !== true) problems.push(`request failed (${String(params["errorText"])}): ${url}`);
  });
  return {
    reset: () => {
      problems = [];
      refused = [];
    },
    problems: (other) => {
      const shown = refused.filter((response) => other?.test(new URL(response.url).pathname) !== true);
      return [...new Set([...problems, ...shown.map((response) => `HTTP ${response.status}: ${response.url}`)])];
    },
  };
}

interface ViewInput {
  target: string;
  path: string;
  width: number;
  scheme: "light" | "dark";
  /** The code of the probe of this view, or undefined for no probe. */
  probe: string | undefined;
  options: CheckOptions;
}

async function checkView(page: Page, events: Events, input: ViewInput): Promise<{ view: ViewResult; hung: boolean }> {
  const { target, path, width, scheme, probe, options } = input;
  const view: ViewResult = { page: path, width, scheme, ok: false, problems: [] };
  let other: RegExp | undefined;
  let hung = false;
  try {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < PHONE_WIDTH });
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    events.reset();
    const loaded = page.once("Page.loadEventFired", options.timeoutMs);
    const navigation = (await page.send("Page.navigate", { url: target })) as { errorText?: string };
    if (navigation.errorText) {
      loaded.catch(() => {});
      throw new Error(`the page did not open: ${navigation.errorText}`);
    }
    await loaded;
    await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
    await new Promise((done) => setTimeout(done, options.settleMs));
    const islandMs = options.islandMs ?? ISLAND_LIMIT_MS;
    const stuck = await page.evaluate<string[]>(revealExpression(islandMs));
    for (const island of stuck) view.problems.push(`an island did not start in ${String(islandMs)} ms after a scroll to the end: ${island}`);
    const pattern = await page.evaluate<string>(OTHER_PATHS);
    if (pattern !== "") other = new RegExp(pattern);
    const measure = await page.evaluate<Measure>(MEASURE);
    view.measure = measure;
    // The screen width, not innerWidth: a phone browser can zoom out a page that is too wide.
    if (measure.scrollWidth > width) view.problems.push(`the page is wider than the screen: ${measure.scrollWidth} > ${width}`);
    for (const past of measure.past) view.problems.push(`past the right edge: ${past}`);
    for (const clipped of measure.clipped) view.problems.push(`a text area hides its text: ${clipped}`);
    view.problems.push(...cutProblems(measure.cut, width));
    if (measure.text === 0) view.problems.push("the page shows no text");
    if (options.shots) {
      const file = join(options.shots, `${pageSlug(path)}-${width}-${scheme}.png`);
      const height = Math.min(Math.max(measure.height, 1), 8000);
      const shot = (await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } })) as { data: string };
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      view.shot = file;
    }
    if (probe !== undefined) {
      const checks = (await page.evaluate<ProbeCheck[] | undefined>(probeExpression(probe))) ?? [];
      view.probe = checks;
      if (checks.length === 0) view.problems.push("the probe made no check");
      for (const check of checks.filter((entry) => !entry.ok)) view.problems.push(`probe: ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
    }
  } catch (error) {
    hung = error instanceof NoReplyError;
    view.problems.push(error instanceof Error ? error.message : String(error));
  }
  view.problems.push(...events.problems(other));
  view.ok = view.problems.length === 0;
  return { view, hung };
}

/** This function makes a text safe for a cell of a Markdown table. It escapes `\`, `|`, `<` and `>`. It changes each new line to a space. */
export function cell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, " ");
}

/** This function gives the Markdown summary of a result, for the job summary of a workflow. */
export function summary(result: CheckResult): string {
  const failed = result.views.filter((view) => !view.ok);
  const lines = [
    `### Site check: ${result.ok ? "passed" : "failed"}`,
    "",
    `${result.views.length - failed.length} of ${result.views.length} views passed, at ${result.url}.`,
    "",
    "| Page | Width | Scheme | Result | Problems |",
    "| --- | ---: | --- | --- | --- |",
    ...result.views.map(
      (view) =>
        `| \`${view.page}\` | ${view.width} | ${view.scheme} | ${view.ok ? "pass" : "**fail**"}${view.probe ? ` (probe ${view.probe.filter((c) => c.ok).length}/${view.probe.length})` : ""} | ${view.problems.map(cell).join("<br>")} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

/** The input and output of the CLI. */
export interface CheckIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const CHECK_HELP = `Usage: site-pages check (--out <dir> | --url <url>) [options]

Opens the pages of the site in a headless Chromium at phone and desktop widths, in the light and
the dark scheme, and fails when a page is wider than the screen, an element goes past the right
edge, a text area hides its text, a box cuts text, a table goes out of view on a phone, a page
shows no text, or on a console error, an exception, a failed request of the site, a script that
does not load or a failed check of the probe. Add data-overflow-ok to a box that is meant to
scroll or to clip.

Options:
  --out <dir>          The built site folder. The check serves it at --base.
  --url <url>          The URL of a live site home, in place of --out
  --repo <owner/name>  The GitHub repository, for the default base (default: $GITHUB_REPOSITORY)
  --base </name/>      The path of the site home (default: "/<name>/", or "/" for <owner>.github.io)
  --pages <paths>      The pages, from the site home, separated by commas (default: /)
  --widths <px>        The widths, separated by commas (default: 360,400,1280)
  --schemes <list>     light, dark or both (default: light,dark)
  --probe <file>       A JavaScript file: the body of an async function with check(name, ok, detail),
                       wait, until, $, $$, type and click. It runs on the first page, in the first
                       scheme, at each width. A .ts, .mts or .cts file is TypeScript: the check
                       removes its types and its line export {}.
  --page-probe <page>=<file>
                       The probe of one page of --pages, for example /structures/=probe.ts. Give
                       the option one time for each page. A page with no probe has none. The
                       first page takes --probe or --page-probe, not both.
  --shots <dir>        The folder for the screenshots, report.json and summary.md
  --browser <file>     The Chromium executable (default: $SITE_CHECK_BROWSER, the Chromium of
                       Playwright, else Chrome or Edge)
  --settle <ms>        The wait after the load event (default: 1500)
  --timeout <ms>       The time limit of a page load (default: 30000)
  --help               Shows this text

With $GITHUB_STEP_SUMMARY, the check adds its table to the job summary.
`;

/** This function runs the `check` command with its arguments, without the word `check`. */
export async function runCheckCli(argv: readonly string[], io: CheckIo): Promise<number> {
  let values: Record<string, string | boolean | string[] | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        out: { type: "string" },
        url: { type: "string" },
        repo: { type: "string" },
        base: { type: "string" },
        pages: { type: "string" },
        widths: { type: "string" },
        schemes: { type: "string" },
        probe: { type: "string" },
        "page-probe": { type: "string", multiple: true },
        shots: { type: "string" },
        browser: { type: "string" },
        settle: { type: "string" },
        timeout: { type: "string" },
        help: { type: "boolean" },
      },
    }));
  } catch (error) {
    io.stderr(`site-pages check: ${error instanceof Error ? error.message : String(error)}\n\n${CHECK_HELP}`);
    return 2;
  }
  if (values["help"]) {
    io.stdout(CHECK_HELP);
    return 0;
  }
  const usage = (message: string) => {
    io.stderr(`site-pages check: ${message}\n\n${CHECK_HELP}`);
    return 2;
  };
  const text = (key: string) => (typeof values[key] === "string" ? (values[key] as string) : undefined);
  const list = (key: string, fallback: string) => (text(key) ?? fallback).split(",").map((entry) => entry.trim()).filter(Boolean);
  const out = text("out");
  const url = text("url");
  if ((out === undefined) === (url === undefined)) return usage("give --out or --url, not both");
  const widths = list("widths", "360,400,1280").map(Number);
  if (widths.length === 0 || widths.some((width) => !Number.isInteger(width) || width < 200 || width > 4000)) return usage("--widths must be whole numbers from 200 to 4000");
  const schemes = list("schemes", "light,dark");
  if (schemes.length === 0 || schemes.some((scheme) => scheme !== "light" && scheme !== "dark")) return usage("--schemes must be light, dark or both");
  const pages = list("pages", "/");
  if (pages.length === 0) return usage("--pages has no page");
  // Git Bash changes a bare "/" into "C:/Program Files/Git/". A page is a path, with no scheme or drive.
  const notPath = pages.find((entry) => entry.includes(":") || entry.includes("\\"));
  if (notPath !== undefined) return usage(`a page is a path from the site home, not "${notPath}" (in Git Bash, set MSYS_NO_PATHCONV=1)`);
  const settleMs = Number(text("settle") ?? 1500);
  const timeoutMs = Number(text("timeout") ?? 30000);
  if (!(settleMs >= 0) || !(timeoutMs > 0)) return usage("--settle and --timeout must be numbers of milliseconds");
  let base = text("base");
  if (out !== undefined && base === undefined) {
    const name = (text("repo") ?? io.env["GITHUB_REPOSITORY"] ?? "").split("/")[1];
    if (!name) return usage("give --base, --repo or set GITHUB_REPOSITORY");
    base = /\.github\.io$/i.test(name) ? "/" : `/${name}/`;
  }
  if (base !== undefined) base = `/${base.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
  const at = (file: string) => (isAbsolute(file) ? file : resolve(io.cwd, file));
  /** This function reads a probe file. A TypeScript file loses its types. A file that cannot be read gives an Error. */
  const readProbe = (file: string): string | Error => {
    let code: string;
    try {
      code = readFileSync(at(file), "utf8");
    } catch (error) {
      return new Error(`the probe file ${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!TYPESCRIPT_PROBE.test(file)) return code;
    try {
      return probeScript(code);
    } catch (error) {
      return new Error(`the types of the probe file ${file} cannot be removed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const probeFile = text("probe");
  let probe: string | undefined;
  if (probeFile !== undefined) {
    const code = readProbe(probeFile);
    if (code instanceof Error) return usage(code.message);
    probe = code;
  }
  const probes: Record<string, string> = {};
  for (const entry of (values["page-probe"] as string[] | undefined) ?? []) {
    const split = entry.indexOf("=");
    const page = entry.slice(0, split).trim();
    const file = entry.slice(split + 1).trim();
    if (split <= 0 || file === "") return usage(`--page-probe must be <page>=<file>, not "${entry}"`);
    if (Object.hasOwn(probes, page)) return usage(`--page-probe gives two probes for the page ${page}`);
    const code = readProbe(file);
    if (code instanceof Error) return usage(code.message);
    probes[page] = code;
  }
  try {
    pageProbes({ pages, probe, probes });
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  const shots = text("shots");
  const result = await checkSite({
    out: out === undefined ? undefined : at(out),
    base,
    url,
    pages,
    widths,
    schemes: schemes as ("light" | "dark")[],
    probe,
    probes,
    shots: shots === undefined ? undefined : at(shots),
    browser: text("browser"),
    settleMs,
    timeoutMs,
    log: (line) => io.stdout(`${line}\n`),
  });
  const failed = result.views.filter((view) => !view.ok).length;
  io.stdout(`site-pages check: ${result.views.length - failed} of ${result.views.length} views passed (${result.browser}).\n`);
  const step = io.env["GITHUB_STEP_SUMMARY"];
  if (step) appendFileSync(step, summary(result));
  return result.ok ? 0 : 1;
}
