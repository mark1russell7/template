/**
 * The measurements that the `check` command makes in the page. Each is a string of JavaScript that
 * the browser evaluates, so the code can use only the APIs of the page.
 */

/** Text past the edge of a box that cuts it: an entry of `Measure.cut`. */
export interface Cut {
  /**
   * The kind of the box:
   * - `clip`: the box has `overflow-x: hidden` or `clip`, so a visitor cannot reach the text,
   * - `table`: the box scrolls, and the text is in a table.
   */
  kind: "clip" | "table";
  /** The box. */
  box: string;
  /** The table, or the element of the text. */
  element: string;
  /** The width of the content of the box, in CSS pixels. */
  scrollWidth: number;
  /** The visible width of the box, in CSS pixels. */
  clientWidth: number;
  /** The start of the first text past the edge. */
  text: string;
}

/** The result of `MEASURE`. */
export interface Measure {
  innerWidth: number;
  scrollWidth: number;
  /** The height of the document, for the screenshot. */
  height: number;
  /** The number of characters of visible text. */
  text: number;
  /** The outermost elements that go past the right edge of the screen, at most 8. */
  past: string[];
  /** The text areas that hide a part of their text, at most 8. */
  clipped: string[];
  /** The boxes that cut text at their right edge, at most 8. `cutProblems` of `check.ts` tells which ones are problems. */
  cut: Cut[];
}

/**
 * This expression measures the page. An element counts as past the edge when its right side is
 * more than half a pixel past the width of the document. These elements do not count:
 * - an element in a container that scrolls or clips (`overflow-x` other than `visible`, below `body`),
 * - an element of zero size, a hidden element, or a fixed element that is fully past the edge (a closed drawer),
 * - an element in `.sr`, `.sr-only`, `.visually-hidden` or `.skip` (text for screen readers and skip links),
 * - an element in a `pre`, other than the `pre` itself.
 * Of a chain of elements past the edge, only the outermost one counts.
 *
 * `past` skips each element in a container that scrolls or clips, so `cut` examines those containers.
 * A box is the nearest element around a text, below `body`, with `overflow-x` other than `visible`. Its content is wider
 * than the box by more than 1 px. An element with `overflow-x: clip` is always a box, because it can report no overflow.
 * The text counts when a line of it ends more than 1 px past the right edge of the box.
 *
 * A box that scrolls counts only for text in a table (`table`, `role="table"` or `role="grid"`).
 * A code block, a hex view, a row of tabs and a carousel in such a box are meant to scroll.
 * A box that clips counts for each text, because a visitor cannot reach that text. These texts do not count:
 * - a text in a box with `text-overflow` other than `clip` (a person chose the ellipsis),
 * - a text in an element with `data-overflow-ok`, or in that element itself (a person chose the overflow),
 * - a text in a box with the class `scroll-cue` that scrolls (a shade shows the visitor that it scrolls),
 * - a text in `.sr`, `.sr-only`, `.visually-hidden`, `.skip`, `[aria-hidden="true"]`, `select`, `textarea` or `svg`,
 * - a text in a fixed element, which the box does not clip,
 * - a text that is not visible, or with an element around it of 1 px or less or with `opacity: 0`.
 * Only the first text of a box counts. An element with no text does not count. Vertical overflow does not count.
 */
export const MEASURE = `(() => {
  const root = document.documentElement;
  const w = root.clientWidth;
  const name = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\\s+/).slice(0, 3).join(".") : "");
  const inScroller = (e) => {
    for (let p = e.parentElement; p && p !== document.body && p !== root; p = p.parentElement) {
      if (getComputedStyle(p).overflowX !== "visible") return true;
    }
    return false;
  };
  const counts = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.right <= w + 0.5) return false;
    if (e.closest(".sr,.sr-only,.visually-hidden,.skip")) return false;
    if (e.closest("pre") && e.tagName !== "PRE") return false;
    const s = getComputedStyle(e);
    if (s.visibility === "hidden" || s.display === "none") return false;
    if (s.position === "fixed" && r.left >= w) return false;
    return !inScroller(e);
  };
  const over = new Set([...document.querySelectorAll("body *")].filter(counts));
  const past = [...over]
    .filter((e) => { for (let p = e.parentElement; p; p = p.parentElement) if (over.has(p)) return false; return true; })
    .map((e) => name(e) + " right=" + Math.round(e.getBoundingClientRect().right));
  const clipped = [...document.querySelectorAll("textarea")]
    .filter((e) => { const s = getComputedStyle(e); return (s.overflowY === "hidden" || s.overflowY === "clip") && e.getBoundingClientRect().height > 0 && e.scrollHeight > e.clientHeight + 1; })
    .map((e) => name(e) + " " + e.scrollHeight + ">" + e.clientHeight);
  const boxOf = (e) => {
    for (let p = e; p && p !== document.body && p !== root; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === "clip" || (s.overflowX !== "visible" && p.scrollWidth > p.clientWidth + 1)) return p;
      if (s.position === "fixed") return undefined;
    }
    return undefined;
  };
  const shown = (e) => {
    if (e.closest(".sr,.sr-only,.visually-hidden,.skip,[aria-hidden=true],select,textarea,svg")) return false;
    if (getComputedStyle(e).visibility !== "visible") return false;
    for (let p = e; p && p !== root; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.opacity === "0") return false;
      if (s.display === "contents") continue;
      const r = p.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
    }
    return true;
  };
  const cuts = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const e = t.parentElement;
    if (!e || !t.data.trim()) continue;
    const box = boxOf(e);
    if (!box || cuts.has(box)) continue;
    const s = getComputedStyle(box);
    if (s.textOverflow !== "clip") continue;
    const scrolls = s.overflowX === "auto" || s.overflowX === "scroll";
    const table = e.closest("table,[role=table],[role=grid]");
    if (scrolls && !(table && box.contains(table))) continue;
    const left = box.getBoundingClientRect().left + box.clientLeft;
    range.selectNodeContents(t);
    const end = Math.max(...[...range.getClientRects()].filter((r) => r.width > 0).map((r) => r.right));
    if (end <= left + box.clientWidth + 1) continue;
    if (e.closest("[data-overflow-ok]") || (scrolls && box.classList.contains("scroll-cue")) || !shown(e)) continue;
    cuts.set(box, { kind: scrolls ? "table" : "clip", box: name(box), element: name(scrolls ? table : e), scrollWidth: Math.max(box.scrollWidth, Math.ceil(end - left)), clientWidth: box.clientWidth, text: t.data.trim().replace(/\\s+/g, " ").slice(0, 40) });
  }
  return {
    innerWidth,
    scrollWidth: root.scrollWidth,
    height: Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0),
    text: (document.body ? document.body.innerText : "").trim().length,
    past: past.slice(0, 8),
    clipped: clipped.slice(0, 8),
    cut: [...cuts.values()].slice(0, 8),
  };
})()`;

/** One check of a probe. */
export interface ProbeCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * This function wraps the code of a probe file into an expression. The code is the body of an async
 * function with these names:
 * - `check(name, ok, detail)` records a check,
 * - `wait(ms)` waits,
 * - `until(fn, ms)` waits until `fn()` gives a true value, at most `ms` (default 5000), and returns the value,
 * - `$(selector)` and `$$(selector)` find elements,
 * - `type(element, text)` writes the text into an input or a text area, with an `input` event,
 * - `click(element)` clicks an element, or the first element of a selector.
 * An exception stops the probe, and it counts as a failed check.
 */
export function probeExpression(code: string): string {
  return `(async () => {
  const __checks = [];
  const __text = (v) => { if (v === undefined) return undefined; if (typeof v === "string") return v; try { return JSON.stringify(v); } catch { return String(v); } };
  const check = (name, ok, detail) => { __checks.push({ name: String(name), ok: !!ok, ...(ok ? {} : { detail: __text(detail) }) }); return !!ok; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await wait(50); } };
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const __el = (e) => { const el = typeof e === "string" ? document.querySelector(e) : e; if (!el) throw new Error("no element: " + e); return el; };
  const type = (e, text) => { const el = __el(e); el.focus(); el.value = text; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
  const click = (e) => __el(e).click();
  try {
    await (async () => {
${code}
    })();
  } catch (e) {
    __checks.push({ name: "the probe runs to its end", ok: false, detail: String((e && e.stack) || e) });
  }
  return __checks;
})()`;
}
