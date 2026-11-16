/**
 * The icon of a site page.
 *
 * A page with no icon link makes the browser ask for `/favicon.ico`. A project site on GitHub Pages has no such file.
 * Thus the console of each page shows a 404 error, and a check of the page errors counts it.
 */
import { scanHtml } from "@mark1russell7/text/html";
import { escapeHtml } from "./html.ts";

/** The SVG of the default icon: a page with a folded corner on a square of the accent color of the pages. */
export const SITE_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2346c4"/><path d="M10 7h8l5 5v13H10z" fill="#fff"/><path d="M18 7v5h5z" fill="#e7ecfd"/></svg>';

/**
 * The `href` of the default icon: a data URL of `SITE_ICON_SVG`. The icon needs no file and no request.
 *
 * The value is a literal, not a request of `encodeURIComponent` when the module loads. A bundle that does not use the icon
 * then drops it. conventions bundles this package. A request here changes the build of conventions, and then it needs a release.
 * A test checks that the literal is the data URL of `SITE_ICON_SVG`.
 */
export const SITE_ICON_HREF: string =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%227%22%20fill%3D%22%232346c4%22%2F%3E%3Cpath%20d%3D%22M10%207h8l5%205v13H10z%22%20fill%3D%22%23fff%22%2F%3E%3Cpath%20d%3D%22M18%207v5h5z%22%20fill%3D%22%23e7ecfd%22%2F%3E%3C%2Fsvg%3E";

/**
 * This function tells if an HTML page has an icon link: a `link` element with the word `icon` in its `rel`.
 * `rel="icon"` and `rel="shortcut icon"` count. `rel="apple-touch-icon"` does not count, because a browser that reads only
 * that link still asks for `/favicon.ico`. A link in a comment, a script, a style or a template does not count, because
 * the browser does not read it. The scan is `scanHtml` of `@mark1russell7/text`.
 */
export function hasIconLink(html: string): boolean {
  return scanHtml(html).elements.some(
    (element) => element.name === "link" && (element.attributes["rel"] ?? "").toLowerCase().split(/\s+/).includes("icon"),
  );
}

/** This function gives the `link` element of an icon, for the `head` of a page. The default is the icon of `SITE_ICON_HREF`. */
export function iconLink(href: string = SITE_ICON_HREF): string {
  return `<link rel="icon" href="${escapeHtml(href)}">`;
}
