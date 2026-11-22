/**
 * The Vite plugin of the offline shell. After the build, it writes the web manifest and the service worker into the
 * folder of the site. The worker keeps the built files, so the site opens with no network.
 *
 * This module does not import Vite. The types of the plugin are the small part that it uses.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  MANIFEST_FILE,
  offlineBase,
  offlineCacheName,
  precacheList,
  registerScript,
  serviceWorkerSource,
  SERVICE_WORKER_FILE,
  webManifest,
  type PrecacheList,
  type WebManifestOptions,
} from "./shell.ts";

/** The options of `siteOffline`. */
export interface SiteOfflineOptions {
  /** The fields of the web manifest. The value `false` writes no manifest and adds no manifest link. */
  readonly manifest: WebManifestOptions | false;
  /** The limit of the size of one kept file. The default is `MAX_FILE_BYTES`. */
  readonly maxFileBytes?: number | undefined;
  /** The patterns of the paths, from the root of the folder, that stay out of the cache. */
  readonly exclude?: readonly RegExp[] | undefined;
  /** This function gets the list of the kept files and of the files that stay out, after each build. */
  readonly onList?: ((list: PrecacheList & { readonly cache: string }) => void) | undefined;
}

/** The part of the resolved Vite config that `siteOffline` reads. */
export interface SiteOfflineConfig {
  readonly root: string;
  readonly base: string;
  /** The build options. With `write: false`, Vite writes no folder, so the plugin writes no file. */
  readonly build: { readonly outDir: string; readonly write?: boolean | undefined };
  readonly logger?: { info(message: string): void } | undefined;
}

/** A tag that `siteOffline` adds to each HTML page. */
export type SiteOfflineTag =
  | { readonly tag: "link"; readonly attrs: { readonly rel: "manifest"; readonly href: string }; readonly injectTo: "head" }
  | { readonly tag: "script"; readonly attrs: { readonly type: "module" }; readonly children: string; readonly injectTo: "body" };

/** The Vite plugin that `siteOffline` gives. */
export interface SiteOfflinePlugin {
  readonly name: string;
  readonly apply: "build";
  readonly enforce: "post";
  configResolved(config: SiteOfflineConfig): void;
  transformIndexHtml(): SiteOfflineTag[];
  closeBundle(): void;
}

/**
 * This function makes the Vite plugin of the offline shell. The plugin operates only in a build. It does these three operations:
 *
 * - It adds a manifest link and the script that registers the service worker to each HTML page.
 * - It writes `manifest.webmanifest` into the root of the built site.
 * - It writes `service-worker.js` into the root of the built site. The worker keeps each file of the folder, also the files of the public folder and of later plugins.
 *
 * Put the plugin last. A file that a step after the Vite build adds is not in the list of the worker.
 *
 * @throws Error at the start of the build when the base of the site is not a path. Examples are `./` and a URL of another origin.
 */
export function siteOffline(options: SiteOfflineOptions): SiteOfflinePlugin {
  let config: SiteOfflineConfig | undefined;
  const base = (): string => offlineBase(config?.base ?? "/");
  return {
    name: "site-pages-offline",
    apply: "build",
    enforce: "post",
    configResolved(resolved) {
      if (!resolved.base.startsWith("/")) throw new Error(`The offline shell needs a base that is a path from the root of the origin, not "${resolved.base}".`);
      config = resolved;
    },
    transformIndexHtml() {
      const tags: SiteOfflineTag[] = [];
      if (options.manifest !== false) tags.push({ tag: "link", attrs: { rel: "manifest", href: base() + MANIFEST_FILE }, injectTo: "head" });
      tags.push({ tag: "script", attrs: { type: "module" }, children: registerScript(base()), injectTo: "body" });
      return tags;
    },
    closeBundle() {
      if (config === undefined) throw new Error("The offline shell has no config: Vite did not call configResolved.");
      if (config.build.write === false) return;
      const folder = resolve(config.root, config.build.outDir);
      if (options.manifest !== false) writeFileSync(join(folder, MANIFEST_FILE), `${JSON.stringify(webManifest(options.manifest, base()), null, 2)}\n`);
      const files = readdirSync(folder, { recursive: true, encoding: "utf8" })
        .map((name) => join(folder, name))
        .filter((file) => statSync(file).isFile())
        .map((file) => ({ file, path: relative(folder, file).split(sep).join("/"), bytes: statSync(file).size }));
      const list = precacheList(files, { base: base(), maxFileBytes: options.maxFileBytes, exclude: options.exclude });
      const kept = new Set(list.urls);
      const contents = files.filter((file) => kept.has(base() + file.path)).map((file) => ({ url: base() + file.path, content: readFileSync(file.file) }));
      const cache = offlineCacheName(base(), contents);
      writeFileSync(join(folder, SERVICE_WORKER_FILE), serviceWorkerSource({ base: base(), cache, urls: list.urls }));
      config.logger?.info(`site-pages offline: the service worker keeps ${list.urls.length} files, and ${list.skipped.length} files stay out.`);
      options.onList?.({ ...list, cache });
    },
  };
}
