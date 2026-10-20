/**
 * The page shell and the CSS of the standalone pages. The CSS uses variables (`--sp-bg`, `--sp-fg`,
 * `--sp-accent` and the others), so a site can change the colors and the fonts with `extraCss`.
 */

import { longDate } from "./dates.ts";
import { escapeHtml, link } from "./html.ts";

/** The options of each page. */
export interface PageOptions {
  /** "owner/name" of the repository on GitHub. */
  repository: string;
  /** The path of the site home, with a `/` at the start and at the end, for example `/client/`. */
  base: string;
  /** The name of the site in the header. The default is the name of the repository. */
  siteName?: string | undefined;
  /** More CSS for the page. It comes after the default CSS, so it can change each variable. */
  extraCss?: string | undefined;
  /** The ISO time of the build. */
  generatedAt: string;
  /** The commit of the build, or null. */
  commit: string | null;
}

// The dark colors: for [data-theme="dark"], and for the dark system theme without [data-theme="light"]
const DARK = `color-scheme:dark;--sp-bg:#0e1220;--sp-surface:#151a2b;--sp-sunken:#1c2236;--sp-fg:#e6e9f3;--sp-fg-2:#b3bad0;
--sp-muted:#949cb3;--sp-rule:#2b3350;--sp-rule-strong:#46507a;--sp-accent:#93abff;--sp-accent-strong:#bccbff;--sp-accent-wash:#1f2a4f;
--sp-good-ink:#4cc94c;--sp-warn-ink:#fab219;--sp-bad-ink:#ff8a8a;--sp-grid:#232a40;--sp-axis:#5d6683;`;

/** The default CSS of the pages: the variables, the light and dark themes, and the parts of both pages. */
export const BASE_CSS: string = `
:root{color-scheme:light;--sp-bg:#f5f6f9;--sp-surface:#ffffff;--sp-sunken:#eef1f6;--sp-fg:#151c2e;--sp-fg-2:#454f67;
--sp-muted:#5f6880;--sp-rule:#d6dbe5;--sp-rule-strong:#aeb6c7;--sp-accent:#2346c4;--sp-accent-strong:#172f8f;--sp-accent-wash:#e7ecfd;
--sp-good:#0ca30c;--sp-good-ink:#006300;--sp-warn:#fab219;--sp-warn-ink:#7a5200;--sp-bad:#d03b3b;--sp-bad-ink:#a3262a;
--sp-neutral:#8a91a3;--sp-grid:#e6e9f0;--sp-axis:#9aa1b3;
--sp-font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--sp-mono:ui-monospace,"Cascadia Mono","SFMono-Regular",Menlo,Consolas,monospace;--sp-radius:6px;--sp-width:64rem}
:root[data-theme="dark"]{${DARK}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--sp-bg);color:var(--sp-fg);font-family:var(--sp-font);font-size:1rem;line-height:1.55}
a{color:var(--sp-accent);text-underline-offset:2px}
a:hover{color:var(--sp-accent-strong)}
:focus-visible{outline:2px solid var(--sp-accent);outline-offset:2px}
code{font-family:var(--sp-mono);font-size:.9em;background:var(--sp-sunken);border-radius:3px;padding:0 .25em;overflow-wrap:anywhere}
h1{font-size:2rem;line-height:1.2;margin:.5rem 0 .75rem}
h2{font-size:1.35rem;line-height:1.3;margin:0 0 .5rem}
h3{font-size:1.1rem;line-height:1.3}
p{margin:0 0 .75rem}
button{font:inherit;color:inherit}
.sp-skip{position:absolute;left:-9999px;top:0}
.sp-skip:focus{left:16px;top:8px;z-index:10;background:var(--sp-surface);padding:.25rem .5rem}
.sp-header{background:var(--sp-surface);border-bottom:1px solid var(--sp-rule)}
.sp-header nav{max-width:var(--sp-width);margin:0 auto;padding:.6rem 16px;display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem 1.25rem}
.sp-home{margin-right:auto;font-weight:700;color:var(--sp-fg);text-decoration:none;overflow-wrap:anywhere}
.sp-header a[aria-current="page"]{color:var(--sp-fg);font-weight:600;text-decoration:none}
.sp-main{max-width:var(--sp-width);margin:0 auto;padding:16px;min-width:0;overflow-wrap:break-word}
.sp-footer{max-width:var(--sp-width);margin:2rem auto 0;padding:16px;border-top:1px solid var(--sp-rule);color:var(--sp-muted);font-size:.875rem}
.sp-lead{font-size:1.2rem;max-width:70ch}
.sp-small{font-size:.875rem}
.sp-muted{color:var(--sp-muted)}
.sp-panel{background:var(--sp-surface);border:1px solid var(--sp-rule);border-radius:var(--sp-radius);padding:16px;min-width:0}
.sp-pill{display:inline-block;border:1px solid var(--sp-rule-strong);border-radius:999px;padding:0 .5rem;font-size:.8125rem;line-height:1.5;color:var(--sp-fg-2);white-space:nowrap}
.sp-pill.sp-accent{border-color:var(--sp-accent);background:var(--sp-accent-wash);color:var(--sp-accent-strong)}
.sp-pill.sp-good{border-color:var(--sp-good);color:var(--sp-good-ink)}
.sp-pill.sp-strong{border-color:var(--sp-accent-strong);background:var(--sp-accent-strong);color:var(--sp-surface);font-weight:700}
.sp-chip{display:inline-flex;align-items:center;gap:.3rem;background:var(--sp-surface);border:1px solid var(--sp-rule-strong);border-radius:999px;padding:.1rem .7rem;font-size:.875rem;color:var(--sp-fg-2);cursor:pointer}
.sp-chip:hover{border-color:var(--sp-accent)}
.sp-chip[aria-pressed="true"]{background:var(--sp-accent-wash);border-color:var(--sp-tone,var(--sp-accent));box-shadow:inset 0 0 0 1px var(--sp-tone,var(--sp-accent));color:var(--sp-fg)}
.sp-count{font-family:var(--sp-mono);font-size:.8125rem;color:var(--sp-muted)}
.sp-ghost{background:none;border:0;padding:.15rem 0;color:var(--sp-accent);text-decoration:underline;text-underline-offset:2px;cursor:pointer;font-size:.875rem}
.sp-callout{background:var(--sp-sunken);border-left:3px solid var(--sp-rule-strong);border-radius:var(--sp-radius);padding:.6rem .8rem}
.sp-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.sp-section{margin-top:2rem}

/* The releases page */
.sp-legend{display:flex;flex-wrap:wrap;gap:.25rem 1rem;margin:0 0 .5rem;padding:0;list-style:none;color:var(--sp-fg-2);font-size:.875rem}
.sp-legend li{display:inline-flex;align-items:center;gap:.25rem}
.sp-legend svg{flex:none;overflow:visible}
.sp-timeline-box{overflow-x:auto;overflow-y:hidden;max-width:100%;overscroll-behavior-x:contain}
.sp-timeline-box svg{display:block;overflow:visible;max-width:none}
.sp-timeline-wide{display:none}
@media (min-width:1000px){.sp-timeline-narrow{display:none}.sp-timeline-wide{display:block}}
.sp-gap{fill:var(--sp-sunken)}
.sp-grid{stroke:var(--sp-grid);stroke-width:1}
.sp-axis{stroke:var(--sp-axis);stroke-width:1}
.sp-day{fill:var(--sp-fg-2);font-family:var(--sp-font);font-size:12px;font-weight:600}
.sp-day-count{fill:var(--sp-muted);font-family:var(--sp-font);font-size:11px}
.sp-mark{cursor:pointer;outline:none}
.sp-hit{fill:transparent}
.sp-dot{fill:var(--sp-accent);stroke:var(--sp-surface);stroke-width:1.5}
.sp-ring{fill:var(--sp-surface);stroke:var(--sp-accent);stroke-width:2}
.sp-kind-first .sp-dot{fill:var(--sp-good)}
.sp-kind-major .sp-dot{fill:var(--sp-accent-strong)}
.sp-halo{fill:none;stroke:var(--sp-accent);stroke-width:2;pointer-events:none;display:none}
.sp-mark.sp-selected .sp-halo{display:inline}
.sp-label{fill:var(--sp-fg-2);font-family:var(--sp-mono);font-size:12px;paint-order:stroke;stroke:var(--sp-surface);stroke-width:3px;stroke-linejoin:round}
.sp-mark:hover .sp-label,.sp-mark.sp-selected .sp-label{fill:var(--sp-accent-strong)}
.sp-mark.sp-selected .sp-label{font-weight:700}
.sp-mark:focus-visible .sp-hit{stroke:var(--sp-accent);stroke-width:2}
.sp-release{margin:.75rem 0 1rem}
.sp-release-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem .75rem;margin-bottom:.5rem}
.sp-release-head h2{margin:0;font-family:var(--sp-mono);font-size:1.5rem}
.sp-release-links{display:inline-flex;flex-wrap:wrap;gap:.25rem .75rem;margin-left:auto}
.sp-changes{list-style:none;margin:.5rem 0 0;padding:0}
.sp-change{padding:.5rem 0;border-top:1px solid var(--sp-rule);min-width:0}
.sp-change p{margin:0 0 .25rem;overflow-wrap:anywhere}
.sp-change-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .75rem}
.sp-commit code{font-size:.8125rem}
.sp-chips{display:inline-flex;flex-wrap:wrap;align-items:center;gap:.25rem}
.sp-chips .sp-ghost{font-size:.8125rem}
@media (max-width:560px){.sp-release-links{margin-left:0;width:100%}}

/* The status page: each class has a tone, and the page always shows the tone with an icon and a label */
.sp-c-waiting{--sp-tone:var(--sp-warn);--sp-ink:var(--sp-warn-ink)}
.sp-c-blocked{--sp-tone:var(--sp-bad);--sp-ink:var(--sp-bad-ink)}
.sp-c-progress{--sp-tone:var(--sp-accent);--sp-ink:var(--sp-accent-strong)}
.sp-c-open{--sp-tone:var(--sp-neutral);--sp-ink:var(--sp-fg-2)}
.sp-c-later{--sp-tone:var(--sp-rule-strong);--sp-ink:var(--sp-muted)}
.sp-c-done{--sp-tone:var(--sp-good);--sp-ink:var(--sp-good-ink)}
.sp-meter{display:flex;gap:2px;height:12px;border-radius:6px;overflow:hidden;background:var(--sp-rule);margin-top:.75rem}
.sp-meter span{display:block;min-width:4px;background:var(--sp-tone)}
.sp-meter-legend{display:flex;flex-wrap:wrap;gap:.25rem 1rem;list-style:none;margin:.5rem 0 1rem;padding:0;color:var(--sp-fg-2);font-size:.875rem}
.sp-meter-legend li{display:inline-flex;align-items:center;gap:.25rem}
.sp-meter-legend strong{font-family:var(--sp-mono);color:var(--sp-ink)}
.sp-swatch{display:inline-block;width:12px;height:10px;border-radius:2px;background:var(--sp-tone)}
.sp-filters{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;margin-bottom:.5rem}
.sp-filters>span{display:inline-flex;flex-wrap:wrap;gap:.25rem}
.sp-group{margin-top:1.5rem}
.sp-group h3{display:flex;align-items:center;gap:.5rem;margin:0;padding-bottom:.25rem;color:var(--sp-ink);border-bottom:2px solid var(--sp-tone)}
.sp-group-count{font-family:var(--sp-mono);font-size:.875rem;font-weight:600;color:var(--sp-fg-2);background:var(--sp-sunken);border-radius:999px;padding:0 .5rem}
.sp-table-box{max-width:100%;overflow-x:auto}
table.sp-table{width:100%;border-collapse:collapse;font-size:.9rem}
.sp-table th,.sp-table td{text-align:left;vertical-align:top;padding:.5rem;border-bottom:1px solid var(--sp-rule)}
.sp-table thead th{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--sp-muted)}
.sp-table th[scope="row"]{font-family:var(--sp-mono);font-weight:600;white-space:nowrap;border-left:3px solid var(--sp-tone)}
.sp-item{min-width:16rem;overflow-wrap:anywhere}
.sp-item-meta{display:block;margin-top:2px}
.sp-status{color:var(--sp-ink);overflow-wrap:anywhere}
.sp-links{display:inline-flex;flex-wrap:wrap;gap:2px .5rem;overflow-wrap:anywhere}
.sp-done{margin-top:1rem}
.sp-done>summary{cursor:pointer;color:var(--sp-good-ink)}
@media (max-width:760px){
.sp-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.sp-table,.sp-table tbody,.sp-table tr,.sp-table th,.sp-table td{display:block;width:100%}
.sp-table tr{border:1px solid var(--sp-rule);border-left:4px solid var(--sp-tone);border-radius:var(--sp-radius);padding:.5rem .75rem;margin-top:.5rem;background:var(--sp-surface)}
.sp-table th,.sp-table td{border:0;padding:2px 0}
.sp-table th[scope="row"]{border-left:0}
.sp-table td{display:grid;grid-template-columns:4.5rem minmax(0,1fr);align-items:baseline;gap:.5rem}
.sp-table td::before{content:attr(data-label);font-size:.75rem;color:var(--sp-muted)}
.sp-table td.sp-item{display:block;min-width:0}
.sp-table td.sp-item::before{content:none}
}
.sp-cards{list-style:none;margin:.75rem 0 0;padding:0;display:flex;flex-direction:column;gap:.5rem}
.sp-card{background:var(--sp-surface);border:1px solid var(--sp-rule);border-radius:var(--sp-radius);padding:.5rem .75rem;min-width:0}
.sp-card-title{display:block;font-weight:600;overflow-wrap:anywhere}
.sp-number{font-family:var(--sp-mono);font-weight:400;color:var(--sp-muted)}
.sp-card-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .75rem;margin-top:.25rem;color:var(--sp-fg-2);font-size:.875rem}
.sp-branch{font-size:.8125rem;min-width:0}
.sp-check{display:inline-flex;align-items:center;gap:.25rem;white-space:nowrap}
.sp-dot-state{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--sp-neutral)}
.sp-check-success .sp-dot-state{background:var(--sp-good)}
.sp-check-failure .sp-dot-state{background:var(--sp-bad)}
.sp-check-pending .sp-dot-state{background:var(--sp-warn)}
.sp-check-none .sp-dot-state{background:transparent;border:1.5px solid var(--sp-neutral)}
.sp-labels{display:inline-flex;flex-wrap:wrap;gap:4px}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;

// Without JavaScript, the page shows all its parts, and it hides the controls that need a script
const NO_SCRIPT_CSS = `.sp-release[hidden],.sp-extra[hidden]{display:block!important}li.sp-extra[hidden]{display:list-item!important}
.sp-chips>.sp-extra[hidden]{display:inline-block!important}[data-sp-js]{display:none!important}`;

/** The parts of one page. */
export interface PageParts {
  /** The title of the page, for example "Releases". */
  title: string;
  description: string;
  /** The page of the navigation that is current. */
  current: "releases" | "status";
  /** The HTML of the main content. */
  main: string;
  /** The ES module of the interactions. */
  script: string;
}

/** This function gives the name of the repository: "client" for "mark1russell7/client". */
export function repositoryName(repository: string): string {
  return repository.split("/").pop() || repository;
}

/** This function makes the complete HTML document of a page. */
export function pageShell(parts: PageParts, options: PageOptions): string {
  const base = options.base.endsWith("/") ? options.base : `${options.base}/`;
  const name = options.siteName || repositoryName(options.repository);
  const nav = (page: PageParts["current"], label: string): string =>
    `<a href="${escapeHtml(`${base}${page}/`)}"${parts.current === page ? ' aria-current="page"' : ""}>${label}</a>`;
  const commit = options.commit
    ? ` from ${link(`https://github.com/${options.repository}/commit/${options.commit}`, `<code>${escapeHtml(options.commit.slice(0, 7))}</code>`)}`
    : "";
  const data = `${base}data/${parts.current}.json`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(`${parts.title} · ${name}`)}</title>
<meta name="description" content="${escapeHtml(parts.description)}">
<style>${BASE_CSS}${options.extraCss ? `\n${options.extraCss}` : ""}</style>
<noscript><style>${NO_SCRIPT_CSS}</style></noscript>
</head>
<body>
<a class="sp-skip" href="#main">Skip to the content</a>
<header class="sp-header"><nav aria-label="Site"><a class="sp-home" href="${escapeHtml(base)}">${escapeHtml(name)}</a>${nav("releases", "Releases")}${nav("status", "Status")}</nav></header>
<main id="main" class="sp-main">
${parts.main}
</main>
<footer class="sp-footer"><p>The build made this page at ${escapeHtml(longDate(options.generatedAt))}${commit}. The data is in <a href="${escapeHtml(data)}"><code>${escapeHtml(`data/${parts.current}.json`)}</code></a>.</p></footer>
<script type="module">${parts.script}</script>
</body>
</html>
`;
}
