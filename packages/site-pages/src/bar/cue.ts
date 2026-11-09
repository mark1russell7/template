/**
 * The scroll cue of the built pages (`site-pages cue`). The Pages workflow changes each code block (`pre`) of each
 * built HTML page. Each block gets the class `scroll-cue` and a place in the tab order. The page gets the style
 * `scroll-cue.css`. Thus a code block that is wider than its box shows a fade at the edge with more content. This
 * occurs also on a site that does not use the rehype plugin of site-pages. A box with no overflow has no active scroll
 * timeline, so it shows no cue.
 *
 * A script of the page can make a code block after the load, for example from Markdown or from a template string. Thus
 * each page with a script of its own also gets the style and a script. That script gives the cue to each code block
 * that the page adds.
 *
 * A block with `data-overflow-ok` or with the class `scroll-cue` stays as it is. The text of `script`, `style` and
 * `textarea` elements does not change.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { htmlFiles, type BarIo } from "./bar.ts";

/** The attribute of each code block that the step changed. The script of the fallback finds the blocks with it. */
export const CUE_ATTRIBUTE = "data-scroll-cue";
const STYLE_ID = "site-cue-css";
const SCRIPT_ID = "site-cue-js";
const STYLE_PATTERN = /<style id="site-cue-css">[\s\S]*?<\/style>/;
const SCRIPT_PATTERN = /<script id="site-cue-js">[\s\S]*?<\/script>/;

/** This function reads `scroll-cue.css` of the package, the one source of the style of the cue. */
export function cueCss(): string {
  return readFileSync(new URL("../../styles/scroll-cue.css", import.meta.url), "utf8");
}

/**
 * The script of the cue in the browser. It has two jobs.
 *
 * - It gives the cue to each code block that a script of the page makes, at the start and after it. The rules of
 *   `cueAttributes` apply: a block with `data-overflow-ok` or with the class `scroll-cue` of the page stays as it is.
 * - In a browser with no scroll timelines, the style gives the box the background color `--scroll-cue-bg`. The script
 *   sets that variable to the color of each block with the mark. When the block has no color, the script uses the color
 *   of its first ancestor with a color. Thus the block keeps the color of its theme.
 */
export const CUE_SCRIPT: string =
  '(() => { const old = !!window.CSS && !CSS.supports("animation-timeline: scroll()"); ' +
  'const paint = (box) => { box.classList.remove("scroll-cue"); let node = box; let color = ""; ' +
  "while (node) { color = getComputedStyle(node).backgroundColor; if (color !== \"transparent\" && !/^rgba\\(.*,\\s*0\\)$/.test(color)) break; node = node.parentElement; } " +
  'box.classList.add("scroll-cue"); if (node) box.style.setProperty("--scroll-cue-bg", color); }; ' +
  `const cue = (box) => { if (box.hasAttribute("data-overflow-ok")) return; if (!box.hasAttribute("${CUE_ATTRIBUTE}")) { ` +
  'if (box.classList.contains("scroll-cue")) return; box.classList.add("scroll-cue"); ' +
  `if (!box.hasAttribute("tabindex")) box.tabIndex = 0; box.setAttribute("${CUE_ATTRIBUTE}", ""); } if (old) paint(box); }; ` +
  'const scan = (root) => { if (root.nodeType !== 1) return; if (root.matches("pre")) cue(root); for (const box of root.querySelectorAll("pre")) cue(box); }; ' +
  "scan(document.documentElement); " +
  "new MutationObserver((records) => { for (const record of records) for (const node of record.addedNodes) scan(node); })" +
  ".observe(document.documentElement, { childList: true, subtree: true }); })();";

const CLASS_PATTERN = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * This function gives the attributes of one `pre` start tag with the cue. It gives `undefined` when the tag keeps its
 * attributes: the tag has `data-overflow-ok`, or it already has the class `scroll-cue`.
 */
export function cueAttributes(attributes: string): string | undefined {
  if (/\sdata-overflow-ok\b/i.test(attributes)) return undefined;
  const match = CLASS_PATTERN.exec(attributes);
  const classes = match === null ? "" : (match[1] ?? match[2] ?? match[3] ?? "");
  if (classes.split(/\s+/).includes("scroll-cue")) return undefined;
  const named = `class="${`${classes.trim()} scroll-cue`.trim()}"`;
  let next = match === null ? `${attributes} ${named}` : attributes.replace(CLASS_PATTERN, ` ${named}`);
  if (!/\stabindex\s*=/i.test(next)) next += ' tabindex="0"';
  return `${next} ${CUE_ATTRIBUTE}`;
}

/** The text of these elements is not HTML, so the step does not change it. */
const RAW_TEXT = /<(script|style|textarea)\b[\s\S]*?<\/\1\s*>/gi;

/** A script element that can make a code block: each script, but not a JSON data block. */
const PAGE_SCRIPT = /<script\b(?![^>]*\btype\s*=\s*["']?application\/(?:ld\+)?json)[^>]*>/i;

/**
 * This function writes the cue into the HTML of one page, and gives the HTML and the number of code blocks that it
 * changed. The style comes last in `<head>`, and the script comes last in `<body>`. A style and a script of an earlier
 * start go away, so the function can start two times on one page. The script of a page can make a code block. Thus a
 * page with a script of its own gets the style and the script also with no changed block. A page with no changed block
 * and no script gets no style.
 */
export function injectCue(html: string, css: string): { html: string; boxes: number } {
  let boxes = 0;
  const source = html.replace(STYLE_PATTERN, "").replace(SCRIPT_PATTERN, "");
  const edit = (part: string) =>
    part.replace(/<pre\b([^>]*)>/gi, (tag, attributes: string) => {
      const next = cueAttributes(attributes);
      if (next === undefined) return tag;
      boxes++;
      return `<pre${next}>`;
    });
  let out = "";
  let at = 0;
  for (const raw of source.matchAll(RAW_TEXT)) {
    out += edit(source.slice(at, raw.index)) + raw[0];
    at = raw.index + raw[0].length;
  }
  out += edit(source.slice(at));
  const marked = boxes > 0 || source.includes(` ${CUE_ATTRIBUTE}`) || PAGE_SCRIPT.test(source);
  if (!marked) return { html, boxes: 0 };
  const style = `<style id="${STYLE_ID}">${css}</style>`;
  const script = `<script id="${SCRIPT_ID}">${CUE_SCRIPT}</script>`;
  out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${style}</head>`) : `${style}${out}`;
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${script}</body>`) : `${out}${script}`;
  return { html: out, boxes };
}

/** This function writes the cue into each HTML page of the built site folder, and gives the number of pages and of code blocks. */
export function applyCue(out: string, css: string): { pages: number; changed: number; boxes: number } {
  const files = htmlFiles(out);
  let changed = 0;
  let boxes = 0;
  for (const file of files) {
    const full = join(out, file);
    const html = readFileSync(full, "utf8");
    const next = injectCue(html, css);
    boxes += next.boxes;
    if (next.html !== html) {
      writeFileSync(full, next.html);
      changed++;
    }
  }
  return { pages: files.length, changed, boxes };
}

export const CUE_HELP = `Usage: site-pages cue --out <dir>

Gives each code block (pre) of each HTML page of the built site folder the class scroll-cue and a
place in the tab order, and writes the style scroll-cue.css into each changed page. A code block that
is wider than its box then shows a fade at the edge with more content. A block with the attribute
data-overflow-ok or the class scroll-cue stays as it is. A page with a script also gets a script that
gives the cue to each code block that the page makes in the browser.

Options:
  --out <dir>  The built site folder
  --help       Shows this text
`;

/** This function starts the `cue` command with its arguments, without the word `cue`. */
export function runCueCli(argv: readonly string[], io: BarIo, css: () => string = cueCss): number {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: [...argv], allowPositionals: false, options: { out: { type: "string" }, help: { type: "boolean" } } }));
  } catch (error) {
    io.stderr(`site-pages cue: ${error instanceof Error ? error.message : String(error)}\n\n${CUE_HELP}`);
    return 2;
  }
  if (values["help"]) {
    io.stdout(CUE_HELP);
    return 0;
  }
  const out = typeof values["out"] === "string" && values["out"] !== "" ? values["out"] : undefined;
  if (out === undefined) {
    io.stderr(`site-pages cue: give --out\n\n${CUE_HELP}`);
    return 2;
  }
  const result = applyCue(isAbsolute(out) ? out : resolve(io.cwd, out), css());
  if (result.pages === 0) {
    io.stderr(`site-pages cue: ${out} has no HTML page\n`);
    return 1;
  }
  io.stdout(`site-pages cue: ${result.boxes} code blocks in ${result.changed} of ${result.pages} pages got the scroll cue.\n`);
  return 0;
}
