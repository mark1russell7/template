/**
 * Bare error texts. A page that shows `TypeError: Failed to fetch` gives the user no context, no retry and nothing to copy or
 * report. An error view gives all of them. This file finds the texts of an error that a page shows outside an error view.
 *
 * A script starts in each page before its own scripts (`BARE_ERROR_WATCH`). It watches each text that the page adds or changes,
 * also a text that shows for a short time only. `BARE_ERRORS` reads what it found. A repository turns the failure on with the
 * field `sitePages.bareErrors` of its package.json, or with `--bare-errors fail`. Until then the check reports the texts only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `fail`: a bare error text fails the view. `report`: the check reports the text, and the view does not fail. */
export type BareErrorMode = "fail" | "report";

/** The modes, for the CLI and package.json. */
export const BARE_ERROR_MODES: readonly BareErrorMode[] = ["fail", "report"];

/** The most texts that one view records. */
export const MAX_BARE_ERRORS: number = 20;

/**
 * The shape of the text of a thrown value, for example `Error: x`, `TypeError: x` or `DOMException: x`. It also matches the
 * messages of the browser that a page shows when it puts `error.message` on the screen.
 */
export const BARE_ERROR_SHAPE: string = String.raw`(?:^|[\s("'\[:])[A-Z]?[A-Za-z]*(?:Error|Exception): \S|Failed to fetch|NetworkError when attempting to fetch|Cannot read propert(?:y|ies) of (?:undefined|null)|is not a function|\[object Object\]|Unexpected token .{1,20} in JSON`;

/** The elements whose text is an example, not a message: code, and the text of a form field. */
export const BARE_ERROR_SKIP: string = "pre, code, kbd, samp, textarea, script, style, template, noscript, [hidden], [aria-hidden=true]";

/** The error views. A text inside one is not bare. */
export const ERROR_VIEWS: string = "otel-error, [data-error-view]";

const KEY = "site-check.bare-errors";

/**
 * A script that each page starts before its own scripts. It records each text with the shape of an error that the page adds or
 * changes outside an error view. It records the element and the text, at most `MAX_BARE_ERRORS` of them.
 */
export const BARE_ERROR_WATCH: string = `(() => {
  const shape = new RegExp(${JSON.stringify(BARE_ERROR_SHAPE)});
  const skip = ${JSON.stringify(BARE_ERROR_SKIP)};
  const views = ${JSON.stringify(ERROR_VIEWS)};
  const found = [];
  const seen = new Set();
  Object.defineProperty(globalThis, Symbol.for(${JSON.stringify(KEY)}), { value: found });
  const name = (element) => element.tagName.toLowerCase() + (element.id ? "#" + element.id : element.classList.length > 0 ? "." + element.classList[0] : "");
  const look = (node) => {
    const element = node.parentElement;
    if (found.length >= ${MAX_BARE_ERRORS} || !element || element.closest(skip) || element.closest(views)) return;
    const texts = [node.data];
    // The text of the element too, for a message in two nodes. Not when it has code in it: that is an example.
    if (!element.querySelector(skip)) texts.push(element.textContent ?? "");
    const text = texts.map((each) => each.replace(/\\s+/g, " ").trim()).find((each) => shape.test(each));
    if (text === undefined) return;
    const entry = name(element) + ': "' + text.slice(0, 160) + '"';
    if (seen.has(entry)) return;
    seen.add(entry);
    found.push(entry);
  };
  const walk = (root) => {
    if (root.nodeType === 3) return look(root);
    if (root.nodeType !== 1) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) look(node);
  };
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") look(record.target);
      else for (const node of record.addedNodes) walk(node);
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
})();`;

/** The expression that gives the texts that `BARE_ERROR_WATCH` found in the page. */
export const BARE_ERRORS: string = `[...(globalThis[Symbol.for(${JSON.stringify(KEY)})] ?? [])]`;

/** The problem of one bare error text. */
export function bareErrorProblem(entry: string): string {
  return `an error text with no error view: ${entry}`;
}

/**
 * This function reads the mode from the field `sitePages.bareErrors` of the package.json in `cwd`. No file or no field gives
 * `report`. A field with another value gives an Error.
 */
export function readBareErrorMode(cwd: string): BareErrorMode | Error {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  } catch {
    return "report";
  }
  const pages = typeof manifest === "object" && manifest !== null ? (manifest as { sitePages?: unknown }).sitePages : undefined;
  const value = typeof pages === "object" && pages !== null ? (pages as { bareErrors?: unknown }).bareErrors : undefined;
  if (value === undefined) return "report";
  return BARE_ERROR_MODES.includes(value as BareErrorMode) ? (value as BareErrorMode) : new Error(`the field sitePages.bareErrors of package.json must be fail or report, not ${JSON.stringify(value)}`);
}
