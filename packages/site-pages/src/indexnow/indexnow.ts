/**
 * The IndexNow step of a deploy: it tells the search engines of the IndexNow protocol (Bing, Yandex, Seznam, Naver
 * and others) about the pages of a site. The URLs come from the deployed `sitemap.xml`.
 *
 * The key is public by design. An engine reads `<key>.txt` from the site to confirm that the request comes from the
 * owner of the site. The files of this folder import only Node.js and each other.
 */
import { parseArgs } from "node:util";

/** The endpoint that sends one request to each engine of the protocol. */
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/** The protocol accepts at most this number of URLs in one request. */
export const INDEXNOW_MAX_URLS = 10_000;

/** A key of the protocol: 8 to 128 characters, each a letter, a digit or a dash. */
export const INDEXNOW_KEY: RegExp = /^[A-Za-z0-9-]{8,128}$/;

/** The request body of the protocol. */
export interface IndexNowRequest {
  readonly host: string;
  readonly key: string;
  readonly keyLocation: string;
  readonly urlList: readonly string[];
}

/** This function gives the URLs of the `<loc>` elements of a sitemap, with the XML entities decoded. */
export function sitemapUrls(xml: string): string[] {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) =>
    (match[1] ?? "").replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => entities[name] ?? ""),
  );
}

/** This function gives the location of the key file of a site. */
export function keyLocationOf(site: string, key: string): string {
  return new URL(`${key}.txt`, site).href;
}

/**
 * This function gives the request for the pages of a site. It keeps only the URLs of the host of the site.
 * The protocol refuses the whole request (HTTP 422) for a URL of a different host.
 */
export function indexNowRequest(site: string, key: string, urls: readonly string[]): IndexNowRequest {
  const host = new URL(site).host;
  const own = urls.filter((url) => URL.canParse(url) && new URL(url).host === host);
  return { host, key, keyLocation: keyLocationOf(site, key), urlList: [...new Set(own)].slice(0, INDEXNOW_MAX_URLS) };
}

/** The effects of the step, so that a test can replace them. */
export interface IndexNowIo {
  readonly fetch: typeof globalThis.fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** The options of the step. */
export interface IndexNowOptions {
  /** The URL of the deployed site, with a final slash. */
  readonly site: string;
  readonly key: string;
  /** The number of reads of the key file before the step stops. The CDN of GitHub Pages can serve the old site for minutes. */
  readonly attempts?: number;
  /** The time between two reads of the key file, in milliseconds. */
  readonly intervalMs?: number;
}

/** This function sends the pages of the site. It gives the exit code: 0 when an engine accepted the request. */
export async function sendIndexNow(options: IndexNowOptions, io: IndexNowIo): Promise<number> {
  const { site, key, attempts = 12, intervalMs = 15_000 } = options;
  if (!URL.canParse(site) || !site.endsWith("/")) {
    io.stderr(`site-pages indexnow: the site URL must end with a slash: ${site}\n`);
    return 2;
  }
  if (!INDEXNOW_KEY.test(key)) {
    io.stderr("site-pages indexnow: the key must have 8 to 128 letters, digits or dashes.\n");
    return 2;
  }
  const keyLocation = keyLocationOf(site, key);
  for (let attempt = 1; ; attempt += 1) {
    const response = await io.fetch(keyLocation, { cache: "no-store" }).catch(() => undefined);
    if (response?.ok && (await response.text()).trim() === key) break;
    if (attempt >= attempts) {
      io.stderr(`site-pages indexnow: the key file is not live after ${attempts} reads: ${keyLocation}\n`);
      return 1;
    }
    await io.sleep(intervalMs);
  }
  const sitemap = await io.fetch(new URL("sitemap.xml", site).href, { cache: "no-store" }).catch(() => undefined);
  if (!sitemap?.ok) {
    io.stderr(`site-pages indexnow: sitemap.xml: ${sitemap ? `HTTP ${sitemap.status}` : "no response"}\n`);
    return 1;
  }
  const request = indexNowRequest(site, key, sitemapUrls(await sitemap.text()));
  if (request.urlList.length === 0) {
    io.stderr("site-pages indexnow: sitemap.xml has no URL of the site.\n");
    return 1;
  }
  const response = await io.fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(request),
  });
  io.stdout(`site-pages indexnow: HTTP ${response.status} for ${request.urlList.length} URLs\n`);
  // 200 and 202 mean accepted. 422 means a URL does not belong to the host or the key.
  if (response.status === 200 || response.status === 202) return 0;
  io.stderr(`${await response.text()}\n`);
  return 1;
}

/** This function starts the step with the arguments `--site <url> --key <key>`. */
export async function runIndexNowCli(argv: readonly string[], io: IndexNowIo): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: { site: { type: "string" }, key: { type: "string" } }, strict: true });
  if (values.site === undefined || values.key === undefined) {
    io.stderr("Usage: site-pages indexnow --site <url with a final slash> --key <key>\n");
    return 2;
  }
  return sendIndexNow({ site: values.site, key: values.key }, io);
}
