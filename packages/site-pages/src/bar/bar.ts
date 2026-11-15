/**
 * The shared site bar (`site-pages bar`). The Pages workflow writes one bar into each built HTML page of a site.
 * Thus each page of each site has the same way to each other page, and no site writes its own bar.
 *
 * The bar has the portfolio of the owner and the name of the site. It also has a link to each page of the site, to
 * GitHub and to npm. The link of the current page has `aria-current="page"`. The bar works at 360 px: its rows wrap.
 * Its CSS has its own class names and variables, so the CSS of a site does not change it.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { escapeHtml, safeUrl } from "../render/html.ts";

/** One link of the bar to a page of the site. */
export interface BarPage {
  readonly label: string;
  /** The path from the site home, for example `docs/`. The home is an empty text. */
  readonly path: string;
}

/** The content of the bar. */
export interface BarOptions {
  /** "owner/name" of the repository on GitHub. */
  readonly repository: string;
  /** The path of the site home, with a `/` at the start and at the end. */
  readonly base: string;
  /** The name of the site. The default is the name of the repository. */
  readonly siteName?: string | undefined;
  /** The pages of the site, after the home and before Releases and Status. */
  readonly pages: readonly BarPage[];
  /** True when the site has the Releases page and the Status page of site-pages. */
  readonly sitePages: boolean;
  /** The npm name of the package of the site, or undefined for no npm link. */
  readonly npm?: string | undefined;
  /** The URL of the portfolio of the owner, or undefined for no portfolio link. */
  readonly portfolio?: string | undefined;
}

/** The marker attribute of the bar. The navigation crawl looks for it. */
export const BAR_ATTRIBUTE = "data-site-bar";

/** The CSS of the bar. Each rule starts with `.spb`, so it changes only the bar. */
export const BAR_CSS = `
.spb{--spb-bg:#ffffff;--spb-fg:#151c2e;--spb-muted:#5f6880;--spb-rule:#d6dbe5;--spb-accent:#2346c4;--spb-wash:#e7ecfd;
color-scheme:light;position:relative;z-index:2147483000;display:block;margin:0;padding:0;background:var(--spb-bg);color:var(--spb-fg);
border-bottom:1px solid var(--spb-rule);font:400 14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
text-align:left;letter-spacing:normal;text-transform:none}
@media (prefers-color-scheme:dark){.spb{--spb-bg:#151a2b;--spb-fg:#e6e9f3;--spb-muted:#a3abc2;--spb-rule:#2b3350;--spb-accent:#93abff;--spb-wash:#1f2a4f;color-scheme:dark}}
:root[data-theme="dark"] .spb,:root.dark .spb{--spb-bg:#151a2b;--spb-fg:#e6e9f3;--spb-muted:#a3abc2;--spb-rule:#2b3350;--spb-accent:#93abff;--spb-wash:#1f2a4f;color-scheme:dark}
:root[data-theme="light"] .spb,:root.light .spb{--spb-bg:#ffffff;--spb-fg:#151c2e;--spb-muted:#5f6880;--spb-rule:#d6dbe5;--spb-accent:#2346c4;--spb-wash:#e7ecfd;color-scheme:light}
.spb *{box-sizing:border-box;margin:0;padding:0;font:inherit;letter-spacing:inherit}
.spb-in{max-width:80rem;margin:0 auto;padding:6px 12px;display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px}
.spb-id{display:flex;align-items:center;gap:6px;min-width:0;margin-right:auto}
.spb-id a{color:var(--spb-fg);text-decoration:none;border-radius:4px;overflow-wrap:anywhere}
.spb-owner{color:var(--spb-muted)!important}
.spb-site{font-weight:700}
.spb-id a:hover,.spb-links a:hover{text-decoration:underline;text-underline-offset:3px}
.spb-sep{color:var(--spb-muted)}
.spb-links{display:flex;flex-wrap:wrap;align-items:center;gap:2px;list-style:none}
.spb-links a{display:inline-block;padding:4px 8px;min-height:32px;line-height:24px;border-radius:6px;color:var(--spb-accent);text-decoration:none;white-space:nowrap}
.spb-links a[aria-current="page"]{background:var(--spb-wash);color:var(--spb-fg);font-weight:600}
.spb-out{color:var(--spb-muted)!important}
.spb a:focus-visible{outline:2px solid var(--spb-accent);outline-offset:1px}
@media print{.spb{display:none}}
`;

/** This function gives the path of a page from the site home, with no `index.html`. The home is an empty text. */
export function pagePath(file: string): string {
  return file.split(sep).join("/").replace(/(^|\/)index\.html$/, "$1");
}

/**
 * This function gives the link of the bar that is the current page: the link with the longest path that starts the
 * page path. The home link is current only on the home page.
 */
export function currentLink(links: readonly BarPage[], path: string): BarPage | undefined {
  let best: BarPage | undefined;
  for (const entry of links) {
    const match = entry.path === "" ? path === "" : path === entry.path || (entry.path.endsWith("/") && path.startsWith(entry.path));
    if (match && (best === undefined || entry.path.length > best.path.length)) best = entry;
  }
  return best;
}

/** This function gives the links of the bar to the pages of the site, in order: the home, the pages, Releases and Status. */
export function barPages(options: BarOptions): BarPage[] {
  const pages: BarPage[] = [{ label: "Home", path: "" }, ...options.pages.filter((entry) => entry.path !== "")];
  if (options.sitePages) pages.push({ label: "Releases", path: "releases/" }, { label: "Status", path: "status/" });
  const seen = new Set<string>();
  return pages.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
}

/** This function gives the HTML of the bar for the page at `path`. */
export function barHtml(options: BarOptions, path: string): string {
  const [owner = "", name = ""] = options.repository.split("/");
  const href = (page: string) => escapeHtml(`${options.base}${page}`);
  const pages = barPages(options);
  const current = currentLink(pages, path);
  const portfolio = options.portfolio === undefined ? undefined : safeUrl(options.portfolio);
  const id = [
    portfolio ? `<a class="spb-owner" href="${escapeHtml(portfolio)}">${escapeHtml(owner)}</a><span class="spb-sep" aria-hidden="true">/</span>` : "",
    `<a class="spb-site" href="${href("")}">${escapeHtml(options.siteName ?? name)}</a>`,
  ].join("");
  const links = pages.map((entry) => {
    const mark = entry === current ? ' aria-current="page"' : "";
    return `<li><a href="${href(entry.path)}" target="_self"${mark}>${escapeHtml(entry.label)}</a></li>`;
  });
  links.push(`<li><a class="spb-out" href="https://github.com/${escapeHtml(options.repository)}">GitHub</a></li>`);
  if (options.npm) links.push(`<li><a class="spb-out" href="https://www.npmjs.com/package/${escapeHtml(options.npm)}">npm</a></li>`);
  return `<nav class="spb" ${BAR_ATTRIBUTE} aria-label="Site"><div class="spb-in"><div class="spb-id">${id}</div><ul class="spb-links">${links.join("")}</ul></div></nav>`;
}

const BAR_PATTERN = /\n?<nav class="spb" data-site-bar[\s\S]*?<\/ul><\/div><\/nav>/;
const STYLE_ID = "site-bar-css";
const STYLE_PATTERN = /<style id="site-bar-css">[\s\S]*?<\/style>/;
// The header of the Releases page and the Status page of site-pages. The bar takes its place.
const SP_HEADER_PATTERN = /<header class="sp-header">[\s\S]*?<\/header>\n?/;

/**
 * This function writes the bar into the HTML of one page. The bar comes first in `<body>`, and its CSS comes last in
 * `<head>`. A bar from an earlier start goes away, so the function can start two times on one page. The header of a
 * page of site-pages also goes away. The function gives the HTML with no change when the page has no `<body>`.
 */
export function injectBar(html: string, bar: string): string {
  const body = /<body\b[^>]*>/i.exec(html);
  if (body === null) return html;
  let out = html.replace(STYLE_PATTERN, "").replace(BAR_PATTERN, "").replace(SP_HEADER_PATTERN, "");
  const style = `<style id="${STYLE_ID}">${BAR_CSS}</style>`;
  out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${style}</head>`) : out.replace(/<body\b[^>]*>/i, (tag) => `${style}${tag}`);
  return out.replace(/<body\b[^>]*>/i, (tag) => `${tag}\n${bar}`);
}

/** This function gives the HTML files of a folder, as paths from the folder, in a stable order. */
export function htmlFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".html")) files.push(relative(root, full));
    }
  };
  walk(root);
  return files;
}

/** This function writes the bar into each HTML page of the built site folder, and gives the number of pages. */
export function applyBar(out: string, options: BarOptions): number {
  const files = htmlFiles(out);
  for (const file of files) {
    const full = join(out, file);
    const html = readFileSync(full, "utf8");
    const next = injectBar(html, barHtml(options, pagePath(file)));
    if (next !== html) writeFileSync(full, next);
  }
  return files.length;
}

/** The input and output of the CLI. */
export interface BarIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const BAR_HELP = `Usage: site-pages bar --out <dir> [options]

Writes the shared site bar into each HTML page of the built site folder. The bar comes first in the
body of the page. It has the portfolio of the owner, the name of the site, a link to each page of
the site, GitHub and npm. The bar takes the place of the header of the pages of site-pages.

Options:
  --out <dir>          The built site folder
  --repo <owner/name>  The GitHub repository (default: $GITHUB_REPOSITORY)
  --base </name/>      The path of the site home (default: "/<name>/", or "/" for <owner>.github.io)
  --site-name <name>   The name of the site in the bar (default: the name of the repository)
  --pages <list>       The pages of the site after the home, as label=path pairs separated by
                       commas, for example "Demo=demo/,Docs=docs/"
  --site-pages         Adds the links to releases/ and status/
  --npm <name>         The npm name of the package, for the npm link
  --portfolio <url>    The portfolio of the owner (default: https://<owner>.github.io/, and no
                       portfolio link on the site <owner>.github.io)
  --help               Shows this text
`;

/** This function parses the value of `--pages`. It gives an Error for a pair with no label or no path. */
export function parsePages(text: string): BarPage[] | Error {
  const pages: BarPage[] = [];
  for (const pair of text.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const at = pair.indexOf("=");
    const label = at < 0 ? "" : pair.slice(0, at).trim();
    const path = at < 0 ? "" : pair.slice(at + 1).trim().replace(/^\/+/, "");
    if (label === "" || path === "" || path.includes(":") || path.includes("\\")) return new Error(`"${pair}" is not a pair of a label and a path from the site home, for example Docs=docs/`);
    pages.push({ label, path });
  }
  return pages;
}

/** This function starts the `bar` command with its arguments, without the word `bar`. */
export function runBarCli(argv: readonly string[], io: BarIo): number {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        out: { type: "string" },
        repo: { type: "string" },
        base: { type: "string" },
        "site-name": { type: "string" },
        pages: { type: "string" },
        "site-pages": { type: "boolean" },
        npm: { type: "string" },
        portfolio: { type: "string" },
        help: { type: "boolean" },
      },
    }));
  } catch (error) {
    io.stderr(`site-pages bar: ${error instanceof Error ? error.message : String(error)}\n\n${BAR_HELP}`);
    return 2;
  }
  if (values["help"]) {
    io.stdout(BAR_HELP);
    return 0;
  }
  const usage = (message: string) => {
    io.stderr(`site-pages bar: ${message}\n\n${BAR_HELP}`);
    return 2;
  };
  const text = (key: string) => (typeof values[key] === "string" && values[key] !== "" ? (values[key] as string) : undefined);
  const out = text("out");
  if (out === undefined) return usage("give --out");
  const repository = text("repo") ?? io.env["GITHUB_REPOSITORY"] ?? "";
  const [owner = "", name = ""] = repository.split("/");
  if (owner === "" || name === "") return usage("give --repo <owner/name> or set GITHUB_REPOSITORY");
  const ownerSite = name.toLowerCase() === `${owner.toLowerCase()}.github.io`;
  const rawBase = text("base") ?? (ownerSite ? "/" : `/${name}/`);
  const base = `/${rawBase.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
  const pages = parsePages(text("pages") ?? "");
  if (pages instanceof Error) return usage(pages.message);
  const portfolio = text("portfolio") ?? (ownerSite ? undefined : `https://${owner.toLowerCase()}.github.io/`);
  const options: BarOptions = { repository, base, siteName: text("site-name"), pages, sitePages: values["site-pages"] === true, npm: text("npm"), portfolio };
  const folder = isAbsolute(out) ? out : resolve(io.cwd, out);
  const count = applyBar(folder, options);
  if (count === 0) {
    io.stderr(`site-pages bar: ${out} has no HTML page\n`);
    return 1;
  }
  io.stdout(`site-pages bar: the bar is in ${count} pages, with ${barPages(options).map((entry) => entry.label).join(", ")}.\n`);
  return 0;
}
