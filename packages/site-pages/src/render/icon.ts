/**
 * The icon of a site page.
 *
 * A page with no icon link makes the browser ask for `/favicon.ico`. A project site on GitHub Pages has no such file.
 * Thus the console of each page shows a 404 error, and a check of the page errors counts it.
 */
import { escapeHtml } from "./html.ts";

/** The SVG of the default icon: a page with a folded corner on a square of the accent color of the pages. */
export const SITE_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2346c4"/><path d="M10 7h8l5 5v13H10z" fill="#fff"/><path d="M18 7v5h5z" fill="#e7ecfd"/></svg>';

/** The `href` of the default icon: a data URL of `SITE_ICON_SVG`. The icon needs no file and no request. */
export const SITE_ICON_HREF = `data:image/svg+xml,${encodeURIComponent(SITE_ICON_SVG)}`;

/**
 * This function tells if an HTML page has an icon link: a `link` element with the word `icon` in its `rel`.
 * `rel="icon"` and `rel="shortcut icon"` count. `rel="apple-touch-icon"` does not count, because a browser that reads only
 * that link still asks for `/favicon.ico`.
 */
export function hasIconLink(html: string): boolean {
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = /\srel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    const words = (rel?.[1] ?? rel?.[2] ?? rel?.[3] ?? "").toLowerCase().split(/\s+/);
    if (words.includes("icon")) return true;
  }
  return false;
}

/** This function gives the `link` element of an icon, for the `head` of a page. The default is the icon of `SITE_ICON_HREF`. */
export function iconLink(href: string = SITE_ICON_HREF): string {
  return `<link rel="icon" href="${escapeHtml(href)}">`;
}
