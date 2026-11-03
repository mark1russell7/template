import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  files: string[];
  publishConfig: { exports: Record<string, unknown> };
};

describe("the scroll cue style", () => {
  it("is an entry of the package, and the file is in the package", () => {
    const target = pkg.publishConfig.exports["./scroll-cue.css"];
    expect(target).toBe("./styles/scroll-cue.css");
    expect(existsSync(new URL(target as string, root))).toBe(true);
    expect(pkg.files).toContain("styles");
  });

  it("gives the class scroll-cue a sideways scroll, two covers and two shades", () => {
    const css = readFileSync(new URL("styles/scroll-cue.css", root), "utf8");
    expect(css).toMatch(/\.scroll-cue\s*\{/);
    expect(css).toContain("overflow-x: auto");
    expect(css).toContain("--scroll-cue-bg");
    expect(css).toMatch(/background-attachment:\s*local,\s*local,\s*scroll,\s*scroll/);
    expect(css.match(/gradient\(/g)).toHaveLength(4);
  });
});
