/**
 * The offline shell of a built site. Import this module from `@mark1russell7/site-pages/offline` in `vite.config.ts`.
 * It is for Node.js, not for a browser.
 *
 * - `siteOffline` is the Vite plugin. It writes the web manifest and a service worker that keeps the built files.
 * - The pure parts are also here: the list of the kept files, the name of the cache, the source of the worker and the manifest.
 * - `site-pages check --offline` is the gate. It opens the pages of the built site with the network off.
 *
 * The worker keeps only the built files. The data of a site goes offline through its own store, not through this module.
 */

export { siteOffline, type SiteOfflineConfig, type SiteOfflineOptions, type SiteOfflinePlugin, type SiteOfflineTag } from "./plugin.ts";
export {
  cachePrefix,
  FALLBACK_HEADER,
  MANIFEST_FILE,
  MAX_FILE_BYTES,
  offlineBase,
  offlineCacheName,
  precacheList,
  registerScript,
  SERVICE_WORKER_FILE,
  serviceWorkerSource,
  webManifest,
  type OfflineFile,
  type OfflineIcon,
  type PrecacheList,
  type PrecacheOptions,
  type ServiceWorkerInput,
  type SkippedFile,
  type WebManifest,
  type WebManifestOptions,
} from "./shell.ts";
