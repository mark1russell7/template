import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  exports: Record<string, unknown>;
  files: string[];
  publishConfig: { exports: Record<string, unknown> };
};
const css = readFileSync(new URL("styles/shell.css", root), "utf8");

/** This function gives the body of the first rule with exactly this selector. */
function body(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("the shell style", () => {
  it("is an entry of the package, and the file is in the package", () => {
    expect(pkg.exports["./shell.css"]).toBe("./styles/shell.css");
    const target = pkg.publishConfig.exports["./shell.css"];
    expect(target).toBe("./styles/shell.css");
    expect(existsSync(new URL(target as string, root))).toBe(true);
    expect(pkg.files).toContain("styles");
  });

  it("gives the two dark rules the same colors", () => {
    const declarations = (selector: string) => body(selector).split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
    expect(declarations(':root:not([data-theme="light"])')).toEqual(declarations(':root[data-theme="dark"]'));
  });

  it("defines each token that a rule uses", () => {
    const used = new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1]));
    expect(used.size).toBeGreaterThan(0);
    for (const token of used) expect(body(":root"), token).toContain(`${token}:`);
  });

  it("sets each color token for light and for dark", () => {
    for (const token of ["--bg", "--surface", "--sunken", "--ink", "--muted", "--rule", "--focus"]) {
      expect(body(":root"), token).toContain(`${token}:`);
      expect(body(':root[data-theme="dark"]'), token).toContain(`${token}:`);
    }
  });

  it("sets no look for the content of a site", () => {
    expect(css).not.toMatch(/^(button|input|select|table|pre|code|\.card|\.chip)\b/m);
  });
});
