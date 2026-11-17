import { describe, expect, it } from "vitest";
import { NO_SCRIPT_MIN_CHARS, noScriptProblems, noScriptText } from "./noscript.ts";

const doc = (body: string, head = "<title>A title that does not count</title>") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe("noScriptText", () => {
  it("counts the text and finds the h1 of a static page", () => {
    expect(noScriptText(doc("<h1>Title</h1><p>Some text.</p>"))).toEqual({ h1: true, chars: "Title Some text.".length });
  });

  it("does not count the head, scripts, styles, templates, noscript and comments", () => {
    const body = [
      "<script>document.body.textContent = 'a long text of the script'</script>",
      '<script type="module">import "./app.js"</script>',
      "<style>body { color: red }</style>",
      "<template><h1>A template</h1><p>Text of a template</p></template>",
      "<noscript><h1>Turn on JavaScript</h1></noscript>",
      "<!-- <h1>A comment</h1> -->",
      '<div id="root"></div>',
    ].join("\n");
    expect(noScriptText(doc(body))).toEqual({ h1: false, chars: 0 });
  });

  it("counts each run of white space and each character reference as one character", () => {
    // The characters are a, a space, b, a reference, c, a reference, d, a reference, e and a reference.
    expect(noScriptText(doc("<p>a \n\t b&nbsp;c&#160;d&#xA0;e&amp;</p>")).chars).toBe(10);
    expect(noScriptText(doc("<p>été 🌍</p>")).chars).toBe(5);
  });

  it("finds an h1 with attributes or in capitals, and not an h10 or an h1 in an attribute value", () => {
    expect(noScriptText(doc('<H1 class="title">T</H1>')).h1).toBe(true);
    expect(noScriptText(doc("<h1/>")).h1).toBe(true);
    expect(noScriptText(doc("<h2>T</h2><h10>T</h10>")).h1).toBe(false);
  });

  it("keeps the text after a script whose text has a tag", () => {
    expect(noScriptText(doc('<script>const s = "<p>x</p>";</script><h1>After</h1>'))).toEqual({ h1: true, chars: 5 });
  });

  it("finds the end tag after a space, and keeps the text of an element with no end tag", () => {
    expect(noScriptText(doc("<SCRIPT>x</script ><h1>T</h1>"))).toEqual({ h1: true, chars: 1 });
    expect(noScriptText("<h1>T</h1><script>a</scripts>b")).toEqual({ h1: true, chars: "T a b".length });
    expect(noScriptText("<p>a</p><!-- b")).toEqual({ h1: false, chars: "a <!-- b".length });
  });

  it("keeps a \"<\" that does not start a tag as text", () => {
    expect(noScriptText(doc("<h1>T</h1><p>1 < 2 and 3 > 2</p>"))).toEqual({ h1: true, chars: "T 1 < 2 and 3 > 2".length });
    expect(noScriptText(doc("<p>x<3, a <= b, <- go</p>"))).toEqual({ h1: false, chars: "x<3, a <= b, <- go".length });
    // A "<" before a letter, "/", "!" or "?" starts a tag, so these give no text.
    expect(noScriptText(doc('<?xml version="1.0"?><!doctype html></p>'))).toEqual({ h1: false, chars: 0 });
  });

  it("reads a custom element with the name of a raw-text element and a dash as an element with text", () => {
    const body = "<template-card><h1>Card</h1></template-card><style-guide>Guide</style-guide><script-box>Box</script-box><head-line>Line</head-line>";
    expect(noScriptText(doc(body))).toEqual({ h1: true, chars: "Card Guide Box Line".length });
  });

  it("is linear: many starts of a comment, a script or a tag with no end do not stop the scan", () => {
    const n = 100_000;
    expect(noScriptText("<!--".repeat(n))).toEqual({ h1: false, chars: 4 * n });
    expect(noScriptText(`${"<script>".repeat(n)}<h1>T</h1>`)).toEqual({ h1: true, chars: 1 });
    // Each script has only a wrong end tag, so the scan looks for its end tag once. The text is n letters x with a space between.
    expect(noScriptText("<script>x</scriptx>".repeat(n)).chars).toBe(2 * n - 1);
    expect(noScriptText(`a${"<".repeat(n)}`).chars).toBe(n + 1);
  });
});

describe("noScriptProblems", () => {
  it("passes a page with an h1 and enough text", () => {
    expect(noScriptProblems(doc(`<h1>T</h1><p>${"x".repeat(NO_SCRIPT_MIN_CHARS)}</p>`))).toEqual([]);
  });

  it("fails a page with no h1, and a page with too little text", () => {
    expect(noScriptProblems(doc(`<p>${"x".repeat(NO_SCRIPT_MIN_CHARS)}</p>`))).toEqual(["with no script, the HTML of the page has no h1. Put the title of the page in an h1 of the HTML."]);
    expect(noScriptProblems(doc("<h1>Title</h1>"))).toEqual(["with no script, the HTML of the page has 5 characters of text, less than 200. Put the main text of the page in its HTML."]);
  });

  it("takes another floor, and the floor 0 keeps only the rule of the h1", () => {
    expect(noScriptProblems(doc("<h1>Title</h1>"), 5)).toEqual([]);
    expect(noScriptProblems(doc("<h1>Title</h1>"), 6)).toHaveLength(1);
    expect(noScriptProblems(doc('<div id="root"></div>'), 0)).toEqual(["with no script, the HTML of the page has no h1. Put the title of the page in an h1 of the HTML."]);
  });
});
