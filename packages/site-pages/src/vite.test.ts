import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { build as viteBuild, resolveConfig, type InlineConfig, type Plugin, type Rolldown } from "vite";
import { applyTheme } from "./chrome.ts";
import type { DataStamps } from "./check/freshness.ts";
import { buildInfo, commitTime, rehypeScrollCue, type RehypeNode, siteBase, siteKpi, siteShell, siteStamps, STAMP_MARK, STAMPS_FILE, themeScript } from "./vite.ts";

// The compiler examines this line: Vite accepts the plugin without a cast.
const asVitePlugin = (options: Parameters<typeof siteShell>[0]): Plugin => siteShell(options);
const asViteKpi = (...args: Parameters<typeof siteKpi>): Plugin => siteKpi(...args);
const asViteStamps = (...args: Parameters<typeof siteStamps>): Plugin => siteStamps(...args);

/** This function starts the theme script with a fake page, and gives the attribute that it sets. */
function runScript(script: string, storage: { getItem(key: string): string | null }): string | undefined {
  const dataset: Record<string, string> = {};
  new Function("localStorage", "document", script)(storage, { documentElement: { dataset } });
  return dataset["theme"];
}

describe("themeScript", () => {
  const stored = (value: string | null) => ({ getItem: (key: string) => (key === "site-theme" ? value : null) });

  it("sets each saved theme", () => {
    expect(runScript(themeScript("site-theme"), stored("dark"))).toBe("dark");
    expect(runScript(themeScript("site-theme"), stored("light"))).toBe("light");
  });

  it("sets nothing for no value, for another value and for another key", () => {
    expect(runScript(themeScript("site-theme"), stored(null))).toBeUndefined();
    expect(runScript(themeScript("site-theme"), stored("blue"))).toBeUndefined();
    expect(runScript(themeScript("other"), stored("dark"))).toBeUndefined();
  });

  it("does not stop the page when the browser blocks the storage", () => {
    const blocked = {
      getItem: () => {
        throw new Error("The storage is blocked.");
      },
    };
    expect(runScript(themeScript("site-theme"), blocked)).toBeUndefined();
  });

  it("reads what applyTheme writes", () => {
    const items = new Map<string, string>();
    const dataset: Record<string, string> = {};
    vi.stubGlobal("document", { documentElement: { dataset } });
    vi.stubGlobal("localStorage", { setItem: (key: string, value: string) => items.set(key, value) });
    applyTheme("dark", "site-theme");
    vi.unstubAllGlobals();
    expect(runScript(themeScript("site-theme"), { getItem: (key) => items.get(key) ?? null })).toBe("dark");
  });

  it("gives a key no way to close the script element", () => {
    const script = themeScript('</script><img src=x>"');
    expect(script).not.toContain("</script>");
    expect(script).toContain("\\u003c/script>");
    const seen: string[] = [];
    runScript(script, {
      getItem: (key) => {
        seen.push(key);
        return null;
      },
    });
    expect(seen).toEqual(['</script><img src=x>"']);
  });
});

describe("siteBase", () => {
  it("gives one slash at the end", () => {
    expect(siteBase({ SITE_BASE: "/name" })).toBe("/name/");
    expect(siteBase({ SITE_BASE: "/name/" })).toBe("/name/");
    expect(siteBase({ SITE_BASE: "/" })).toBe("/");
  });

  it("gives the root without the variable, or with an empty variable", () => {
    expect(siteBase({})).toBe("/");
    expect(siteBase({ SITE_BASE: "" })).toBe("/");
  });
});

describe("buildInfo", () => {
  const now = new Date("2026-11-03T22:15:00Z");

  it("shortens the commit, and keeps the date of the build", () => {
    expect(buildInfo("1.2.3", { GITHUB_SHA: "0123456789abcdef" }, now)).toEqual({ sha: "0123456", date: "2026-11-03", version: "1.2.3" });
  });

  it("gives local outside CI, and no version in the JSON of a site without one", () => {
    const info = buildInfo(undefined, {}, now);
    expect(info.sha).toBe("local");
    expect(JSON.stringify(info)).toBe('{"sha":"local","date":"2026-11-03"}');
  });
});

describe("siteShell in a real Vite", () => {
  let dir: string;
  let site: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "site-shell-"));
    site = join(dir, "site");
    mkdirSync(site);
    mkdirSync(join(dir, "packages"));
    writeFileSync(join(dir, "package.json"), '{ "version": "1.2.3" }');
    writeFileSync(join(dir, "packages", "app.json"), '{ "version": "4.5.6" }');
    writeFileSync(join(site, "index.html"), '<!doctype html><html><head><title>t</title></head><body><script type="module" src="/main.js"></script></body></html>');
    writeFileSync(join(site, "main.js"), "document.title = JSON.stringify(__BUILD__);\n");
    vi.stubEnv("SITE_BASE", "/name");
    vi.stubEnv("GITHUB_SHA", "0123456789abcdef");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const config = (overrides: InlineConfig = {}, packageFile?: string | false): InlineConfig => ({
    configFile: false,
    logLevel: "silent",
    root: site,
    plugins: [asVitePlugin({ themeKey: "site-theme", packageFile })],
    ...overrides,
  });

  it("gives the page its base, its build data and the theme script in the head", async () => {
    const result = (await viteBuild(config({ build: { write: false } }))) as Rolldown.RolldownOutput;
    const file = (name: string) => result.output.find((item) => item.fileName.endsWith(name));
    const html = String((file(".html") as Rolldown.OutputAsset).source);
    const code = (file(".js") as Rolldown.OutputChunk).code;

    expect(html.slice(0, html.indexOf("</head>"))).toContain(`<script>${themeScript("site-theme")}</script>`);
    expect(html).toMatch(/src="\/name\/assets\//);
    expect(code).toContain("0123456");
    expect(code).toContain("1.2.3");
    expect(code).not.toContain("__BUILD__");
  });

  it("sets the base and the target of a site that sets neither", async () => {
    const resolved = await resolveConfig(config(), "build");
    expect(resolved.base).toBe("/name/");
    expect(resolved.build.target).toBe("es2022");
    expect(JSON.parse(String(resolved.define?.["__BUILD__"]))).toMatchObject({ sha: "0123456", version: "1.2.3" });
  });

  it("gives priority to the base and the target of the site, and keeps its other values", async () => {
    const resolved = await resolveConfig(config({ base: "/own/", build: { target: "es2024", chunkSizeWarningLimit: 800 }, define: { __OTHER__: "1" } }), "build");
    expect(resolved.base).toBe("/own/");
    expect(resolved.build.target).toBe("es2024");
    expect(resolved.build.chunkSizeWarningLimit).toBe(800);
    expect(resolved.define?.["__OTHER__"]).toBe("1");
    expect(resolved.define?.["__BUILD__"]).toBeDefined();
  });

  it("reads the version of another file, or gives no version", async () => {
    const version = async (packageFile: string | false): Promise<unknown> => {
      const resolved = await resolveConfig(config({}, packageFile), "build");
      return (JSON.parse(String(resolved.define?.["__BUILD__"])) as { version?: string }).version;
    };
    expect(await version("../packages/app.json")).toBe("4.5.6");
    expect(await version(false)).toBeUndefined();
  });

  it("stops the build when the package file does not exist", async () => {
    await expect(resolveConfig(config({}, "../none.json"), "build")).rejects.toThrow(/none\.json/);
  });

  const KPI = { project: "acme", at: "2026-10-01T08:00:00Z", measures: [{ id: "cases", value: 12 }] };
  const COMMIT = "c".repeat(40);

  it("adds kpi.json at the root of the built site, with the commit of the environment", async () => {
    const plugins = [asViteKpi(() => KPI, { GITHUB_SHA: COMMIT })];
    const result = (await viteBuild(config({ plugins, build: { write: false } }))) as Rolldown.RolldownOutput;
    const file = result.output.find((item) => item.fileName === "kpi.json") as Rolldown.OutputAsset;
    expect(JSON.parse(String(file.source))).toEqual({ format: "kpi/1", ...KPI, commit: COMMIT });
  });

  it("stops the build when the data is not correct", async () => {
    const plugins = [asViteKpi({ ...KPI, measures: [] }, { GITHUB_SHA: COMMIT })];
    await expect(viteBuild(config({ plugins, build: { write: false } }))).rejects.toThrow("The file has no measures.");
  });
});

describe("siteStamps", () => {
  let site: string;

  const run = { id: "7", url: "https://example.test/7", date: "2026-11-03T10:00:00Z", engines: { "@scope/engine": "0.7.0" } };
  const stamps: DataStamps = { schema: "data-stamp/1", pages: [{ page: "index.html", runs: [run] }] };

  beforeEach(() => {
    site = mkdtempSync(join(tmpdir(), "site-stamps-"));
  });

  afterEach(() => {
    rmSync(site, { recursive: true, force: true });
  });

  /** This function builds one page with the plugin, and gives the output of the build. */
  const build = async (body: string, input: Parameters<typeof siteStamps>[0]): Promise<Rolldown.RolldownOutput> => {
    writeFileSync(join(site, "index.html"), `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`);
    const config: InlineConfig = { configFile: false, logLevel: "silent", root: site, plugins: [asViteStamps(input)], build: { write: false } };
    return (await viteBuild(config)) as Rolldown.RolldownOutput;
  };
  const asset = (result: Rolldown.RolldownOutput, name: string): string => String((result.output.find((item) => item.fileName === name) as Rolldown.OutputAsset).source);

  it("puts the stamp line in the page, and adds the file that the gate reads", async () => {
    const result = await build(`<p>Data</p>${STAMP_MARK}`, () => stamps);
    const html = asset(result, "index.html");
    expect(html).toContain('class="data-stamp"');
    expect(html).toContain("on engine 0.7.0");
    expect(html).not.toContain(STAMP_MARK);
    expect(JSON.parse(asset(result, STAMPS_FILE))).toEqual(stamps);
  });

  it("stops the build for a bad stamp", async () => {
    const bad = { schema: "data-stamp/1", pages: [{ page: "index.html", runs: [{ ...run, date: "soon" }] }] } as DataStamps;
    await expect(build(STAMP_MARK, bad)).rejects.toThrow("the run has no date");
  });

  it("stops the build for a mark with no stamp", async () => {
    const other: DataStamps = { schema: "data-stamp/1", pages: [{ page: "other.html", runs: [run] }] };
    await expect(build(STAMP_MARK, other)).rejects.toThrow("the stamps have no page index.html");
  });

  it("stops the build for a stamp with no mark", async () => {
    await expect(build("<p>Data</p>", stamps)).rejects.toThrow("the page has no mark");
  });

  it("stops the build for a stamp of a page that the build does not hold", async () => {
    const both: DataStamps = { schema: "data-stamp/1", pages: [{ page: "index.html", runs: [run] }, { page: "gone.html", runs: [run] }] };
    await expect(build(STAMP_MARK, both)).rejects.toThrow("the build does not hold: gone.html");
  });
});

describe("rehypeScrollCue", () => {
  const table = (properties?: Record<string, unknown>): RehypeNode => ({ type: "element", tagName: "table", ...(properties === undefined ? {} : { properties }), children: [] });

  it("gives the cue, a tab stop and a label to each table, at each depth", () => {
    const deep = table();
    const tree: RehypeNode = { type: "root", children: [{ type: "element", tagName: "div", properties: {}, children: [deep] }] };
    rehypeScrollCue()(tree);
    expect(deep.properties).toEqual({ className: ["scroll-cue"], tabIndex: 0, ariaLabel: "Table. It scrolls sideways on a narrow screen." });
    expect(tree.children?.[0]?.properties).toEqual({});
  });

  it("keeps the classes of the table", () => {
    const list = table({ className: ["a", "b"] });
    const one = table({ className: "c" });
    rehypeScrollCue()({ type: "root", children: [list, one] });
    expect(list.properties?.["className"]).toEqual(["a", "b", "scroll-cue"]);
    expect(one.properties?.["className"]).toEqual(["c", "scroll-cue"]);
  });
});

describe("commitTime", () => {
  it("gives the time of the commit in UTC, and the same time for the head by its name", () => {
    const time = commitTime({});
    expect(new Date(time).toISOString()).toBe(time);
    expect(commitTime({ GITHUB_SHA: "HEAD" })).toBe(time);
  });

  it("stops the build when git cannot read the commit", () => {
    expect(() => commitTime({ GITHUB_SHA: "0000000000000000000000000000000000000000" })).toThrow(/cannot read the commit/);
  });
});
