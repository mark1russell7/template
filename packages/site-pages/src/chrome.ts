/// <reference lib="dom" />
/**
 * The small helpers of a page in the browser: the element helper, the element lookup, the theme
 * button, the copy button and the build stamp. It also has a radio group with one focus stop.
 * This module imports no Node.js module, so a site can bundle it. Import it from
 * `@mark1russell7/site-pages/chrome`, because the package root also has Node.js code.
 */

/** A child of `h`: a node or a text. The values `null`, `undefined` and `false` give no child. */
export type Child = Node | string | null | undefined | false;

/** The value of an attribute of `h`. The value `true` gives an empty attribute. */
export type AttributeValue = string | number | boolean | null | undefined;

/**
 * This function makes an element with attributes and children. An attribute with the value
 * `false`, `null` or `undefined` is not set. The attribute `class` sets the class name.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, AttributeValue>> = {},
  ...children: readonly (Child | readonly Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (name === "class") el.className = String(value);
    else el.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

/**
 * This function gives the element with the ID. The page has each ID that the code asks for. Thus
 * a missing ID is an error of the page, and the function throws an `Error`.
 */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`The page has no element "${id}".`);
  return el as T;
}

/** The themes of the theme button, in the sequence of the clicks. `auto` follows the setting of the system. */
export const THEMES: readonly ["auto", "light", "dark"] = ["auto", "light", "dark"];

/** A theme of the page. */
export type Theme = (typeof THEMES)[number];

/**
 * This function gives the theme of the page from the attribute `data-theme` of the `html` element.
 * Without the attribute, or with another value, the theme is `auto`.
 */
export function currentTheme(): Theme {
  const theme = document.documentElement.dataset["theme"];
  return theme === "light" || theme === "dark" ? theme : "auto";
}

/**
 * This function sets the theme of the page, and keeps it in `localStorage` under `storageKey`.
 * The theme `auto` removes the attribute `data-theme` and the stored value.
 */
export function applyTheme(theme: Theme, storageKey: string): void {
  const root = document.documentElement;
  if (theme === "auto") delete root.dataset["theme"];
  else root.dataset["theme"] = theme;
  try {
    if (theme === "auto") localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, theme);
  } catch {
    // A browser with no storage keeps the theme until the page closes.
  }
}

/** This function sets the next theme after the current theme (auto, light, dark, auto), and gives it. */
export function nextTheme(storageKey: string): Theme {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length] ?? "auto";
  applyTheme(next, storageKey);
  return next;
}

/**
 * This function makes a theme button. Each click sets the next theme. The text of the button is
 * "Theme: auto", "Theme: light" or "Theme: dark", and its `aria-label` tells the same theme.
 *
 * @remarks Before the first paint, a script in the `head` of the page reads `storageKey` from
 * `localStorage` and sets `data-theme`. Thus a dark page does not show white for a moment. The
 * plugin `siteShell` of the entry `./vite` adds that script.
 */
export function setupTheme(button: HTMLButtonElement, storageKey: string): void {
  const show = (theme: Theme): void => {
    button.textContent = `Theme: ${theme}`;
    button.setAttribute("aria-label", `Color theme: ${theme}. Select to change.`);
  };
  show(currentTheme());
  button.addEventListener("click", () => show(nextTheme(storageKey)));
}

/** The data of a build: `siteShell` writes it, and `showBuild` shows it. */
export interface BuildInfo {
  /** The first 7 characters of the commit, or `local` for a build outside CI. */
  readonly sha: string;
  /** The date of the build, as `YYYY-MM-DD`. */
  readonly date: string;
  /** The version of the package. A site without a version does not set it. */
  readonly version?: string | undefined;
}

/**
 * This function shows the version and the build of the site in an element. The text is "Version
 * 1.2.3, build abc1234 of 2026-11-03", and the commit is a link to GitHub. A build with no version
 * starts with "Build", and a local build has no link.
 *
 * @param repository - The repository as "owner/name".
 */
export function showBuild(element: HTMLElement, build: BuildInfo, repository: string): void {
  const commit = build.sha === "local" ? "local" : h("a", { href: `https://github.com/${repository}/commit/${build.sha}` }, build.sha);
  element.append(build.version === undefined ? "Build " : `Version ${build.version}, build `, commit, ` of ${build.date}`);
}

/**
 * This function copies a text to the clipboard, and gives `true` when the copy is done. It uses
 * the Clipboard API. When that API is not available or refuses, it uses `document.execCommand`.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // An insecure page has no Clipboard API, and a browser can refuse the copy. The old command is the fallback.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try {
      return document.execCommand("copy");
    } finally {
      area.remove();
    }
  } catch {
    return false;
  }
}

/** The options of `copyText`. */
export interface CopyTextOptions {
  /** The text of the button after a copy. The default is "Copied". */
  readonly copied?: string;
  /** The text of the button after a failure. The default is "Copy failed". */
  readonly failed?: string;
  /** The time in milliseconds until the button shows its label again. The default is 1600. */
  readonly ms?: number;
}

/**
 * This function copies a text to the clipboard with `copyToClipboard`. The button tells the result
 * for a short time, then it shows its label again. The function gives the result of the copy.
 */
export async function copyText(button: HTMLButtonElement, text: string, options: CopyTextOptions = {}): Promise<boolean> {
  const label = button.textContent;
  const ok = await copyToClipboard(text);
  button.textContent = ok ? (options.copied ?? "Copied") : (options.failed ?? "Copy failed");
  window.setTimeout(() => {
    button.textContent = label;
  }, options.ms ?? 1600);
  return ok;
}

/** The arrow keys of a group: `horizontal` (Left and Right), `vertical` (Up and Down) or `both`. */
/** The arrow keys of a group: left and right, up and down, or the four arrows. */
export type RovingAxis = "horizontal" | "vertical" | "both";

const ROVING_STEPS: Readonly<Record<RovingAxis, Readonly<Record<string, number>>>> = {
  horizontal: { ArrowRight: 1, ArrowLeft: -1 },
  vertical: { ArrowDown: 1, ArrowUp: -1 },
  both: { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 },
};

/**
 * This function gives the index of the next item after an arrow key, in a group of `count` items. The index
 * wraps at each end. A key that is not an arrow of the axis gives `undefined`, and so does an empty group. An
 * index outside the group goes to the first item on a step forward, and to the last item on a step back.
 */
export function rovingIndex(key: string, index: number, count: number, axis: RovingAxis = "both"): number | undefined {
  const step = ROVING_STEPS[axis][key];
  if (step === undefined || count <= 0) return undefined;
  if (!Number.isInteger(index) || index < 0 || index >= count) return step > 0 ? 0 : count - 1;
  return (index + step + count) % count;
}

/** A choice of a `Segmented` control. */
export interface Choice<T extends string> {
  /** The value of the choice. */
  readonly value: T;
  /** The text of the button. */
  readonly label: string;
  /** The tooltip and the accessible name of the button. Without it, the button has neither. */
  readonly title?: string;
}

/**
 * A group of radio buttons with one focus stop. The selected button has `tabIndex` 0, and the others have -1.
 * The arrow keys select the next button, with a wrap at each end, and move the focus to it. The container keeps
 * its own role and label, for example `role="radiogroup"` in the HTML.
 */
export class Segmented<T extends string> {
  private readonly buttons: readonly HTMLButtonElement[];
  private readonly choices: readonly Choice<T>[];
  private readonly onChange: (value: T) => void;
  private current: T;

  /**
   * This constructor puts one button for each choice into the container, in place of its children. The listener
   * gets each change by a click or a key, and no event for the choice that is already selected.
   */
  constructor(container: HTMLElement, choices: readonly Choice<T>[], current: T, onChange: (value: T) => void, axis: RovingAxis = "both") {
    this.choices = choices;
    this.current = current;
    this.onChange = onChange;
    this.buttons = choices.map((choice) => {
      const button = h(
        "button",
        { type: "button", role: "radio", "data-value": choice.value, title: choice.title, "aria-label": choice.title },
        choice.label,
      );
      button.addEventListener("click", () => this.choose(choice.value, false));
      return button;
    });
    container.replaceChildren(...this.buttons);
    container.addEventListener("keydown", (event) => {
      const index = this.choices.findIndex((c) => c.value === this.current);
      const next = rovingIndex(event.key, index, this.choices.length, axis);
      if (next === undefined) return;
      event.preventDefault();
      this.choose(this.choices[next]!.value, true);
    });
    this.show();
  }

  /** The value of the control. */
  get value(): T {
    return this.current;
  }

  /** This function sets the value. The listener gets no event. */
  set(value: T): void {
    this.current = value;
    this.show();
  }

  private choose(value: T, focus: boolean): void {
    const changed = value !== this.current;
    this.set(value);
    if (focus) this.buttons[this.choices.findIndex((c) => c.value === value)]?.focus();
    if (changed) this.onChange(value);
  }

  private show(): void {
    this.choices.forEach((choice, i) => {
      const button = this.buttons[i]!;
      const on = choice.value === this.current;
      button.setAttribute("aria-checked", String(on));
      button.tabIndex = on ? 0 : -1;
    });
  }
}
