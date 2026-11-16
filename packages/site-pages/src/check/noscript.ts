/**
 * The floor of text for a reader with no script. A search robot, a link preview and a reader app read the HTML of a page,
 * and many of them start no script. An app that writes all its text with a script gives them an empty page.
 *
 * The site check reads the HTML of each page and fails a page with no `h1` or with less than `NO_SCRIPT_MIN_CHARS` characters of text.
 * These functions have no I/O, so the tests call them with no browser. The scan of the HTML is `scanHtml` of `@mark1russell7/text`.
 * It is linear in the length of the HTML. Thus a page with many starts of a comment and no end does not stop the check.
 */
import { scanHtml } from "@mark1russell7/text/html";

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
 * This function gives the `h1` and the number of characters of text of an HTML document, with no script. The scan of the
 * HTML is `scanHtml` of `@mark1russell7/text`, with the elements of `NOT_TEXT` skipped. Thus a ">" in a quoted value of
 * an attribute does not end its tag.
 */
export function noScriptText(html: string): NoScriptText {
  const { text, elements } = scanHtml(html, { skip: NOT_TEXT });
  const plain = text
    .replace(/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi, "x")
    .replace(/\s+/g, " ")
    .trim();
  return { h1: elements.some((element) => element.name === "h1"), chars: [...plain].length };
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
