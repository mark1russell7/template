import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, byId, copyText, copyToClipboard, currentTheme, h, nextTheme, setupTheme, showBuild, THEMES } from "./chrome.ts";

// The package has no DOM for its tests. These fakes have only the members that the helpers use.

class FakeElement {
  readonly tagName: string;
  className = "";
  textContent: string | null = "";
  value = "";
  readonly attributes = new Map<string, string>();
  readonly children: unknown[] = [];
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Array<() => void>>();
  removed = false;
  selected = false;
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
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  click(): void {
    for (const listener of this.listeners.get("click") ?? []) listener();
  }
  select(): void {
    this.selected = true;
  }
  remove(): void {
    this.removed = true;
  }
}

class FakeStorage {
  readonly items = new Map<string, string>();
  refuse = false;
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.refuse) throw new Error("The storage is full.");
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    if (this.refuse) throw new Error("The storage is full.");
    this.items.delete(key);
  }
}

let created: FakeElement[];
let ids: Map<string, FakeElement>;
let dataset: Record<string, string>;
let storage: FakeStorage;
let execResult: boolean | "throw";

beforeEach(() => {
  created = [];
  ids = new Map();
  dataset = {};
  storage = new FakeStorage();
  execResult = true;
  const body = new FakeElement("body");
  vi.stubGlobal("document", {
    documentElement: { dataset },
    body,
    createElement: (tag: string) => {
      const el = new FakeElement(tag);
      created.push(el);
      return el;
    },
    getElementById: (id: string) => ids.get(id) ?? null,
    execCommand: () => {
      if (execResult === "throw") throw new Error("The command is not available.");
      return execResult;
    },
  });
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", globalThis);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const button = (text = ""): HTMLButtonElement => {
  const el = new FakeElement("button");
  el.textContent = text;
  return el as unknown as HTMLButtonElement;
};
const fake = (el: unknown): FakeElement => el as FakeElement;

describe("h", () => {
  it("sets the class, the attributes and the children", () => {
    const child = h("span", {}, "inner");
    const el = fake(h("a", { class: "link", href: "/x", tabindex: 0, hidden: true }, "text", child));
    expect(el.tagName).toBe("a");
    expect(el.className).toBe("link");
    expect(el.attributes.has("class")).toBe(false);
    expect(el.getAttribute("href")).toBe("/x");
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.getAttribute("hidden")).toBe("");
    expect(el.children).toEqual(["text", child]);
  });

  it("skips false, null and undefined attributes and children, and flattens arrays of children", () => {
    const el = fake(h("ul", { open: false, title: null, lang: undefined }, ["a", null, "b"], false, undefined, "c"));
    expect(el.attributes.size).toBe(0);
    expect(el.children).toEqual(["a", "b", "c"]);
  });
});

describe("byId", () => {
  it("gives the element with the ID", () => {
    const el = new FakeElement("div");
    ids.set("main", el);
    expect(byId("main")).toBe(el);
  });

  it("throws for a missing ID", () => {
    expect(() => byId("none")).toThrow('The page has no element "none".');
  });
});

describe("showBuild", () => {
  const shown = (build: Parameters<typeof showBuild>[1]): unknown[] => {
    const el = new FakeElement("p");
    showBuild(el as unknown as HTMLElement, build, "acme/site");
    return el.children;
  };

  it("shows the version, and links the commit to the repository", () => {
    const [start, commit, end] = shown({ sha: "abc1234", date: "2026-11-03", version: "1.2.3" });
    expect(start).toBe("Version 1.2.3, build ");
    expect(fake(commit).tagName).toBe("a");
    expect(fake(commit).getAttribute("href")).toBe("https://github.com/acme/site/commit/abc1234");
    expect(fake(commit).children).toEqual(["abc1234"]);
    expect(end).toBe(" of 2026-11-03");
  });

  it("starts with Build when the site has no version", () => {
    expect(shown({ sha: "abc1234", date: "2026-11-03" })[0]).toBe("Build ");
  });

  it("gives a local build no link", () => {
    expect(shown({ sha: "local", date: "2026-11-03", version: "1.2.3" })).toEqual(["Version 1.2.3, build ", "local", " of 2026-11-03"]);
  });
});

describe("the theme", () => {
  it("reads auto without the attribute and for an unknown value", () => {
    expect(currentTheme()).toBe("auto");
    dataset["theme"] = "blue";
    expect(currentTheme()).toBe("auto");
    dataset["theme"] = "dark";
    expect(currentTheme()).toBe("dark");
  });

  it("goes from auto to light, to dark and to auto again, and keeps the choice under the key", () => {
    expect(THEMES).toEqual(["auto", "light", "dark"]);
    expect(nextTheme("site-theme")).toBe("light");
    expect(dataset["theme"]).toBe("light");
    expect(storage.getItem("site-theme")).toBe("light");
    expect(nextTheme("site-theme")).toBe("dark");
    expect(storage.getItem("site-theme")).toBe("dark");
    expect(nextTheme("site-theme")).toBe("auto");
    expect("theme" in dataset).toBe(false);
    expect(storage.items.has("site-theme")).toBe(false);
  });

  it("changes the page when the storage refuses", () => {
    storage.refuse = true;
    applyTheme("dark", "site-theme");
    expect(dataset["theme"]).toBe("dark");
    applyTheme("auto", "site-theme");
    expect("theme" in dataset).toBe(false);
  });

  it("shows the current theme on the button, and each click sets the next theme", () => {
    dataset["theme"] = "light";
    const el = button();
    setupTheme(el, "site-theme");
    expect(el.textContent).toBe("Theme: light");
    expect(el.getAttribute("aria-label")).toBe("Color theme: light. Select to change.");
    fake(el).click();
    expect(el.textContent).toBe("Theme: dark");
    expect(el.getAttribute("aria-label")).toBe("Color theme: dark. Select to change.");
    expect(storage.getItem("site-theme")).toBe("dark");
    fake(el).click();
    expect(el.textContent).toBe("Theme: auto");
    expect(storage.items.size).toBe(0);
  });
});

describe("the copy", () => {
  it("uses the Clipboard API", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyToClipboard("pnpm add x")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("pnpm add x");
    expect(created).toHaveLength(0);
  });

  it("uses the old command when the Clipboard API is not available or refuses", async () => {
    vi.stubGlobal("navigator", {});
    expect(await copyToClipboard("one")).toBe(true);
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => Promise.reject(new Error("No permission.")) } });
    expect(await copyToClipboard("two")).toBe(true);
    expect(created.map((el) => [el.tagName, el.value, el.selected, el.removed])).toEqual([
      ["textarea", "one", true, true],
      ["textarea", "two", true, true],
    ]);
  });

  it("gives false when both ways fail", async () => {
    vi.stubGlobal("navigator", {});
    execResult = false;
    expect(await copyToClipboard("x")).toBe(false);
    execResult = "throw";
    expect(await copyToClipboard("x")).toBe(false);
    expect(created.every((el) => el.removed)).toBe(true);
  });

  it("tells the result on the button for 1600 ms, then shows the label again", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => {} } });
    const el = button("Copy");
    expect(await copyText(el, "x")).toBe(true);
    expect(el.textContent).toBe("Copied");
    vi.advanceTimersByTime(1599);
    expect(el.textContent).toBe("Copied");
    vi.advanceTimersByTime(1);
    expect(el.textContent).toBe("Copy");
  });

  it("tells a failure, with the texts and the time of the options", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {});
    execResult = false;
    const el = button("Copy");
    expect(await copyText(el, "x", { failed: "No copy", ms: 500 })).toBe(false);
    expect(el.textContent).toBe("No copy");
    vi.advanceTimersByTime(500);
    expect(el.textContent).toBe("Copy");
  });
});

describe("the chrome entry", () => {
  const root = new URL("../", import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
    exports: Record<string, unknown>;
    publishConfig: { exports: Record<string, unknown> };
  };

  it("is an entry of the package, in the source and in the build", () => {
    expect(pkg.exports["./chrome"]).toBe("./src/chrome.ts");
    expect(pkg.publishConfig.exports["./chrome"]).toEqual({ types: "./build/chrome.d.ts", import: "./build/chrome.js", default: "./build/chrome.js" });
  });

  it("imports no module, so a site can bundle it for the browser", () => {
    const source = readFileSync(new URL("src/chrome.ts", root), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bfrom\s+["']/);
  });
});
