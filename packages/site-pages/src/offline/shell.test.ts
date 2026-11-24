import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { OFFLINE_ATTRIBUTE, OFFLINE_EVENT } from "../chrome.ts";
import {
  cachePrefix,
  FALLBACK_HEADER,
  MAX_FILE_BYTES,
  offlineBase,
  offlineCacheName,
  precacheList,
  registerScript,
  serviceWorkerSource,
  SERVICE_WORKER_FILE,
  webManifest,
} from "./shell.ts";

describe("offlineBase", () => {
  it("gives one slash at the start and one at the end", () => {
    expect(offlineBase("")).toBe("/");
    expect(offlineBase("/")).toBe("/");
    expect(offlineBase("site")).toBe("/site/");
    expect(offlineBase("/site")).toBe("/site/");
    expect(offlineBase("//a/b//")).toBe("/a/b/");
    expect(offlineBase("///")).toBe("/");
  });

  // With the expression /\/+$/, each of these inputs takes minutes, so the test stops at its time limit.
  it("gives the base of a long run of slashes with no slow expression", () => {
    const slashes = "/".repeat(200_000);
    expect(offlineBase(`${slashes}a`)).toBe("/a/");
    expect(offlineBase(`a${slashes}`)).toBe("/a/");
    expect(offlineBase(`a${slashes}b`)).toBe(`/a${slashes}b/`);
  });
});

describe("precacheList", () => {
  const files = [
    { path: "index.html", bytes: 900 },
    { path: "assets/main-1a2b.js", bytes: 4000 },
    { path: "assets/main-1a2b.js.map", bytes: 9000 },
    { path: "about\\index.html", bytes: 500 },
    { path: ".well-known/security.txt", bytes: 100 },
    { path: "assets/.hidden", bytes: 10 },
    { path: SERVICE_WORKER_FILE, bytes: 2000 },
    { path: "media/film.mp4", bytes: MAX_FILE_BYTES + 1 },
    { path: "data/large.json", bytes: 300 },
  ];

  it("keeps the built files in order, with the base, and gives the reason of each file that stays out", () => {
    const list = precacheList(files, { base: "/site", exclude: [/^data\//] });
    expect(list.urls).toEqual(["/site/about/index.html", "/site/assets/main-1a2b.js", "/site/index.html"]);
    expect(list.skipped).toEqual([
      { path: ".well-known/security.txt", reason: "a name that starts with a dot" },
      { path: "assets/.hidden", reason: "a name that starts with a dot" },
      { path: "assets/main-1a2b.js.map", reason: "a source map" },
      { path: "data/large.json", reason: "a pattern of exclude" },
      { path: "media/film.mp4", reason: `larger than ${MAX_FILE_BYTES} bytes` },
      { path: SERVICE_WORKER_FILE, reason: "the service worker" },
    ]);
  });

  it("gives the same list for the files in each order", () => {
    const reversed = precacheList([...files].reverse(), { base: "/" });
    expect(reversed).toEqual(precacheList(files, { base: "/" }));
  });

  it("uses the limit of the options", () => {
    expect(precacheList([{ path: "a.js", bytes: 11 }], { base: "/", maxFileBytes: 10 }).urls).toEqual([]);
    expect(precacheList([{ path: "a.js", bytes: 10 }], { base: "/", maxFileBytes: 10 }).urls).toEqual(["/a.js"]);
  });

  it("refuses a path out of the folder and a limit that is not positive", () => {
    expect(() => precacheList([{ path: "../secret.txt", bytes: 1 }], { base: "/" })).toThrow(RangeError);
    expect(() => precacheList([{ path: "/etc/passwd", bytes: 1 }], { base: "/" })).toThrow(RangeError);
    expect(() => precacheList([{ path: "C:/x.txt", bytes: 1 }], { base: "/" })).toThrow(RangeError);
    expect(() => precacheList([], { base: "/", maxFileBytes: 0 })).toThrow(RangeError);
    expect(() => precacheList([], { base: "/", maxFileBytes: Number.NaN })).toThrow(RangeError);
  });
});

describe("offlineCacheName", () => {
  const files = [
    { url: "/site/index.html", content: "<h1>Home</h1>" },
    { url: "/site/app.js", content: new TextEncoder().encode("run()") },
  ];

  it("starts with the prefix of the base and does not change with the order of the files", () => {
    const name = offlineCacheName("/site/", files);
    expect(name.startsWith(cachePrefix("/site/"))).toBe(true);
    expect(name).toMatch(/ [0-9a-f]{16}$/);
    expect(offlineCacheName("site", [...files].reverse())).toBe(name);
  });

  it("changes with the content of a file, with a URL and with the base", () => {
    const name = offlineCacheName("/site/", files);
    expect(offlineCacheName("/site/", [files[0]!, { url: "/site/app.js", content: "run(1)" }])).not.toBe(name);
    expect(offlineCacheName("/site/", [files[0]!, { url: "/site/app2.js", content: "run()" }])).not.toBe(name);
    expect(offlineCacheName("/other/", files)).not.toBe(name);
  });

  it("gives each base a prefix that is not the start of the prefix of another base", () => {
    expect(cachePrefix("/a/").startsWith(cachePrefix("/"))).toBe(false);
    expect(cachePrefix("/ab/").startsWith(cachePrefix("/a/"))).toBe(false);
  });
});

/** A cache of the fake worker: a map from the path of a URL to the body and headers of its answer. */
type FakeCache = Map<string, Response>;

/** This function starts the source of a worker in a fake worker scope, with the given caches and network. */
function startWorker(source: string, stores: Map<string, FakeCache>, network: { on: boolean; served: Record<string, string> }) {
  const origin = "https://example.test";
  const listeners = new Map<string, (event: unknown) => void>();
  const pathOf = (input: string | { url: string }) => new URL(typeof input === "string" ? input : input.url, origin).pathname;
  const fetch = async (input: string | { url: string }): Promise<Response> => {
    if (!network.on) throw new TypeError("Failed to fetch");
    const body = network.served[pathOf(input)];
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { headers: { "content-type": "text/html" } });
  };
  const cacheOf = (store: FakeCache) => ({
    addAll: async (urls: string[]) => {
      for (const url of urls) {
        const answer = await fetch(url);
        if (!answer.ok) throw new TypeError(`addAll: ${url} gave ${answer.status}`);
        store.set(pathOf(url), answer);
      }
    },
    match: async (input: string) => store.get(pathOf(input))?.clone(),
  });
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      return cacheOf(stores.get(name)!);
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const calls: string[] = [];
  const self = {
    location: new URL(`${origin}/site/${SERVICE_WORKER_FILE}`),
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    skipWaiting: async () => void calls.push("skipWaiting"),
    clients: { claim: async () => void calls.push("claim") },
  };
  new Script(source).runInContext(createContext({ self, caches, fetch, URL, Headers, Response, Set, Promise, JSON }));
  const lifecycle = async (type: "install" | "activate") => {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)!({ waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    await Promise.all(waits);
  };
  /** This function sends a request to the worker. It gives the answer of the worker, or undefined when the worker does not answer. */
  const request = async (url: string, init: { method?: string; mode?: string } = {}): Promise<Response | undefined> => {
    let answer: Promise<Response> | undefined;
    listeners.get("fetch")!({ request: { url: new URL(url, origin).href, method: init.method ?? "GET", mode: init.mode ?? "cors" }, respondWith: (promise: Promise<Response>) => (answer = promise) });
    return answer === undefined ? undefined : await answer;
  };
  return { lifecycle, request, calls };
}

describe("serviceWorkerSource", () => {
  const urls = ["/site/app.js", "/site/index.html", "/site/notes/index.html"];
  const served = { "/site/index.html": "<h1>Home</h1>", "/site/app.js": "run()", "/site/notes/index.html": "<h1>Notes</h1>" };
  const cache = offlineCacheName("/site/", [{ url: "/site/index.html", content: "1" }]);

  it("keeps the files at the install, and removes only the old caches of its own base at the activation", async () => {
    const stores = new Map<string, FakeCache>([
      [`${cachePrefix("/site/")}0000000000000000`, new Map()],
      [`${cachePrefix("/")}0000000000000000`, new Map()],
      ["another app", new Map()],
    ]);
    const worker = startWorker(serviceWorkerSource({ base: "/site/", cache, urls }), stores, { on: true, served });
    await worker.lifecycle("install");
    expect([...stores.get(cache)!.keys()].sort()).toEqual(urls);
    await worker.lifecycle("activate");
    expect([...stores.keys()].sort()).toEqual([`${cachePrefix("/")}0000000000000000`, cache, "another app"].sort());
    expect(worker.calls).toEqual(["skipWaiting", "claim"]);
  });

  it("answers the kept pages and files with no network, and gives the home page for a page that it does not keep", async () => {
    const network = { on: true, served };
    const worker = startWorker(serviceWorkerSource({ base: "/site/", cache, urls }), new Map(), network);
    await worker.lifecycle("install");
    network.on = false;
    expect(await (await worker.request("/site/", { mode: "navigate" }))!.text()).toBe("<h1>Home</h1>");
    expect(await (await worker.request("/site/notes/", { mode: "navigate" }))!.text()).toBe("<h1>Notes</h1>");
    expect(await (await worker.request("/site/app.js"))!.text()).toBe("run()");
    const fallback = (await worker.request("/site/missing/", { mode: "navigate" }))!;
    expect(await fallback.text()).toBe("<h1>Home</h1>");
    expect(fallback.headers.get(FALLBACK_HEADER)).toBe("fallback");
    expect((await worker.request("/site/notes/", { mode: "navigate" }))!.headers.get(FALLBACK_HEADER)).toBeNull();
  });

  it("gives the network answer for a page that it does not keep when the network is on", async () => {
    const network = { on: true, served: { ...served, "/site/new/index.html": "<h1>New</h1>", "/site/new/": "<h1>New</h1>" } };
    const worker = startWorker(serviceWorkerSource({ base: "/site/", cache, urls }), new Map(), network);
    await worker.lifecycle("install");
    const answer = (await worker.request("/site/new/", { mode: "navigate" }))!;
    expect(await answer.text()).toBe("<h1>New</h1>");
    expect(answer.headers.get(FALLBACK_HEADER)).toBeNull();
  });

  it("does not answer a request of another method, of another origin or of a file that it does not keep", async () => {
    const worker = startWorker(serviceWorkerSource({ base: "/site/", cache, urls }), new Map(), { on: true, served });
    await worker.lifecycle("install");
    expect(await worker.request("/site/app.js", { method: "POST" })).toBeUndefined();
    expect(await worker.request("https://cdn.example.test/site/app.js")).toBeUndefined();
    expect(await worker.request("/site/data.json")).toBeUndefined();
  });

  it("refuses a cache name of another base", () => {
    expect(() => serviceWorkerSource({ base: "/other/", cache, urls })).toThrow(RangeError);
  });
});

describe("webManifest", () => {
  it("starts the app at the site home, and puts the icons with a relative path under the home", () => {
    const icons = [
      { src: "icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/shared/icon.png", sizes: "192x192", type: "image/png" },
      { src: "https://cdn.example.test/icon.png", sizes: "512x512", type: "image/png", purpose: "maskable" as const },
    ];
    expect(webManifest({ name: "Field notes", themeColor: "#123456", icons }, "/site")).toEqual({
      name: "Field notes",
      short_name: "Field notes",
      start_url: "/site/",
      scope: "/site/",
      display: "standalone",
      theme_color: "#123456",
      icons: [
        { src: "/site/icon.svg", sizes: "any", type: "image/svg+xml" },
        { src: "/shared/icon.png", sizes: "192x192", type: "image/png" },
        { src: "https://cdn.example.test/icon.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    });
  });

  it("uses the short name and the description, and refuses an empty name", () => {
    const manifest = webManifest({ name: "Field notes", shortName: "Notes", description: "The notes.", backgroundColor: "#fff" }, "/");
    expect(manifest).toMatchObject({ short_name: "Notes", description: "The notes.", background_color: "#fff", start_url: "/", icons: [] });
    expect(() => webManifest({ name: " " }, "/")).toThrow(RangeError);
  });
});

describe("registerScript", () => {
  const run = (script: string, navigator: object, console: object) => new Script(script).runInContext(createContext({ navigator, console }));

  it("registers the worker of the base, with the base as its scope", async () => {
    const calls: unknown[][] = [];
    run(registerScript("/site"), { serviceWorker: { register: async (...args: unknown[]) => void calls.push(args) } }, {});
    await Promise.resolve();
    expect(calls).toEqual([[`/site/${SERVICE_WORKER_FILE}`, { scope: "/site/" }]]);
  });

  it("does nothing in a browser with no service worker, and sends a failure to console.warn", async () => {
    expect(() => run(registerScript("/"), {}, {})).not.toThrow();
    const warned: unknown[] = [];
    run(registerScript("/"), { serviceWorker: { register: () => Promise.reject(new Error("refused")) } }, { warn: (...args: unknown[]) => warned.push(...args) });
    await new Promise((done) => setTimeout(done, 0));
    expect(String(warned[0])).toContain("not ready");
  });

  /** This function runs the script in a page at `path`, and records each state that the page gets. */
  function page(path: string, serviceWorker: object | undefined) {
    const attributes = new Map<string, string>();
    const events: unknown[] = [];
    const navigator = serviceWorker === undefined ? {} : { serviceWorker };
    const context = {
      navigator,
      console: { warn: () => {} },
      location: { pathname: path },
      document: { documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) } },
      CustomEvent,
      dispatchEvent: (event: CustomEvent) => events.push([event.type, event.detail]),
    };
    new Script(registerScript("/site/")).runInContext(createContext(context));
    const states = () => events.filter((event) => (event as unknown[])[0] === OFFLINE_EVENT).map((event) => (event as unknown[])[1]);
    return { attribute: () => attributes.get(OFFLINE_ATTRIBUTE), states };
  }
  const settle = () => new Promise((done) => setTimeout(done, 0));

  it("tells the state none in a browser with no service worker", () => {
    expect(page("/site/", undefined).attribute()).toBe("none");
  });

  it("tells saving, then ready when the worker is active", async () => {
    let activate: (value: unknown) => void = () => {};
    const ready = new Promise((done) => (activate = done));
    const one = page("/site/", { register: async () => ({}), ready });
    await settle();
    expect(one.attribute()).toBe("saving");
    activate({});
    await settle();
    expect(one.states()).toEqual(["saving", "ready"]);
    expect(one.attribute()).toBe("ready");
  });

  it("tells ready at once when a worker controls the page or is active", async () => {
    expect(page("/site/", { controller: {}, register: async () => ({ active: {} }) }).attribute()).toBe("ready");
    const active = page("/site/?tab=one", { register: async () => ({ active: {} }), ready: new Promise(() => {}) });
    await settle();
    expect(active.attribute()).toBe("ready");
  });

  it("tells outside for a page out of the scope of the worker, for example the home with no slash", async () => {
    const outside = page("/site", { register: async () => ({ active: {} }) });
    await settle();
    expect(outside.states()).toEqual(["outside"]);
  });

  it("tells failed when the browser refuses the worker, or the worker does not keep each file", async () => {
    const refused = page("/site/", { register: () => Promise.reject(new Error("refused")) });
    await settle();
    expect(refused.attribute()).toBe("failed");
    const worker = new EventTarget() as EventTarget & { state: string };
    const broken = page("/site/", { register: async () => ({ installing: worker }), ready: new Promise(() => {}) });
    await settle();
    worker.state = "redundant";
    worker.dispatchEvent(new Event("statechange"));
    expect(broken.states()).toEqual(["saving", "failed"]);
  });
});
