/// <reference lib="dom" />
/**
 * The small helpers of a page in the browser: the element helper, the element lookup, the theme
 * button, the copy button and the build stamp. This module imports no Node.js module, so a site can
 * bundle it. Import it from `@mark1russell7/site-pages/chrome`, because the package root also has
 * Node.js code.
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
