import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  exports: Record<string, unknown>;
  publishConfig: { exports: Record<string, unknown> };
  dependencies: Record<string, string>;
};
const css = readFileSync(new URL("styles/explorer.css", root), "utf8");

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

describe("the explorer entries", () => {
  it("are entries of the package, and the files exist", () => {
    expect(pkg.exports["./explorer"]).toBe("./src/explorer/index.ts");
    expect(pkg.exports["./explorer.css"]).toBe("./styles/explorer.css");
    expect(pkg.publishConfig.exports["./explorer.css"]).toBe("./styles/explorer.css");
    expect(pkg.publishConfig.exports["./explorer"]).toEqual({ types: "./build/explorer/index.d.ts", import: "./build/explorer/index.js" });
    expect(existsSync(new URL("src/explorer/index.ts", root))).toBe(true);
    expect(pkg.dependencies["@mark1russell7/rigor-statistics"]).toBe("^0.1.7");
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
