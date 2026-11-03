import { describe, expect, it } from "vitest";
import { INDEXNOW_ENDPOINT, indexNowRequest, keyLocationOf, runIndexNowCli, sendIndexNow, sitemapUrls, type IndexNowIo } from "./indexnow.ts";

const SITE = "https://owner.github.io/repo/";
const KEY = "626da9a7ba19ca53f2437cb462de76e7";
const SITEMAP = `<?xml version="1.0"?><urlset><url><loc>https://owner.github.io/repo/</loc></url><url><loc> https://owner.github.io/repo/a?x=1&amp;y=2 </loc></url><url><loc>https://other.example/b</loc></url><url><loc>https://owner.github.io/repo/</loc></url></urlset>`;

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** This function makes the effects of a test: each URL gives the next of its responses, and the last one again. */
function fakeIo(routes: Record<string, readonly (() => Response)[]>) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const out: string[] = [];
  const seen = new Map<string, number>();
  const io: IndexNowIo = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const list = routes[url];
      if (list === undefined) throw new Error(`no route: ${url}`);
      const index = Math.min(seen.get(url) ?? 0, list.length - 1);
      seen.set(url, index + 1);
      return (list[index] as () => Response)();
    }) as typeof globalThis.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
  };
  return { io, calls, sleeps, out };
}

describe("sitemapUrls", () => {
  it("gives each <loc>, trimmed and with the entities decoded", () => {
    expect(sitemapUrls(SITEMAP)).toEqual([
      "https://owner.github.io/repo/",
      "https://owner.github.io/repo/a?x=1&y=2",
      "https://other.example/b",
      "https://owner.github.io/repo/",
    ]);
  });
});

describe("indexNowRequest", () => {
  it("keeps the URLs of the host once each, and gives the key location under the site path", () => {
    const request = indexNowRequest(SITE, KEY, sitemapUrls(SITEMAP));
    expect(request).toEqual({
      host: "owner.github.io",
      key: KEY,
      keyLocation: `https://owner.github.io/repo/${KEY}.txt`,
      urlList: ["https://owner.github.io/repo/", "https://owner.github.io/repo/a?x=1&y=2"],
    });
  });

  it("sends at most 10000 URLs", () => {
    const urls = Array.from({ length: 10_005 }, (_, index) => `${SITE}p${index}`);
    expect(indexNowRequest(SITE, KEY, urls).urlList).toHaveLength(10_000);
  });
});

describe("sendIndexNow", () => {
  const keyFile = keyLocationOf(SITE, KEY);
  const sitemap = `${SITE}sitemap.xml`;

  it("waits for the key file, then posts the URLs of the sitemap", async () => {
    const fake = fakeIo({
      [keyFile]: [() => new Response("old", { status: 404 }), () => new Response(`${KEY}\n`)],
      [sitemap]: [() => new Response(SITEMAP)],
      [INDEXNOW_ENDPOINT]: [() => new Response("", { status: 202 })],
    });
    expect(await sendIndexNow({ site: SITE, key: KEY, intervalMs: 5 }, fake.io)).toBe(0);
    expect(fake.sleeps).toEqual([5]);
    const post = fake.calls.at(-1);
    expect(post?.init?.method).toBe("POST");
    expect(JSON.parse(String(post?.init?.body)).urlList).toHaveLength(2);
    expect(fake.out.join("")).toContain("HTTP 202 for 2 URLs");
  });

  it("stops after the given reads when the key file does not go live", async () => {
    const fake = fakeIo({ [keyFile]: [() => new Response("other")] });
    expect(await sendIndexNow({ site: SITE, key: KEY, attempts: 3, intervalMs: 1 }, fake.io)).toBe(1);
    expect(fake.calls).toHaveLength(3);
    expect(fake.sleeps).toHaveLength(2);
  });

  it("fails on a refusal of the endpoint and on a sitemap with no URL of the site", async () => {
    const refused = fakeIo({
      [keyFile]: [() => new Response(KEY)],
      [sitemap]: [() => new Response(SITEMAP)],
      [INDEXNOW_ENDPOINT]: [() => new Response("bad url", { status: 422 })],
    });
    expect(await sendIndexNow({ site: SITE, key: KEY }, refused.io)).toBe(1);
    const empty = fakeIo({ [keyFile]: [() => new Response(KEY)], [sitemap]: [() => new Response("<urlset><url><loc>https://other.example/</loc></url></urlset>")] });
    expect(await sendIndexNow({ site: SITE, key: KEY }, empty.io)).toBe(1);
    expect(empty.calls.some((call) => call.url === INDEXNOW_ENDPOINT)).toBe(false);
  });

  it("refuses a site with no final slash and a key that the protocol does not accept, with no request", async () => {
    const fake = fakeIo({});
    expect(await sendIndexNow({ site: "https://owner.github.io/repo", key: KEY }, fake.io)).toBe(2);
    expect(await sendIndexNow({ site: SITE, key: "short" }, fake.io)).toBe(2);
    expect(await runIndexNowCli(["--site", SITE], fake.io)).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });
});
