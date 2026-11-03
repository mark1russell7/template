/**
 * A static file server for the `check` command. It serves a built site folder at the path of the
 * site home, as GitHub Pages does. Thus the links of the site work as on the live site.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
};

/**
 * This function maps the path of a request to a file of the folder, as GitHub Pages does. A folder
 * gives its `index.html`. For a path with no extension, the function also tries `<path>.html`.
 *
 * @returns the absolute file, or undefined when the path is outside the base or the file is missing
 */
export function resolveFile(root: string, base: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const home = base.endsWith("/") ? base : `${base}/`;
  if (decoded === home.slice(0, -1)) decoded = home;
  if (!decoded.startsWith(home)) return undefined;
  const top = resolve(root);
  const file = normalize(join(top, decoded.slice(home.length)));
  if (file !== top && !file.startsWith(top + sep)) return undefined;
  const candidates = [file, join(file, "index.html"), `${file}.html`];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/** A started server. */
export interface StaticServer {
  /** The URL of the site home, for example `http://127.0.0.1:50123/client/`. */
  url: string;
  close(): Promise<void>;
}

/**
 * This function serves the folder at `base` on a free port of 127.0.0.1. A missing file gives the
 * status 404 with the `404.html` of the folder, when it has one.
 */
export async function serve(root: string, base: string): Promise<StaticServer> {
  const server: Server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const home = base.endsWith("/") ? base : `${base}/`;
    if (pathname === home.slice(0, -1) && home !== "/") {
      response.writeHead(301, { location: home }).end();
      return;
    }
    const file = resolveFile(root, base, pathname);
    const missing = join(resolve(root), "404.html");
    const send = file ?? (existsSync(missing) ? missing : undefined);
    if (send === undefined) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`404: ${pathname}\n`);
      return;
    }
    response.writeHead(file ? 200 : 404, { "content-type": TYPES[extname(send).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(send).pipe(response);
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the server has no port");
  return {
    url: `http://127.0.0.1:${address.port}${base.endsWith("/") ? base : `${base}/`}`,
    close: () => new Promise((done) => server.close(() => done())),
  };
}
