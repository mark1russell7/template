import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasIconLink, iconLink, SITE_ICON_HREF, SITE_ICON_SVG } from "./icon.ts";

describe("the default icon", () => {
  it("is a data URL of the SVG, with no character that ends an attribute", () => {
    expect(SITE_ICON_HREF.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(SITE_ICON_HREF.slice("data:image/svg+xml,".length))).toBe(SITE_ICON_SVG);
    expect(SITE_ICON_HREF).not.toMatch(/["'<> ]/);
  });

  it("gives a link element with the default or another href", () => {
    expect(iconLink()).toBe(`<link rel="icon" href="${SITE_ICON_HREF}">`);
    expect(iconLink("/own.svg")).toBe('<link rel="icon" href="/own.svg">');
    expect(iconLink('/a"b.svg')).toBe('<link rel="icon" href="/a&quot;b.svg">');
  });
});

describe("hasIconLink", () => {
  it("finds an icon link in each form of the rel attribute", () => {
    expect(hasIconLink('<head><link rel="icon" href="/i.svg"></head>')).toBe(true);
    expect(hasIconLink("<LINK REL='Shortcut Icon' HREF=/favicon.png>")).toBe(true);
    expect(hasIconLink('<link href="/i.svg" rel=icon type="image/svg+xml">')).toBe(true);
    expect(hasIconLink(iconLink())).toBe(true);
  });

  it("does not count a link that leaves the browser to ask for /favicon.ico", () => {
    expect(hasIconLink("<head><title>t</title></head>")).toBe(false);
    expect(hasIconLink('<link rel="apple-touch-icon" href="/t.png">')).toBe(false);
    expect(hasIconLink('<link data-rel="icon" rel="stylesheet" href="/s.css">')).toBe(false);
    expect(hasIconLink('<link rel="iconic" href="/i.svg">')).toBe(false);
    expect(hasIconLink('<meta name="icon" content="x">')).toBe(false);
  });
});

describe("the site preset of the template CLI", () => {
  it("has the default icon in its home page", () => {
    const page = readFileSync(new URL("../../../cli/src/presets/site/index.html", import.meta.url), "utf8");
    expect(page).toContain(iconLink());
  });
});
