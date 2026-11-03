import { readFileSync } from "node:fs";
import { probeScript } from "@mark1russell7/site-pages";
import { describe, expect, it } from "vitest";

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<void>;

// The site check reads `check-probe.ts` directly. This test removes the types with the same function of site-pages.
describe("the script of the site probe", () => {
  const script = probeScript(readFileSync(new URL("../check-probe.ts", import.meta.url), "utf8"));

  it("has no types and no export", () => {
    expect(script).not.toMatch(/^export /m);
    expect(script).not.toMatch(/declare const/);
    expect(script).not.toMatch(/: string\[\]/);
  });

  it("is the body of an async function with the helpers of the site check", () => {
    expect(() => new AsyncFunction("check", "wait", "until", "$", "$$", "type", "click", script)).not.toThrow();
  });

  it("makes checks of the package preview and of the workflow explorer", () => {
    expect(script.match(/\bcheck\(/g)?.length ?? 0).toBeGreaterThanOrEqual(12);
    expect(script).toContain('"name": "@acme/probe-web"');
    expect(script).toContain("reusable-pages.yml");
  });
});
