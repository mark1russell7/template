/**
 * The build side of the shell of a site: a Vite plugin and its parts. Import this module from
 * `@mark1russell7/site-pages/vite`. It is for `vite.config.ts`, not for a browser.
 *
 * This module does not import Vite. The types of the plugin are the small part that it uses, so the
 * package keeps no dependency. A test examines that Vite accepts the plugin.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BuildInfo } from "./chrome.ts";
import { parseDataStamps, type DataStamps } from "./check/freshness.ts";
import { git, headCommit } from "./data/git.ts";
import { KPI_FILE, kpiFile, kpiText, type KpiInput } from "./data/kpi.ts";
import { renderDataStamp } from "./render/data-stamp.ts";

export type { BuildInfo } from "./chrome.ts";

/** The environment variables that this module reads. */
export type SiteEnv = Readonly<Record<string, string | undefined>>;

/** The options of `siteShell`. */
export interface SiteShellOptions {
  /** The `localStorage` key of the theme. Give the same key to `setupTheme` in the page. */
  readonly themeKey: string;
  /**
   * The file with the version for `__BUILD__`, relative to the folder of the site. The default is
   * `../package.json`. The value `false` gives a build with no version.
   */
  readonly packageFile?: string | false | undefined;
}

/** The value of `build.target` in a Vite config. */
export type SiteTarget = string | string[] | false;

/** The part of the Vite config that `siteShell` reads. */
export interface SiteShellConfigInput {
  readonly root?: string | undefined;
  readonly base?: string | undefined;
  readonly build?: { readonly target?: SiteTarget | undefined } | null | undefined;
}

/** The part of the Vite config that `siteShell` sets. Vite merges it into the config of the site. */
export interface SiteShellConfig {
  readonly base: string;
  readonly build: { readonly target: SiteTarget };
  readonly define: Readonly<Record<string, string>>;
}

/** A tag for the `head` of each HTML page. */
export interface SiteShellTag {
  readonly tag: "script";
  readonly children: string;
  readonly injectTo: "head";
}

/** The Vite plugin that `siteShell` gives. */
export interface SiteShellPlugin {
  readonly name: string;
  config(config: SiteShellConfigInput): SiteShellConfig;
  transformIndexHtml(): SiteShellTag[];
}

/** The input of `siteKpi`. Without a commit, the plugin takes `GITHUB_SHA`, else the head of the repository. */
export type SiteKpiInput = Omit<KpiInput, "commit"> & { readonly commit?: string | undefined };

/** The part of the context of a Rollup hook that `siteKpi` uses. */
export interface SiteKpiContext {
  emitFile(file: { type: "asset"; fileName: string; source: string }): string;
}

/** The Vite plugin that `siteKpi` gives. */
export interface SiteKpiPlugin {
  readonly name: string;
  readonly apply: "build";
  generateBundle(this: SiteKpiContext): void;
}

/**
 * This function gives the Vite plugin that adds `kpi.json` to the root of a built site. A fault in the data stops the build.
 *
 * @param input - The data, or a function that reads it at the time of the build.
 * @param env - The environment variables. A test gives its own.
 */
export function siteKpi(input: SiteKpiInput | (() => SiteKpiInput), env: SiteEnv = process.env): SiteKpiPlugin {
  return {
    name: "site-pages-kpi",
    apply: "build",
    generateBundle() {
      const data = typeof input === "function" ? input() : input;
      const commit = data.commit ?? env["GITHUB_SHA"] ?? headCommit(process.cwd()) ?? "";
      this.emitFile({ type: "asset", fileName: KPI_FILE, source: kpiText(kpiFile({ ...data, commit })) });
    },
  };
}

/** The file that `siteStamps` adds to the root of a built site. The input `data-stamps` of `reusable-pages.yml` names it. */
export const STAMPS_FILE = "data-stamps.json";

/** The mark in the HTML of a measured page. `siteStamps` replaces it with the stamp line of the page. */
export const STAMP_MARK = "<!-- data-stamp -->";

/** The part of the context of a page that `siteStamps` uses. */
export interface SiteStampsPage {
  /** The path of the page from the root of the site, with a `/` at the start. */
  readonly path: string;
}

/** The Vite plugin that `siteStamps` gives. */
export interface SiteStampsPlugin {
  readonly name: string;
  readonly apply: "build";
  readonly transformIndexHtml: { readonly order: "pre"; handler(html: string, page: SiteStampsPage): string };
  generateBundle(this: SiteKpiContext): void;
}

/**
 * This function gives the Vite plugin of the data stamps of a site. The plugin puts the stamp line in each measured page.
 * It also adds `data-stamps.json` to the root of the site. So the page and the freshness gate read one record.
 *
 * A fault stops the build. A fault is a bad stamp, a mark with no stamp or a stamp with no mark. A stamp of a page that the build does not hold is also a fault.
 *
 * @param input - The stamps, or a function that reads them at the time of the build.
 */
export function siteStamps(input: DataStamps | (() => DataStamps)): SiteStampsPlugin {
  let stamps: DataStamps | undefined;
  const read = (): DataStamps => {
    if (stamps !== undefined) return stamps;
    const parsed = parseDataStamps(typeof input === "function" ? input() : input);
    if (!parsed.ok) throw new Error(`The data stamps are not good:\n- ${parsed.faults.join("\n- ")}`);
    stamps = parsed.stamps;
    return stamps;
  };
  const seen = new Set<string>();
  return {
    name: "site-pages-stamps",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler(html, { path }) {
        const name = path.replace(/^\//, "");
        const stamp = read().pages.find((page) => page.page === name);
        const marked = html.includes(STAMP_MARK);
        if (stamp === undefined && marked) throw new Error(`The page ${name} has the mark of a data stamp, and the stamps have no page ${name}.`);
        if (stamp === undefined) return html;
        if (!marked) throw new Error(`The stamps have the page ${name}, and the page has no mark ${STAMP_MARK}.`);
        seen.add(name);
        return html.replace(STAMP_MARK, renderDataStamp(stamp));
      },
    },
    generateBundle() {
      const missing = read()
        .pages.map((page) => page.page)
        .filter((page) => !seen.has(page));
      if (missing.length > 0) throw new Error(`The stamps have pages that the build does not hold: ${missing.join(", ")}.`);
      this.emitFile({ type: "asset", fileName: STAMPS_FILE, source: `${JSON.stringify(read(), null, 2)}\n` });
    },
  };
}

/**
 * This function gives the script that sets the saved theme before the first paint, so a dark page
 * does not show white for a moment. The script reads `storageKey`, as `applyTheme` writes it.
 *
 * @remarks The text goes in an inline `script` element. Thus the function escapes each `<` of the
 * key, so a key cannot close the element.
 */
export function themeScript(storageKey: string): string {
  const key = JSON.stringify(storageKey).replaceAll("<", "\\u003c");
  return `try{const t=localStorage.getItem(${key});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch{}`;
}

/**
 * This function gives the `base` of Vite from `SITE_BASE`, with one `/` at the end. The Pages
 * workflow sets that variable to `/<name>`. A local build has no such variable, and gets `/`.
 */
export function siteBase(env: SiteEnv = process.env): string {
  const base = env["SITE_BASE"];
  return base ? `${base.replace(/\/$/, "")}/` : "/";
}

/**
 * This function gives the ISO time in UTC of the commit of a build. A count that a build reads from the source is
 * true at that commit, so this time is the time of its data. It is not the time of the build.
 *
 * @param env - The environment variables. The function takes `GITHUB_SHA`, else `HEAD`.
 * @param repoDir - The folder of the repository.
 * @throws When git cannot read the commit. A file with no time of its data is a fault.
 */
export function commitTime(env: SiteEnv = process.env, repoDir: string = process.cwd()): string {
  const ref = env["GITHUB_SHA"] ?? "HEAD";
  const time = git(repoDir, "show", "-s", "--format=%cI", ref)?.trim();
  if (!time) throw new Error(`git cannot read the commit ${ref}, so the data has no time.`);
  return new Date(time).toISOString();
}

/** A node of an HTML tree, with only the fields that `rehypeScrollCue` reads. */
export interface RehypeNode {
  readonly type: string;
  readonly tagName?: string;
  properties?: Record<string, unknown>;
  readonly children?: readonly RehypeNode[];
}

/**
 * This function gives the transformer of a rehype plugin. The transformer gives the class `scroll-cue` to each table and each code block (`pre`) of a Markdown page.
 * Each also gets a place in the tab order, so a keyboard can scroll it. A table also gets a label. A site that uses this plugin imports `scroll-cue.css`.
 * Markdown has no way to set the class of a table or a code block, so a page of a docs theme needs this plugin.
 */
export function rehypeScrollCue(): (tree: RehypeNode) => void {
  const visit = (node: RehypeNode): void => {
    if (node.type === "element" && (node.tagName === "table" || node.tagName === "pre")) {
      const properties = node.properties ?? {};
      const names = properties["className"];
      const list = Array.isArray(names) ? names : typeof names === "string" ? [names] : [];
      const classes = list.includes("scroll-cue") ? list : [...list, "scroll-cue"];
      // A pre has no role, so a label on it is not allowed. Its text is its content.
      const label = node.tagName === "table" ? { ariaLabel: "Table. It scrolls sideways on a narrow screen." } : {};
      node.properties = { ...properties, className: classes, tabIndex: properties["tabIndex"] ?? 0, ...label };
    }
    for (const child of node.children ?? []) visit(child);
  };
  return visit;
}

/** This function gives the data of a build. Outside CI, `GITHUB_SHA` is not set, and `sha` is `local`. */
export function buildInfo(version?: string, env: SiteEnv = process.env, now: Date = new Date()): BuildInfo {
  return { sha: (env["GITHUB_SHA"] ?? "local").slice(0, 7), date: now.toISOString().slice(0, 10), version };
}

/** This function reads the field `version` of a `package.json` file. */
function versionIn(file: string): string | undefined {
  return (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version;
}

/**
 * This function makes the Vite plugin of a site. The plugin does these four operations:
 *
 * - It sets `base` from `SITE_BASE`.
 * - It sets `build.target` to `es2022`.
 * - It defines `__BUILD__`, the value that `showBuild` shows.
 * - It adds `themeScript` to the `head` of each HTML page.
 *
 * A `base` or a `build.target` in the config of the site has priority. The other values of `build`
 * and `define` in that config stay, because Vite merges them.
 */
export function siteShell(options: SiteShellOptions): SiteShellPlugin {
  return {
    name: "site-pages-shell",
    config(config) {
      const packageFile = options.packageFile ?? "../package.json";
      const version = packageFile === false ? undefined : versionIn(resolve(config.root ?? ".", packageFile));
      return {
        base: config.base ?? siteBase(),
        build: { target: config.build?.target ?? "es2022" },
        define: { __BUILD__: JSON.stringify(buildInfo(version)) },
      };
    },
    transformIndexHtml() {
      return [{ tag: "script", children: themeScript(options.themeKey), injectTo: "head" }];
    },
  };
}
