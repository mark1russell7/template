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
import { headCommit } from "./data/git.ts";
import { KPI_FILE, kpiFile, kpiText, type KpiInput } from "./data/kpi.ts";

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
