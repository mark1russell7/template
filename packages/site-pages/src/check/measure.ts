/**
 * The measurements that the `check` command makes in the page. Each is a string of JavaScript that
 * the browser evaluates, so the code can use only the APIs of the page.
 */

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
}

/**
 * This expression measures the page. An element counts as past the edge when its right side is
 * more than half a pixel past the width of the document. These elements do not count:
 * - an element in a container that scrolls or clips (`overflow-x` other than `visible`, below `body`),
 * - an element of zero size, a hidden element, or a fixed element that is fully past the edge (a closed drawer),
 * - an element in `.sr`, `.sr-only`, `.visually-hidden` or `.skip` (text for screen readers and skip links),
 * - an element in a `pre`, other than the `pre` itself.
 * Of a chain of elements past the edge, only the outermost one counts.
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
  return {
    innerWidth,
    scrollWidth: root.scrollWidth,
    height: Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0),
    text: (document.body ? document.body.innerText : "").trim().length,
    past: past.slice(0, 8),
    clipped: clipped.slice(0, 8),
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
