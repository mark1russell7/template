/**
 * The floor of text for a reader with no script. A search robot, a link preview and a reader app read the HTML of a page,
 * and many of them start no script. An app that writes all its text with a script gives them an empty page.
 *
 * The site check reads the HTML of each page and fails a page with no `h1` or with less than `NO_SCRIPT_MIN_CHARS` characters of text.
 * These functions have no I/O, so the tests call them with no browser. The scan is linear in the length of the HTML. Thus a page
 * with many starts of a comment and no end does not stop the check.
 */

/**
 * The least number of characters of text in the HTML of a page, with no script.
 *
 * The value comes from a dry run over the live HTML of 185 pages of 54 sites on 2026-11-16. The site check examines 179 of
 * them. Of those 179 pages, the least has 209 characters, the 5th percentile has 297 and the median has 2065. Thus the floor
 * of 200 fails no page of the check on that date, but it fails an empty shell with only a root element. A floor near the 5th
 * percentile fails good short pages, for example the Releases page of a new package (292 characters).
 */
export const NO_SCRIPT_MIN_CHARS = 200;

/** The text that the HTML of a page gives to a reader with no script. */
export interface NoScriptText {
  /** True when the HTML has an `h1` element outside the parts that do not count. */
  readonly h1: boolean;
  /** The number of characters of text. Each run of white space and each character reference counts as one character. */
  readonly chars: number;
}

/**
 * The elements whose content does not count. The head is not on the page. A script and a template show no text. The text in
 * `noscript` is often only "Turn on JavaScript", so it does not count either.
 */
const NOT_TEXT: readonly string[] = ["head", "script", "style", "template", "noscript"];

/**
 * This function tells if the name of a tag ends at `index`: white space, "/" or ">" follows the name. Thus `<template-card>`
 * is not a template, and `<h10>` is not an `h1`.
 */
function nameEndsAt(lower: string, index: number): boolean {
  return /[\s/>]/u.test(lower.charAt(index));
}

/** A search for the first index of a text at or after a position, or -1. */
type Search = (needle: string, from: number) => number;

/**
 * This function gives a search in a source. A text that is not after a position is not after a later position either. Thus
 * the search keeps each failure and does not do it again, and a scan with many searches stays linear.
 */
function searchIn(source: string): Search {
  const missing = new Map<string, number>();
  return (needle, from) => {
    const least = missing.get(needle);
    if (least !== undefined && from >= least) return -1;
    const index = source.indexOf(needle, from);
    if (index === -1) missing.set(needle, from);
    return index;
  };
}

/**
 * This function gives the end of the comment or of the element of `NOT_TEXT` that starts at `lt`, or undefined. An element
 * with no end tag gives undefined. The names in `unclosed` have no end tag after this position, so the function does not look again.
 */
function partEnd(lower: string, lt: number, search: Search, unclosed: Set<string>): number | undefined {
  if (lower.startsWith("<!--", lt)) {
    const close = search("-->", lt + 4);
    return close === -1 ? undefined : close + 3;
  }
  for (const name of NOT_TEXT) {
    const after = lt + 1 + name.length;
    if (!lower.startsWith(name, lt + 1) || !nameEndsAt(lower, after)) continue;
    if (unclosed.has(name)) return undefined;
    const gt = search(">", after);
    if (gt === -1) return undefined;
    for (let close = search(`</${name}`, gt + 1); close !== -1; close = search(`</${name}`, close + 1)) {
      let end = close + 2 + name.length;
      while (/\s/u.test(lower.charAt(end))) end += 1;
      if (lower.charAt(end) === ">") return end + 1;
    }
    unclosed.add(name);
    return undefined;
  }
  return undefined;
}

/**
 * This function gives the `h1` and the number of characters of text of an HTML document, with no script. It removes the
 * comments, the elements of `NOT_TEXT` and the tags in one scan, from the left to the right.
 */
export function noScriptText(html: string): NoScriptText {
  // Only A to Z go to lower case, so each index of the copy is an index of the HTML.
  const lower = html.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());
  const search = searchIn(lower);
  const unclosed = new Set<string>();
  const parts: string[] = [];
  let h1 = false;
  let at = 0;
  for (let lt = search("<", 0); lt !== -1; lt = search("<", Math.max(at, lt + 1))) {
    // In HTML, a "<" starts a tag only before a letter, "/", "!" or "?". Each other "<" is text, as in "1 < 2" and "x<3".
    if (!/[a-z/!?]/u.test(lower.charAt(lt + 1))) continue;
    let end = partEnd(lower, lt, search, unclosed);
    if (end === undefined) {
      // A tag. A "<" with no ">" after it is text, and so is the rest of the HTML.
      const gt = search(">", lt + 1);
      if (gt === -1) break;
      if (lower.startsWith("<h1", lt) && nameEndsAt(lower, lt + 3)) h1 = true;
      end = gt + 1;
    }
    parts.push(html.slice(at, lt), " ");
    at = end;
  }
  parts.push(html.slice(at));
  const text = parts
    .join("")
    .replace(/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi, "x")
    .replace(/\s+/g, " ")
    .trim();
  return { h1, chars: [...text].length };
}

/** This function gives the problems of the floor of text of an HTML document. An empty list means that the document passes. */
export function noScriptProblems(html: string, minChars: number = NO_SCRIPT_MIN_CHARS): string[] {
  const { h1, chars } = noScriptText(html);
  const problems: string[] = [];
  if (!h1) problems.push("with no script, the HTML of the page has no h1. Put the title of the page in an h1 of the HTML.");
  if (chars < minChars) {
    problems.push(`with no script, the HTML of the page has ${String(chars)} characters of text, less than ${String(minChars)}. Put the main text of the page in its HTML.`);
  }
  return problems;
}
