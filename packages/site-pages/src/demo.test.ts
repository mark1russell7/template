import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { examples, markedText, setField, verdict, type TextPart } from "./demo.ts";

// The package has no DOM for its tests. This fake has only the members that the parts use.

class FakeElement {
  readonly tagName: string;
  className = "";
  value = "";
  readonly attributes = new Map<string, string>();
  children: unknown[] = [];
  readonly listeners = new Map<string, Array<(event?: Event) => void>>();
  readonly events: Event[] = [];
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  append(...nodes: unknown[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: unknown[]): void {
    this.children = nodes;
  }
  addEventListener(type: string, listener: (event?: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  click(): void {
    for (const listener of this.listeners.get("click") ?? []) listener();
  }
  dispatchEvent(event: Event): boolean {
    this.events.push(event);
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

beforeEach(() => {
  vi.stubGlobal("document", { createElement: (tag: string) => new FakeElement(tag) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const fake = (el: unknown): FakeElement => el as FakeElement;

/** This function gives the text of a fake element and its children. */
const textOf = (node: unknown): string => (typeof node === "string" ? node : fake(node).children.map(textOf).join(""));

describe("examples", () => {
  it("fills the row with one button for each example, and a click gives the value", () => {
    const row = new FakeElement("div");
    row.children = ["old"];
    const picked: string[] = [];
    const buttons = examples(row as unknown as HTMLElement, [["A tag", "<b>hi</b>"], ["plain", "plain"]], (value) => picked.push(value));
    expect(row.children).toEqual(buttons);
    expect(buttons.map((b) => [fake(b).tagName, fake(b).className, fake(b).getAttribute("type"), textOf(b)])).toEqual([
      ["button", "sp-example", "button", "A tag"],
      ["button", "sp-example", "button", "plain"],
    ]);
    fake(buttons[1]).click();
    fake(buttons[0]).click();
    expect(picked).toEqual(["plain", "<b>hi</b>"]);
  });

  it("gives a title only when the value is not the label", () => {
    const row = new FakeElement("div");
    const buttons = examples(row as unknown as HTMLElement, [["A tag", "<b>"], ["same", "same"]], () => undefined);
    expect(buttons.map((b) => fake(b).getAttribute("title"))).toEqual(["<b>", null]);
  });
});

describe("verdict", () => {
  it("makes a pass with a check, a label and the class sp-pass", () => {
    const line = fake(verdict(true, "Correct:", "It finds 1 match."));
    expect(line.className).toBe("sp-verdict sp-pass");
    const [mark, body] = line.children.map(fake);
    expect([mark!.className, mark!.getAttribute("role"), mark!.getAttribute("aria-label"), textOf(mark)]).toEqual(["sp-mark", "img", "Pass", "✓"]);
    expect(textOf(body)).toBe("Correct: It finds 1 match.");
    expect(fake(body!.children[0]).tagName).toBe("b");
  });

  it("makes a fail with a cross, and keeps the nodes of the reason", () => {
    const code = new FakeElement("code");
    code.append("11=2");
    const line = fake(verdict(false, "Wrong:", "It finds ", code as unknown as Node, "."));
    expect(line.className).toBe("sp-verdict sp-fail");
    expect(fake(line.children[0]).getAttribute("aria-label")).toBe("Fail");
    expect(textOf(line.children[1])).toBe("Wrong: It finds 11=2.");
  });

  it("adds no space after a title with no reason", () => {
    expect(textOf(fake(verdict(true, "Whole")).children[1])).toBe("Whole");
  });
});

describe("setField", () => {
  it("sets the value and sends an input event that bubbles", () => {
    const field = new FakeElement("input");
    const seen: string[] = [];
    field.addEventListener("input", () => seen.push(field.value));
    setField(field as unknown as HTMLInputElement, "1+1=2?");
    expect(seen).toEqual(["1+1=2?"]);
    expect(field.events.map((event) => [event.type, event.bubbles])).toEqual([["input", true]]);
  });
});

describe("markedText", () => {
  it("puts a mark element on each hit, in a labeled group", () => {
    const parts: TextPart[] = [
      { text: "Is ", hit: false },
      { text: "1+1=2?", hit: true },
    ];
    const box = fake(markedText(parts, "The matches"));
    expect([box.tagName, box.className, box.getAttribute("role"), box.getAttribute("aria-label")]).toEqual(["pre", "sp-text", "group", "The matches"]);
    expect(box.children[0]).toBe("Is ");
    expect([fake(box.children[1]).tagName, textOf(box.children[1])]).toEqual(["mark", "1+1=2?"]);
  });

  it("shows (empty) for a text with no parts", () => {
    const box = fake(markedText([], "The log"));
    expect([fake(box.children[0]).className, textOf(box)]).toEqual(["sp-empty", "(empty)"]);
  });
});

// The style sheet of the parts.

const root = new URL("../", import.meta.url);
const css = readFileSync(new URL("styles/demo.css", root), "utf8");

/** This function gives the declarations of the first rule with exactly this selector. */
function declarations(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const lines = css.slice(start + selector.length + 2, css.indexOf("}", start)).split("\n");
  return new Map(lines.map((line) => line.trim()).filter(Boolean).map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2, -1)]));
}

/** This function gives the relative luminance of a color of the form #rrggbb, by the formula of WCAG 2. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const v = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** This function gives the contrast of two colors, by the formula of WCAG 2. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("the style of the parts", () => {
  const light = declarations(":root");
  const dark = declarations(':root[data-theme="dark"]');
  const darkMedia = declarations('  :root:not([data-theme="light"])');

  it("has a dark value for each token, the same in the two dark rules", () => {
    expect([...light.keys()].length).toBeGreaterThan(10);
    for (const [name, value] of light) {
      expect(dark.get(name), name).toBeDefined();
      expect(dark.get(name), name).not.toBe(value);
    }
    expect(darkMedia).toEqual(dark);
  });

  it("keeps a contrast of 4.5 or more for each text on its background, in light and in dark", () => {
    for (const theme of [light, dark]) {
      const t = (name: string): string => theme.get(`--sp-${name}`)!;
      expect(contrast(t("demo-base-ink"), t("pass-bg"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t("demo-base-ink"), t("fail-bg"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t("demo-base-ink"), t("hit"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t("demo-base-ink"), t("demo-base-sunken"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t("demo-base-muted"), t("demo-base-surface"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t("pass-bg"), t("pass"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t("fail-bg"), t("fail"))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the input of a field below its label when a field next to it is taller", () => {
    expect(declarations(".sp-field").get("align-content")).toBe("start");
  });

  it("is in the exports of the source and of the package", () => {
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
      exports: Record<string, unknown>;
      publishConfig: { exports: Record<string, unknown> };
    };
    expect(pkg.exports["./demo.css"]).toBe("./styles/demo.css");
    expect(pkg.publishConfig.exports["./demo.css"]).toBe("./styles/demo.css");
    expect(pkg.exports["./demo"]).toBe("./src/demo.ts");
    expect(existsSync(new URL("styles/demo.css", root))).toBe(true);
  });
});
