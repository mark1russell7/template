/**
 * A small highlighter for the files of a new package: JSON and TypeScript. It gives the HTML of each line, with each
 * character of the text escaped. It knows strings, keys, keywords, numbers and line comments.
 */

const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const KEYWORDS = "import|export|from|const|let|function|return|async|await|default|type|interface|new|if|else|as|readonly|void";
const TOKEN = new RegExp(String.raw`(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|` + "`(?:[^`\\\\]|\\\\.)*`" + String.raw`)(\s*:)?|\b(${KEYWORDS}|true|false|null)\b|(\b\d+(?:\.\d+)?\b)`, "g");

/** This function gives the HTML of one line. */
function line(text: string): string {
  let html = "";
  let at = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    html += escape(text.slice(at, index));
    const [whole, comment, string, colon, keyword, number] = match;
    if (comment !== undefined) html += `<span class="t-c">${escape(comment)}</span>`;
    else if (string !== undefined) html += `<span class="${colon === undefined ? "t-s" : "t-k"}">${escape(string)}</span>${escape(colon ?? "")}`;
    else if (keyword !== undefined) html += `<span class="t-w">${escape(keyword)}</span>`;
    else if (number !== undefined) html += `<span class="t-n">${escape(number)}</span>`;
    else html += escape(whole);
    at = index + whole.length;
  }
  return html + escape(text.slice(at));
}

/** This function gives the HTML of each line of a file. A file that is not JSON or TypeScript gets only the escape. */
export function highlight(text: string, path: string): string[] {
  const lines = text.replace(/\n$/, "").split("\n");
  return /\.(json|[cm]?[jt]sx?)$/.test(path) ? lines.map(line) : lines.map(escape);
}
