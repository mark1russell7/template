import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build as viteBuild, type InlineConfig, type Plugin } from "vite";
import { siteOffline } from "./plugin.ts";
import { cachePrefix, MANIFEST_FILE, registerScript, SERVICE_WORKER_FILE, type PrecacheList } from "./shell.ts";

// The compiler examines this line: Vite accepts the plugin without a cast.
const asViteOffline = (...args: Parameters<typeof siteOffline>): Plugin => siteOffline(...args);

let dir: string;
let site: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "site-offline-"));
  site = join(dir, "site");
  mkdirSync(join(site, "public"), { recursive: true });
  mkdirSync(join(site, "notes"));
  const page = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><script type="module" src="/main.js"></script></body></html>`;
  writeFileSync(join(site, "index.html"), page("Home"));
  writeFileSync(join(site, "notes", "index.html"), page("Notes"));
  writeFileSync(join(site, "main.js"), 'document.body.dataset.ready = "yes";\n');
  writeFileSync(join(site, "public", "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(site, "public", "big.bin"), "x".repeat(2048));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = (plugin: Plugin, overrides: InlineConfig = {}): InlineConfig => ({
  configFile: false,
  logLevel: "silent",
  root: site,
  base: "/site/",
  build: { outDir: join(dir, "out"), emptyOutDir: true, sourcemap: true, rolldownOptions: { input: [join(site, "index.html"), join(site, "notes", "index.html")] } },
  plugins: [plugin],
  ...overrides,
});

const out = (file: string) => readFileSync(join(dir, "out", file), "utf8");

describe("siteOffline", () => {
  it("writes the manifest and a worker that keeps each built file, and adds the link and the script to each page", async () => {
    const lists: (PrecacheList & { cache: string })[] = [];
    const plugin = asViteOffline({ manifest: { name: "Field notes", icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }] }, maxFileBytes: 1024, onList: (list) => lists.push(list) });
    await viteBuild(config(plugin));

    const manifest = JSON.parse(out(MANIFEST_FILE)) as { start_url: string; scope: string; icons: { src: string }[] };
    expect(manifest).toMatchObject({ start_url: "/site/", scope: "/site/", icons: [{ src: "/site/icon.svg" }] });
    for (const page of ["index.html", "notes/index.html"]) {
      const html = out(page);
      expect(html, page).toContain(`<link rel="manifest" href="/site/${MANIFEST_FILE}">`);
      expect(html, page).toContain(registerScript("/site/"));
    }

    const list = lists[0];
    expect(list?.urls.some((url) => /^\/site\/assets\/.+\.js$/.test(url))).toBe(true);
    expect(list!.urls).toEqual(expect.arrayContaining(["/site/index.html", "/site/notes/index.html", `/site/${MANIFEST_FILE}`, "/site/icon.svg"]));
    expect(list!.urls.some((url) => url.endsWith(".map"))).toBe(false);
    expect(list!.skipped).toEqual(expect.arrayContaining([{ path: "big.bin", reason: "larger than 1024 bytes" }]));
    expect(list!.skipped.some((file) => file.path.endsWith(".map"))).toBe(true);
    expect(list!.cache.startsWith(cachePrefix("/site/"))).toBe(true);

    const worker = out(SERVICE_WORKER_FILE);
    expect(worker).toContain(JSON.stringify(list!.cache));
    expect(worker).toContain(JSON.stringify(list!.urls));
  });

  it("gives a new cache name when a built file changes, and the same name for the same files", async () => {
    const names: string[] = [];
    const plugin = () => asViteOffline({ manifest: { name: "Field notes" }, onList: (list) => names.push(list.cache) });
    await viteBuild(config(plugin()));
    await viteBuild(config(plugin()));
    writeFileSync(join(site, "public", "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><title>new</title></svg>');
    await viteBuild(config(plugin()));
    expect(names[0]).toBe(names[1]);
    expect(names[2]).not.toBe(names[0]);
  });

  it("writes no manifest and no manifest link for the value false", async () => {
    await viteBuild(config(asViteOffline({ manifest: false })));
    expect(existsSync(join(dir, "out", MANIFEST_FILE))).toBe(false);
    expect(out("index.html")).not.toContain('rel="manifest"');
    expect(out(SERVICE_WORKER_FILE)).toContain("/site/index.html");
  });

  it("writes no file in a build with no write", async () => {
    const lists: unknown[] = [];
    await viteBuild(config(asViteOffline({ manifest: { name: "Field notes" }, onList: (list) => lists.push(list) }), { build: { write: false } }));
    expect(lists).toEqual([]);
  });

  it("refuses a base that is not a path from the root of the origin", async () => {
    await expect(viteBuild(config(asViteOffline({ manifest: false }), { base: "./" }))).rejects.toThrow("needs a base that is a path");
  });
});
