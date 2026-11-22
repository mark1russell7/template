/**
 * The parts of the offline shell of a built site, as pure functions. They give the list of the files that the service worker
 * keeps and the name of its cache. They also give the source of the worker, the web manifest and the script that registers the worker.
 *
 * The service worker keeps only the built files. It keeps no data of the site.
 */

import { createHash } from "node:crypto";
import { FALLBACK_HEADER } from "../check/offline-header.ts";

export { FALLBACK_HEADER };

/** The file of the service worker, in the root of the built site. */
export const SERVICE_WORKER_FILE = "service-worker.js";

/** The file of the web manifest, in the root of the built site. */
export const MANIFEST_FILE = "manifest.webmanifest";

/** The default limit of the size of one kept file: 10 MiB. A larger file stays out of the cache. */
export const MAX_FILE_BYTES: number = 10 * 1024 * 1024;

/** One file of the built site: its path from the root of the folder, with `/`, and its size. */
export interface OfflineFile {
  readonly path: string;
  readonly bytes: number;
}

/** The options of `precacheList`. */
export interface PrecacheOptions {
  /** The path of the site home, for example `/` or `/client/`. */
  readonly base: string;
  /** The limit of the size of one kept file. The default is `MAX_FILE_BYTES`. */
  readonly maxFileBytes?: number | undefined;
  /** The patterns of the paths that stay out of the cache. A pattern examines the path from the root, for example `media/big.mp4`. */
  readonly exclude?: readonly RegExp[] | undefined;
}

/** A file that stays out of the cache, and the reason. */
export interface SkippedFile {
  readonly path: string;
  readonly reason: string;
}

/** The result of `precacheList`: the URL paths that the worker keeps, in order, and the files that stay out. */
export interface PrecacheList {
  readonly urls: readonly string[];
  readonly skipped: readonly SkippedFile[];
}

/** This function gives the base with one `/` at the start and one `/` at the end. */
export function offlineBase(base: string): string {
  // A loop, not a regular expression: the time of /\/+$/ grows as the square of the count of "/" (CodeQL js/polynomial-redos).
  let start = 0;
  let end = base.length;
  while (start < end && base[start] === "/") start += 1;
  while (end > start && base[end - 1] === "/") end -= 1;
  const inner = base.slice(start, end);
  return inner === "" ? "/" : `/${inner}/`;
}

/**
 * This function gives the list of the files that the service worker keeps. The list has the URL path of each file, in
 * order. These files stay out: a source map, the worker, and a file with a dot at the start of a name in its path.
 * A file larger than the limit and a file that a pattern of `exclude` matches also stay out.
 *
 * @throws RangeError when a path is absolute or goes up a folder, or when the limit is not a positive number
 */
export function precacheList(files: readonly OfflineFile[], options: PrecacheOptions): PrecacheList {
  const base = offlineBase(options.base);
  const limit = options.maxFileBytes ?? MAX_FILE_BYTES;
  if (!(limit > 0)) throw new RangeError("The limit of the size of a file is not a positive number");
  const urls: string[] = [];
  const skipped: SkippedFile[] = [];
  for (const file of files) {
    const path = file.path.replaceAll("\\", "/");
    const parts = path.split("/");
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || parts.includes("..")) throw new RangeError(`The path ${path} is not a path in the folder of the site`);
    const reason =
      path === SERVICE_WORKER_FILE
        ? "the service worker"
        : path.endsWith(".map")
          ? "a source map"
          : parts.some((part) => part.startsWith("."))
            ? "a name that starts with a dot"
            : file.bytes > limit
              ? `larger than ${limit} bytes`
              : options.exclude?.some((pattern) => pattern.test(path))
                ? "a pattern of exclude"
                : undefined;
    if (reason === undefined) urls.push(base + path);
    else skipped.push({ path, reason });
  }
  urls.sort();
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { urls, skipped };
}

/**
 * This function gives the name of the cache of a build. The name has a prefix with the base. Then it has the first 16
 * hexadecimal digits of the SHA-256 hash of the kept files. A change of a kept file gives a new name. The worker of the new build then removes the old
 * cache of the same base, and only that cache.
 */
export function offlineCacheName(base: string, files: readonly { readonly url: string; readonly content: Uint8Array | string }[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))) {
    hash.update(file.url);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return `${cachePrefix(base)}${hash.digest("hex").slice(0, 16)}`;
}

/** This function gives the prefix of the names of the caches of a base. The worker removes an old cache only when it has this prefix. */
export function cachePrefix(base: string): string {
  return `site-offline ${offlineBase(base)} `;
}

/** The input of `serviceWorkerSource`. */
export interface ServiceWorkerInput {
  /** The path of the site home, for example `/` or `/client/`. */
  readonly base: string;
  /** The name of the cache, from `offlineCacheName`. */
  readonly cache: string;
  /** The URL paths that the worker keeps, from `precacheList`. */
  readonly urls: readonly string[];
}

/**
 * This function gives the source of the service worker. The worker keeps each URL of the list when it installs. Then it
 * answers a request of a kept URL from the cache. A page of a folder (a path that ends with `/`) is its `index.html`.
 *
 * A navigation to a URL that is not kept goes to the network. With no network, it gets the home page from the cache, with the
 * header `FALLBACK_HEADER`. The worker does not answer other requests, so they go to the network as usual.
 *
 * @throws RangeError when the cache name does not start with the prefix of the base
 */
export function serviceWorkerSource(input: ServiceWorkerInput): string {
  const base = offlineBase(input.base);
  const prefix = cachePrefix(base);
  if (!input.cache.startsWith(prefix)) throw new RangeError(`The cache name does not start with "${prefix}"`);
  const start = `${base}index.html`;
  return `// The service worker of the offline copy of this site. @mark1russell7/site-pages/offline made it at the build.
const CACHE = ${JSON.stringify(input.cache)};
const PREFIX = ${JSON.stringify(prefix)};
const START = ${JSON.stringify(start)};
const URLS = ${JSON.stringify(input.urls)};
const KEPT = new Set(URLS);
const FALLBACK = ${JSON.stringify(FALLBACK_HEADER)};

function keyOf(url) {
  return url.pathname.endsWith("/") ? url.pathname + "index.html" : url.pathname;
}

function marked(response) {
  const headers = new Headers(response.headers);
  headers.set(FALLBACK, "fallback");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(URLS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith(PREFIX) && name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const key = keyOf(url);
  if (KEPT.has(key)) {
    event.respondWith(caches.open(CACHE).then((cache) => cache.match(key)).then((kept) => kept || fetch(request)));
  } else if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.open(CACHE).then((cache) => cache.match(START)).then((kept) => (kept ? marked(kept) : Response.error()))));
  }
});
`;
}

/** An icon of the web manifest. */
export interface OfflineIcon {
  /** The URL of the icon. A path with no `/` at the start is a path from the site home. */
  readonly src: string;
  /** The sizes, for example `192x192`, or `any` for an SVG file. */
  readonly sizes: string;
  /** The media type, for example `image/png` or `image/svg+xml`. */
  readonly type: string;
  readonly purpose?: "any" | "maskable" | "monochrome" | undefined;
}

/** The options of `webManifest`. */
export interface WebManifestOptions {
  /** The name of the app on the screen of the phone. */
  readonly name: string;
  /** The short name, under the icon. The default is the name. */
  readonly shortName?: string | undefined;
  readonly description?: string | undefined;
  /** The color of the bar of the app, a CSS color. */
  readonly themeColor?: string | undefined;
  /** The color of the screen before the first paint, a CSS color. */
  readonly backgroundColor?: string | undefined;
  readonly icons?: readonly OfflineIcon[] | undefined;
}

/** The web manifest of a site, as a JSON value. */
export interface WebManifest {
  readonly name: string;
  readonly short_name: string;
  readonly description?: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: "standalone";
  readonly theme_color?: string;
  readonly background_color?: string;
  readonly icons: readonly OfflineIcon[];
}

/**
 * This function gives the web manifest of the site: the app starts at the site home, and its scope is the site home.
 *
 * @throws RangeError when the name is empty
 */
export function webManifest(options: WebManifestOptions, base: string): WebManifest {
  const home = offlineBase(base);
  if (options.name.trim() === "") throw new RangeError("The web manifest has no name");
  const icons = (options.icons ?? []).map((icon) => ({ ...icon, src: /^(\/|[a-z][a-z0-9+.-]*:)/i.test(icon.src) ? icon.src : home + icon.src }));
  return {
    name: options.name,
    short_name: options.shortName ?? options.name,
    ...(options.description === undefined ? {} : { description: options.description }),
    start_url: home,
    scope: home,
    display: "standalone",
    ...(options.themeColor === undefined ? {} : { theme_color: options.themeColor }),
    ...(options.backgroundColor === undefined ? {} : { background_color: options.backgroundColor }),
    icons,
  };
}

/**
 * This function gives the script that registers the service worker, for a `<script type="module">` of a page. A failure
 * goes to `console.warn`, because a browser with no service worker shows the page as usual.
 */
export function registerScript(base: string): string {
  const home = offlineBase(base);
  return `if ("serviceWorker" in navigator) navigator.serviceWorker.register(${JSON.stringify(home + SERVICE_WORKER_FILE)}, { scope: ${JSON.stringify(home)} }).catch((error) => console.warn("The offline copy of the site is not ready:", error));`;
}
