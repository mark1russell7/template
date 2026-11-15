/**
 * The parts of a live demo on a page. The parts are a row of example buttons, the line of a verdict,
 * a field that a script fills and a text with marks. This module imports no Node.js module, so a site
 * can bundle it. Its style is in `@mark1russell7/site-pages/demo.css`.
 *
 * @packageDocumentation
 */
import { h, type Child } from "./chrome.ts";

/** An example of a demo: the label of its button and the value that a click gives. */
export type Example = readonly [label: string, value: string];

/**
 * This function fills a row with one button for each example, and gives the buttons. A click on a
 * button starts `pick` with the value of its example. When the value is not the label, the `title` of
 * the button is the value, so a pointer shows the full value.
 */
export function examples(row: HTMLElement, items: readonly Example[], pick: (value: string) => void): HTMLButtonElement[] {
  const buttons = items.map(([label, value]) => {
    const button = h("button", { type: "button", class: "sp-example", title: value === label ? undefined : value }, label);
    button.addEventListener("click", () => pick(value));
    return button;
  });
  row.replaceChildren(...buttons);
  return buttons;
}

/**
 * This function makes the line of a verdict: a mark, a title in bold and a reason. The mark is a check
 * for a pass and a cross for a fail. Its label tells the same to a screen reader, so the color is not
 * the only cue. The title has no punctuation of its own: give "Correct:" for a colon.
 */
export function verdict(pass: boolean, title: Child, ...reason: readonly Child[]): HTMLDivElement {
  return h(
    "div",
    { class: pass ? "sp-verdict sp-pass" : "sp-verdict sp-fail" },
    h("span", { class: "sp-mark", role: "img", "aria-label": pass ? "Pass" : "Fail" }, pass ? "✓" : "✕"),
    h("div", {}, h("b", {}, title), reason.length > 0 ? " " : null, ...reason),
  );
}

/**
 * This function sets the value of a field and sends an `input` event that bubbles, as typing does.
 * Thus an example button changes a field, and the demo of the field shows the new value.
 */
export function setField(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/** A part of a text. `markedText` puts a `mark` element on a part with `hit`. */
export interface TextPart {
  readonly text: string;
  readonly hit: boolean;
}

/**
 * This function divides a text into parts at ranges of code units, `[start, end)`. Each range gives a
 * part with `hit`, and the text between the ranges gives parts with no `hit`. The function sorts the
 * ranges, joins the ranges that overlap, and clamps each range to the text. Two ranges that touch stay
 * two parts. An empty range gives no part.
 */
export function partsAt(text: string, ranges: readonly (readonly [start: number, end: number])[]): TextPart[] {
  const clamp = (n: number): number => Math.min(Math.max(Math.trunc(n), 0), text.length);
  const sorted = ranges
    .map(([start, end]) => [clamp(start), clamp(end)] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const parts: TextPart[] = [];
  let at = 0;
  for (const [start, end] of sorted) {
    if (end <= at) continue;
    if (start < at) {
      const last = parts[parts.length - 1]!;
      parts[parts.length - 1] = { text: last.text + text.slice(at, end), hit: true };
    } else {
      if (start > at) parts.push({ text: text.slice(at, start), hit: false });
      parts.push({ text: text.slice(start, end), hit: true });
    }
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/**
 * This function divides a text into parts at each copy of `find`, from the start, with no overlap.
 * Each copy gives a part with `hit`. An empty `find` gives one part with no `hit`.
 */
export function partsOf(text: string, find: string): TextPart[] {
  if (find === "") return partsAt(text, []);
  const ranges: (readonly [number, number])[] = [];
  for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + find.length)) ranges.push([at, at + find.length]);
  return partsAt(text, ranges);
}

/**
 * This function shows a text in a `pre` box, with a `mark` element on each part with `hit`. The box is
 * a group with the label, so a screen reader names it. A text with no parts shows "(empty)".
 */
export function markedText(parts: readonly TextPart[], label: string): HTMLPreElement {
  const nodes = parts.filter((part) => part.text !== "").map((part) => (part.hit ? h("mark", {}, part.text) : part.text));
  return h("pre", { class: "sp-text", role: "group", "aria-label": label }, nodes.length > 0 ? nodes : h("span", { class: "sp-empty" }, "(empty)"));
}
