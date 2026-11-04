import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  exports: Record<string, unknown>;
  publishConfig: { exports: Record<string, unknown> };
  dependencies: Record<string, string>;
};
const css = readFileSync(new URL("styles/explorer.css", root), "utf8");

describe("the layout of the explorer", () => {
  it("puts the chart first in one column", () => {
    expect(css).toContain("@media (max-width: 59.99rem) {\n  .rx-chart { order: -1; }\n}");
  });
});

/** This function gives the declarations of the first rule with exactly this selector. */
function declarations(selector: string): string[] {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css
    .slice(start, css.indexOf("}", start))
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** This function gives the value of a token in a list of declarations. */
function token(rule: readonly string[], name: string): string {
  const line = rule.find((text) => text.startsWith(`${name}: `));
  expect(line, name).toBeDefined();
  return line!.slice(name.length + 2, -1);
}

/** This function gives the relative luminance of a color of the form #rrggbb, by the formula of WCAG 2. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const v = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** This function gives the contrast of two colors, by the formula of WCAG 2. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("the colors of the explorer without the tokens of a site", () => {
  const light = declarations(".response-explorer");
  const dark = declarations(':root[data-theme="dark"] .response-explorer');

  it("change in dark for each color of the text and the panels", () => {
    for (const name of ["surface", "sunken", "ink", "muted", "rule", "accent", "error"]) {
      expect(token(dark, `--rx-base-${name}`)).not.toBe(token(light, `--rx-base-${name}`));
    }
  });

  it.each([
    ["light", light],
    ["dark", dark],
  ])("give the text a contrast of 4.5 or more on each panel in %s", (_scheme, rule) => {
    for (const panel of ["surface", "sunken"]) {
      for (const text of ["ink", "muted", "error"]) {
        expect(contrast(token(rule, `--rx-base-${text}`), token(rule, `--rx-base-${panel}`)), `${text} on ${panel}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("the explorer entries", () => {
  it("are entries of the package, and the files exist", () => {
    expect(pkg.exports["./explorer"]).toBe("./src/explorer/index.ts");
    expect(pkg.exports["./explorer.css"]).toBe("./styles/explorer.css");
    expect(pkg.publishConfig.exports["./explorer.css"]).toBe("./styles/explorer.css");
    expect(pkg.publishConfig.exports["./explorer"]).toEqual({ types: "./build/explorer/index.d.ts", import: "./build/explorer/index.js" });
    expect(existsSync(new URL("src/explorer/index.ts", root))).toBe(true);
    expect(pkg.dependencies["@mark1russell7/rigor-statistics"]).toBe("^0.1.9");
  });

  it("gives the two dark rules the same colors", () => {
    expect(declarations(':root:not([data-theme="light"]) .response-explorer')).toEqual(declarations(':root[data-theme="dark"] .response-explorer'));
  });

  it("uses a tabular form for the numbers of the axes", () => {
    expect(css).toMatch(/\.rx-tick[^{]*\{[^}]*tabular-nums/);
  });

  it("asks no other server for a font or a script", () => {
    expect(css).not.toMatch(/@import|@font-face|url\(/);
  });
});

describe("the explorer modules", () => {
  it("import no Node.js module", () => {
    for (const file of ["src/explorer/index.ts", "src/explorer/model.ts", "src/explorer/view.ts"]) {
      expect(readFileSync(new URL(file, root), "utf8")).not.toMatch(/from "node:/);
    }
  });
});
