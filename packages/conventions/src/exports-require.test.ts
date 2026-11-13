/**
 * The rule `exports-require` on fixture repositories, and the resolution of `exports` by conditions as Node does it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, runFix, type RuleResult } from "./index.ts";
import { exportEntries, IMPORT_CONDITIONS, REQUIRE_CONDITIONS, resolveExport } from "./rules/exports-require.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-exports-require-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let count = 0;

/** This function writes a repository, and gives its root. A value that is not a string is written as JSON with 2 spaces. */
function repo(files: Record<string, unknown>): string {
  const root = join(temp, String(count++));
  for (const [file, value] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
  return root;
}

/** The text of a `package.json` as pnpm and the CLI of cue write it. */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** A workspace with one package at packages/lib, and a private root. */
const workspace = (lib: unknown): string =>
  repo({ "package.json": { name: "root", private: true }, "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n', "packages/lib/package.json": json(lib) });

function check(root: string, today = "2026-12-01"): RuleResult {
  const result = runChecks({ root, only: ["exports-require"], today }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

/** The shape of the rigor packages before rigor#196: source entries for the workspace, build entries with only types and import for npm. */
const RIGOR = {
  name: "@x/lib",
  version: "0.1.27",
  type: "module",
  main: "./src/index.ts",
  exports: { ".": { types: "./src/index.ts", import: "./src/index.ts" }, "./model": { types: "./src/model.ts", import: "./src/model.ts" } },
  publishConfig: {
    exports: {
      ".": { types: "./build/index.d.ts", import: "./build/index.js" },
      "./model": { types: "./build/model.d.ts", import: "./build/model.js" },
      "./package.json": "./package.json",
    },
  },
};

describe("resolveExport", () => {
  it("examines the keys in their order, and default matches each set of conditions", () => {
    const entry = { types: "./a.d.ts", import: "./a.js", default: "./a.cjs" };
    expect(resolveExport(entry, IMPORT_CONDITIONS)).toEqual({ target: "./a.js", path: ["import"] });
    expect(resolveExport(entry, REQUIRE_CONDITIONS)).toEqual({ target: "./a.cjs", path: ["default"] });
    // default first wins for each set: the keys after it are not examined
    expect(resolveExport({ default: "./d.js", import: "./i.js" }, IMPORT_CONDITIONS)).toEqual({ target: "./d.js", path: ["default"] });
  });

  it("gives undefined when no condition matches, and null for a target null", () => {
    expect(resolveExport({ types: "./a.d.ts", import: "./a.js" }, REQUIRE_CONDITIONS)).toBeUndefined();
    expect(resolveExport({ import: "./a.js", require: null }, REQUIRE_CONDITIONS)).toBeNull();
    expect(resolveExport([], REQUIRE_CONDITIONS)).toBeNull();
  });

  it("goes into nested conditions, and goes on to the next key when a nested object matches nothing", () => {
    const entry = { node: { import: "./n.js" }, default: "./d.js" };
    expect(resolveExport(entry, IMPORT_CONDITIONS)).toEqual({ target: "./n.js", path: ["node", "import"] });
    expect(resolveExport(entry, REQUIRE_CONDITIONS)).toEqual({ target: "./d.js", path: ["default"] });
  });

  it("gives the first item of an array that resolves, else null when an item is null, as Node does", () => {
    expect(resolveExport([{ import: "./i.js" }, "./s.js"], REQUIRE_CONDITIONS)).toEqual({ target: "./s.js", path: [1] });
    expect(resolveExport([null, { import: "./i.js" }], REQUIRE_CONDITIONS)).toBeNull();
    expect(resolveExport([{ import: "./i.js" }], REQUIRE_CONDITIONS)).toBeUndefined();
  });

  it("gives the entries by subpath, and none for an object that mixes subpaths and conditions", () => {
    expect(exportEntries("./i.js")).toEqual([[".", "./i.js"]]);
    expect(exportEntries({ import: "./i.js" })).toEqual([[".", { import: "./i.js" }]]);
    expect(exportEntries({ ".": "./i.js", "./x": "./x.js" })).toHaveLength(2);
    expect(exportEntries({ ".": "./i.js", import: "./x.js" })).toEqual([]);
    expect(exportEntries(undefined)).toEqual([]);
  });
});

describe("exports-require", () => {
  it("breaks on each entry of the rigor shape with only types and import, and fix adds default as the last member", () => {
    const root = workspace(RIGOR);
    const result = check(root);
    expect(result.status).toBe("break");
    expect(result.breaks.map((item) => [item.file, item.line, item.message])).toEqual([
      [
        "packages/lib/package.json",
        18,
        'The entry "." of publishConfig.exports of @x/lib resolves for import (./build/index.js) and not for require: require() of it stops with ERR_PACKAGE_PATH_NOT_EXPORTED.',
      ],
      [
        "packages/lib/package.json",
        22,
        'The entry "./model" of publishConfig.exports of @x/lib resolves for import (./build/model.js) and not for require: require() of it stops with ERR_PACKAGE_PATH_NOT_EXPORTED.',
      ],
    ]);
    runFix({ root, only: ["exports-require"] });
    const fixed = {
      ...RIGOR,
      publishConfig: {
        exports: {
          ".": { types: "./build/index.d.ts", import: "./build/index.js", default: "./build/index.js" },
          "./model": { types: "./build/model.d.ts", import: "./build/model.js", default: "./build/model.js" },
          "./package.json": "./package.json",
        },
      },
    };
    // The fix changes only the two entries: the text is the text that pnpm writes for the fixed manifest
    expect(readFileSync(join(root, "packages/lib/package.json"), "utf8")).toBe(json(fixed));
    expect(check(root).status).toBe("pass");
  });

  it("passes when each entry has default or require, and accepts a target null for require", () => {
    const withDefault = { ".": { types: "./build/index.d.ts", import: "./build/index.js", default: "./build/index.js" } };
    const withRequire = { ".": { import: "./build/index.js", require: "./build/index.cjs" } };
    const excluded = { ".": { import: "./build/index.js", require: null } };
    for (const exports of [withDefault, withRequire, excluded, "./build/index.js", ["./build/index.js"]]) {
      expect(check(workspace({ ...RIGOR, publishConfig: { exports } })).status).toBe("pass");
    }
  });

  it("reads exports when publishConfig has no exports, and leaves a private package alone", () => {
    const { publishConfig: _, ...plain } = RIGOR;
    const result = check(workspace(plain));
    expect(result.breaks.map((item) => item.message.slice(0, 40))).toEqual(["The entry \".\" of exports of @x/lib resol", "The entry \"./model\" of exports of @x/lib"]);
    expect(check(workspace({ ...RIGOR, private: true })).status).toBe("pass");
  });

  it("fixes a field of conditions with no subpaths on one line, and keeps CRLF line ends", () => {
    const text = '{\r\n  "name": "one",\r\n  "version": "1.0.0",\r\n  "exports": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }\r\n}\r\n';
    const root = repo({ "package.json": text });
    const result = check(root);
    expect(result.breaks.map((item) => [item.file, item.line])).toEqual([["package.json", 4]]);
    runFix({ root, only: ["exports-require"] });
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(
      '{\r\n  "name": "one",\r\n  "version": "1.0.0",\r\n  "exports": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "default": "./dist/index.js" }\r\n}\r\n',
    );
    expect(check(root).status).toBe("pass");
  });

  it("fixes nested conditions in the object that holds import, so a browser target keeps its place", () => {
    const lib = { ...RIGOR, publishConfig: { exports: { ".": { node: { import: "./build/node.js" }, browser: "./build/browser.js" } } } };
    const root = workspace(lib);
    expect(check(root).status).toBe("break");
    runFix({ root, only: ["exports-require"] });
    const fixed = { ...RIGOR, publishConfig: { exports: { ".": { node: { import: "./build/node.js", default: "./build/node.js" }, browser: "./build/browser.js" } } } };
    expect(readFileSync(join(root, "packages/lib/package.json"), "utf8")).toBe(json(fixed));
    expect(check(root).status).toBe("pass");
  });

  it("fixes an object of conditions in an array, in that item", () => {
    const root = workspace({ ...RIGOR, publishConfig: { exports: { ".": [{ import: "./build/index.js" }] } } });
    expect(check(root).status).toBe("break");
    runFix({ root, only: ["exports-require"] });
    const fixed = { ...RIGOR, publishConfig: { exports: { ".": [{ import: "./build/index.js", default: "./build/index.js" }] } } };
    expect(readFileSync(join(root, "packages/lib/package.json"), "utf8")).toBe(json(fixed));
    expect(check(root).status).toBe("pass");
  });

  it("gives a fix text and no edit when the object of import already has a default that matches nothing", () => {
    const nested = check(workspace({ ...RIGOR, publishConfig: { exports: { ".": { import: "./build/index.js", default: { browser: "./b.js" } } } } }));
    expect(nested.status).toBe("break");
    expect(nested.breaks[0]?.edits).toBeUndefined();
    expect(nested.breaks[0]?.fix).toBe(
      'Give the entry "." of publishConfig.exports a target for require: "default": "./build/index.js" as the last member of the object that holds "import", or "require": "./build/index.js" before its "default".',
    );
  });

  it("is a warning before its day failsFrom, and a break on that day", () => {
    const root = workspace(RIGOR);
    expect(check(root, "2026-11-26").status).toBe("warn");
    expect(check(root, "2026-11-27").status).toBe("break");
  });
});
