import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cruise } from "dependency-cruiser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boundaries, boundaryRules, entryPattern, packageEntries, workspaceGlobs, workspacePackages } from "./index.ts";

describe("workspaceGlobs", () => {
  it("reads the packages list of pnpm-workspace.yaml", () => {
    const yaml = 'packages:\n  - "packages/*"\n  - apps/** # the apps\n  - "!packages/old"\nonlyBuiltDependencies:\n  - esbuild\n';
    expect(workspaceGlobs(yaml)).toEqual(["packages/*", "apps/**", "!packages/old"]);
  });
});

describe("packageEntries", () => {
  it("takes each target of exports, with subpath patterns and a changed extension", () => {
    const entries = packageEntries("packages/b", {
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./tools/*": "./dist/tools/*.js", "./package.json": "./package.json" },
    }).map((source) => new RegExp(source));
    const allowed = (path: string) => entries.some((re) => re.test(path));
    expect(allowed("packages/b/dist/index.js")).toBe(true);
    expect(allowed("packages/b/dist/index.ts")).toBe(true);
    expect(allowed("packages/b/dist/tools/a/b.js")).toBe(true);
    expect(allowed("packages/b/dist/internal.js")).toBe(false);
    expect(allowed("packages/b/src/index.ts")).toBe(false);
  });

  it("uses main, and index.js when the package has no entry field", () => {
    expect(packageEntries("p", { main: "./src/index.ts" })).toEqual([entryPattern("p", "./src/index.ts")]);
    expect(packageEntries("p", {})).toEqual([entryPattern("p", "./index.js")]);
  });
});

describe("boundaryRules", () => {
  it("makes rules for each package and for the apps", () => {
    const rules = boundaryRules(
      [
        { name: "@x/a", dir: "packages/a", private: false, entries: [] },
        { name: "@x/app", dir: "packages/app", private: true, entries: [] },
      ],
      { apps: "private", reference: "ADR-1." },
    );
    expect(rules.map((r) => r.name)).toEqual([
      "relative-import-out-of-x-a",
      "deep-import-into-x-a",
      "relative-import-out-of-x-app",
      "deep-import-into-x-app",
      "not-a-declared-export",
      "import-of-the-app-x-app",
    ]);
    expect(rules.every((r) => r.comment?.startsWith("ADR-1. "))).toBe(true);
  });
});

// A small workspace on disk, cruised by dependency-cruiser with the configuration of boundaries().
describe("boundaries with dependency-cruiser", () => {
  let root = "";
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const pkg = (dir: string, manifest: Record<string, unknown>) =>
    write(`${dir}/package.json`, JSON.stringify({ type: "module", ...manifest }));
  const link = (name: string, dir: string) => {
    mkdirSync(dirname(join(root, "node_modules", name)), { recursive: true });
    symlinkSync(join(root, dir), join(root, "node_modules", name), "junction");
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "boundaries-"));
    write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    pkg("packages/a", { name: "@f/a", exports: { ".": "./src/index.js" } });
    pkg("packages/b", { name: "@f/b", exports: { ".": "./src/index.js", "./util": "./src/util.js" } });
    pkg("packages/c", { name: "@f/c", main: "./src/index.js" });
    pkg("packages/app", { name: "@f/app", private: true, main: "./src/main.js" });
    write("packages/b/src/index.js", "export const b = 1;\n");
    write("packages/b/src/util.js", "export const u = 1;\n");
    write("packages/b/src/internal.js", "export const i = 1;\n");
    write("packages/c/src/index.js", "export const c = 1;\n");
    write("packages/c/src/hidden.js", "export const h = 1;\n");
    write("packages/app/src/main.js", 'import { a } from "@f/a";\nexport const m = a;\n');
    write(
      "packages/a/src/index.js",
      [
        'import { b } from "@f/b";', // an entry: allowed
        'import { u } from "@f/b/util";', // a subpath entry: allowed
        'import { c } from "@f/c";', // main: allowed
        'import { i } from "../../b/src/internal.js";', // a relative import into b, at a file that is not an entry
        'import { x } from "@f/b/src/internal.js";', // not in the exports of b: it does not resolve
        'import { h } from "@f/c/src/hidden.js";', // c has no exports, so it resolves, but it is not an entry
        'import { m } from "@f/app";', // an app
        "export const a = [b, u, c, i, x, h, m];",
        "",
      ].join("\n"),
    );
    for (const [name, dir] of [
      ["@f/a", "packages/a"],
      ["@f/b", "packages/b"],
      ["@f/c", "packages/c"],
      ["@f/app", "packages/app"],
    ] as const) {
      link(name, dir);
    }
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("finds the packages of the workspace", () => {
    expect(workspacePackages(root).map((p) => [p.name, p.dir, p.private])).toEqual([
      ["@f/a", "packages/a", false],
      ["@f/app", "packages/app", true],
      ["@f/b", "packages/b", false],
      ["@f/c", "packages/c", false],
    ]);
  });

  it("reports each break of a boundary, and nothing for the entries", async () => {
    const config = boundaries(root, { apps: "private" });
    const cwd = process.cwd();
    process.chdir(root);
    let result;
    try {
      result = await cruise(["packages"], { ...config.options, ruleSet: { forbidden: config.forbidden }, validate: true });
    } finally {
      process.chdir(cwd);
    }
    const output = result.output as { summary: { violations: { rule: { name: string }; from: string; to: string }[] } };
    const found = output.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`).sort();
    expect(found).toEqual(
      [
        "deep-import-into-f-b: packages/a/src/index.js -> packages/b/src/internal.js",
        "deep-import-into-f-c: packages/a/src/index.js -> packages/c/src/hidden.js",
        "import-of-the-app-f-app: packages/a/src/index.js -> packages/app/src/main.js",
        "not-a-declared-export: packages/a/src/index.js -> @f/b/src/internal.js",
        "relative-import-out-of-f-a: packages/a/src/index.js -> packages/b/src/internal.js",
      ].sort(),
    );
  });
});

// TypeScript source packages, as the template makes them (main is src/index.ts), read with swc.
describe("boundaries on TypeScript source", () => {
  let root = "";
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "boundaries-ts-"));
    write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    write("packages/a/package.json", JSON.stringify({ name: "@t/a", type: "module", main: "./src/index.ts" }));
    write("packages/b/package.json", JSON.stringify({ name: "@t/b", type: "module", main: "./src/index.ts" }));
    write("packages/b/src/index.ts", "export interface B { b: number }\nexport const b: number = 1;\n");
    write("packages/b/src/secret.ts", "export type Secret = { s: string };\n");
    write(
      "packages/a/src/index.ts",
      [
        'import { b } from "@t/b";',
        'import type { Secret } from "@t/b/src/secret.ts";', // a type-only deep import
        "export const a: number = b;",
        "export type S = Secret;",
        "",
      ].join("\n"),
    );
    for (const [name, dir] of [
      ["@t/a", "packages/a"],
      ["@t/b", "packages/b"],
    ] as const) {
      mkdirSync(dirname(join(root, "node_modules", name)), { recursive: true });
      symlinkSync(join(root, dir), join(root, "node_modules", name), "junction");
    }
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("uses swc, and finds a type-only deep import", async () => {
    const config = boundaries(root);
    expect(config.options["parser"]).toBe("swc");
    const cwd = process.cwd();
    process.chdir(root);
    let result;
    try {
      result = await cruise(["packages"], { ...config.options, ruleSet: { forbidden: config.forbidden }, validate: true });
    } finally {
      process.chdir(cwd);
    }
    const output = result.output as { summary: { violations: { rule: { name: string }; from: string; to: string }[] } };
    expect(output.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`)).toEqual([
      "deep-import-into-t-b: packages/a/src/index.ts -> packages/b/src/secret.ts",
    ]);
  });
});
