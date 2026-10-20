/**
 * The HTML helpers of the pages: the escape functions and a small inline Markdown renderer.
 */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** This function escapes a text for HTML content and for an attribute value in double quotes. */
export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/**
 * This function gives a URL that a link can hold, or null. It accepts `http:`, `https:` and
 * `mailto:` URLs, and relative URLs. It refuses each other scheme, for example `javascript:`.
 */
export function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (/^(?:https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return null;
  return trimmed;
}

/** This function gives an `<a>` element, or the escaped text when the URL is not safe. */
export function link(url: string, html: string, attributes = ""): string {
  const href = safeUrl(url);
  return href === null ? html : `<a href="${escapeHtml(href)}"${attributes ? ` ${attributes}` : ""}>${html}</a>`;
}

/** The emphasis of a text without code spans or links. The text is already escaped. */
function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?![\w*])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\s][^_]*?)_(?![\w])/g, "$1<em>$2</em>");
}

const INLINE = "`([^`]+)`|\\[((?:[^\\]`]|`[^`]*`)+)\\]\\(([^)\\s]+)\\)";

/**
 * This function renders inline Markdown as HTML: code spans, links, strong text and emphasis. It
 * escapes all other text, so the result is safe.
 */
export function inlineMarkdown(markdown: string): string {
  const text = String(markdown ?? "");
  // A new expression for each call: the text of a link is rendered with a recursive call
  const pattern = new RegExp(INLINE, "g");
  let html = "";
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    html += emphasis(escapeHtml(text.slice(last, match.index)));
    if (match[1] !== undefined) html += `<code>${escapeHtml(match[1])}</code>`;
    else html += link(match[3] ?? "", inlineMarkdown(match[2] ?? ""));
    last = match.index + match[0].length;
  }
  return html + emphasis(escapeHtml(text.slice(last)));
}

/** This function gives "1 item" or "2 items". */
export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/** This function gives "a", "a and b" or "a, b and c". */
export function listText(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
