import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rovingIndex, Segmented, type Choice, type RovingAxis } from "./chrome.ts";
import { LagHudSegmented, SteLintSegmented } from "./chrome-roving.copies.ts";

// The package has no DOM for its tests. These fakes have only the members that the code uses.

let focused: FakeElement | null = null;

class FakeElement {
  readonly tagName: string;
  className = "";
  tabIndex = 0;
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  children: unknown[] = [];
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name.startsWith("data-")) this.dataset[name.slice(5)] = value;
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
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  focus(): void {
    focused = this;
  }
}

beforeEach(() => {
  focused = null;
  vi.stubGlobal("document", { createElement: (tag: string) => new FakeElement(tag) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Next = (key: string, index: number, count: number) => number | undefined;

/** The step maps and the wrap of the other copies, word for word. */
const COPIES: ReadonlyArray<{ readonly name: string; readonly axis: RovingAxis; readonly next: Next }> = [
  {
    // lag-hud and ste-lint (`Segmented`), optional `site/src/playground.ts` (`radios`)
    name: "lag-hud, ste-lint and optional",
    axis: "both",
    next: (key, index, count) => {
      const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[key];
      if (step === undefined) return undefined;
      return (index + step + count) % count;
    },
  },
  {
    // cue `site/src/playground.ts`, the tabs of the files
    name: "cue",
    axis: "horizontal",
    next: (key, index, count) => {
      const step = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[key];
      if (step === undefined) return undefined;
      return (index + step + count) % count;
    },
  },
  {
    // the search dialogs of AsyncBrowserContext and page-lifecycle-tracker, the active result
    name: "the search dialogs",
    axis: "vertical",
    next: (key, value, count) => {
      if (key !== "ArrowDown" && key !== "ArrowUp") return undefined;
      if (count === 0) return undefined;
      const offset = key === "ArrowDown" ? 1 : -1;
      return (value + offset + count) % count;
    },
  },
];

const KEYS = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End", "Enter", "a", " "];

describe("rovingIndex", () => {
  for (const copy of COPIES) {
    it(`gives the index of the copy of ${copy.name} for each key, index and count`, () => {
      for (let count = 1; count <= 6; count++)
        for (let index = 0; index < count; index++)
          for (const key of KEYS) expect(rovingIndex(key, index, count, copy.axis), `${key} ${index}/${count}`).toBe(copy.next(key, index, count));
    });
  }

  it("uses both axes when no axis is given", () => {
    expect(rovingIndex("ArrowDown", 0, 3)).toBe(1);
    expect(rovingIndex("ArrowLeft", 0, 3)).toBe(2);
  });

  it("gives undefined for an empty group", () => {
    expect(rovingIndex("ArrowRight", 0, 0)).toBeUndefined();
    expect(rovingIndex("ArrowUp", 0, 0, "vertical")).toBe(COPIES[2]!.next("ArrowUp", 0, 0));
  });

  it("goes to the first or the last item from an index outside the group", () => {
    // No copy gets such an index: the current value is one of the choices, and the active result starts at 0.
    // For a step back from -1, the copies give the item before the last. This function gives the last item.
    expect(rovingIndex("ArrowRight", -1, 4)).toBe(0);
    expect(rovingIndex("ArrowLeft", -1, 4)).toBe(3);
    expect(rovingIndex("ArrowLeft", 7, 4)).toBe(3);
    expect(rovingIndex("ArrowRight", Number.NaN, 4)).toBe(0);
    expect(rovingIndex("ArrowRight", 1.5, 4)).toBe(0);
  });
});

type Value = "a" | "b" | "c";
type Make = (container: HTMLElement, choices: readonly Choice<Value>[], current: Value, onChange: (value: Value) => void) => { readonly value: Value };

/** This function starts the same keys and clicks on a control, and gives the state after each step. */
function trace(make: Make, choices: readonly Choice<Value>[]): unknown[] {
  focused = null;
  const container = new FakeElement("div");
  const changes: string[] = [];
  const control = make(container as unknown as HTMLElement, choices, "b", (value) => changes.push(value));
  const buttons = container.children as FakeElement[];
  const state = (step: string, prevented?: boolean): unknown => ({
    step,
    prevented,
    value: control.value,
    checked: buttons.map((b) => b.getAttribute("aria-checked")),
    tabs: buttons.map((b) => b.tabIndex),
    focus: focused?.dataset["value"] ?? null,
    changes: [...changes],
  });
  const steps: unknown[] = [state("start"), buttons.map((b) => ({ tag: b.tagName, attributes: [...b.attributes], text: b.children }))];
  for (const key of ["ArrowRight", "ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "ArrowUp", "Home", "Enter", "x"]) {
    let prevented = false;
    container.dispatch("keydown", { key, preventDefault: () => (prevented = true) });
    steps.push(state(key, prevented));
  }
  for (const i of [0, 0, 2]) {
    buttons[i]!.dispatch("click", {});
    steps.push(state(`click ${i}`));
  }
  return steps;
}

const PLAIN: readonly Choice<Value>[] = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
  { value: "c", label: "C" },
];
const TITLED: readonly Choice<Value>[] = PLAIN.map((c) => ({ ...c, title: `The choice ${c.label}` }));

describe("Segmented", () => {
  const ours: Make = (container, choices, current, onChange) => new Segmented(container, choices, current, onChange);

  it("does what the copy of lag-hud does, with and without titles", () => {
    const theirs: Make = (container, choices, current, onChange) => new LagHudSegmented(container, choices, current, onChange);
    for (const choices of [PLAIN, TITLED]) expect(trace(ours, choices)).toEqual(trace(theirs, choices));
  });

  it("does what the copy of ste-lint does", () => {
    const theirs: Make = (container, choices, current, onChange) => new SteLintSegmented(container, choices, current, onChange);
    expect(trace(ours, PLAIN)).toEqual(trace(theirs, PLAIN));
  });

  it("sets a value with no event, as the copy of ste-lint does", () => {
    const run = (control: { set(value: Value): void; readonly value: Value }, container: FakeElement, changes: string[]): unknown => {
      control.set("c");
      return [control.value, (container.children as FakeElement[]).map((b) => [b.getAttribute("aria-checked"), b.tabIndex]), changes, focused];
    };
    const a = new FakeElement("div");
    const aChanges: string[] = [];
    const b = new FakeElement("div");
    const bChanges: string[] = [];
    const ourResult = run(new Segmented(a as unknown as HTMLElement, PLAIN, "a", (v) => aChanges.push(v)), a, aChanges);
    const theirResult = run(new SteLintSegmented(b as unknown as HTMLElement, PLAIN, "a", (v) => bChanges.push(v)), b, bChanges);
    expect(ourResult).toEqual(theirResult);
    expect(ourResult).toEqual(["c", [["false", -1], ["false", -1], ["true", 0]], [], null]);
  });

  it("moves only on the keys of its axis", () => {
    const container = new FakeElement("div");
    const control = new Segmented(container as unknown as HTMLElement, PLAIN, "a", () => {}, "horizontal");
    let prevented = false;
    container.dispatch("keydown", { key: "ArrowDown", preventDefault: () => (prevented = true) });
    expect([control.value, prevented]).toEqual(["a", false]);
    container.dispatch("keydown", { key: "ArrowLeft", preventDefault: () => (prevented = true) });
    expect([control.value, prevented, focused?.dataset["value"]]).toEqual(["c", true, "c"]);
  });

});
