import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cruise } from "dependency-cruiser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  boundaries,
  boundaryRules,
  declaredDependencies,
  defaultOptions,
  doNotFollowPaths,
  entryPattern,
  packageEntries,
  type Rule,
  workspaceGlobs,
  workspacePackages,
  workspaceScopes,
} from "./index.ts";

/** The violations of a cruise, as "rule: from -> to". */
async function violationsOf(root: string, config: { forbidden: Rule[]; options: Record<string, unknown> }, paths: string[]): Promise<string[]> {
  const result = await cruise(paths, { ...config.options, baseDir: root, ruleSet: { forbidden: config.forbidden }, validate: true });
  const output = result.output as { summary: { violations: { rule: { name: string }; from: string; to: string }[] } };
  return output.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`).sort();
}

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
      "unknown-workspace-package",
      "import-of-the-app-x-app",
    ]);
    expect(rules.every((r) => r.comment?.startsWith("ADR-1. "))).toBe(true);
  });

  it("makes unknown-workspace-package for the scopes of the packages, with the workspace packages and the declared dependencies as known names", () => {
    const packages = [
      { name: "@x/a", dir: "packages/a", private: false, entries: [], dependencies: ["@x/ext", "@y/other", "lodash"] },
      { name: "plain", dir: "packages/plain", private: false, entries: [] },
    ];
    const rule = boundaryRules(packages, { dependencies: ["@x/root-dep"] }).find((r) => r.name === "unknown-workspace-package");
    expect(rule?.to).toEqual({ path: "^(@x)/", pathNot: "^(@x/a|@x/ext|@x/root-dep)(/|$)", couldNotResolve: true });
  });

  it("changes the scopes with the option scopes", () => {
    const packages = [
      { name: "@x/a", dir: "packages/a", private: false, entries: [] },
      { name: "@y/b", dir: "packages/b", private: false, entries: [] },
    ];
    expect(workspaceScopes(packages)).toEqual(["@x", "@y"]);
    expect(workspaceScopes(packages, { add: ["z"], remove: ["@y"] })).toEqual(["@x", "@z"]);
    expect(workspaceScopes(packages, ["@w"])).toEqual(["@w"]);
    expect(boundaryRules(packages, { scopes: [] }).some((r) => r.name === "unknown-workspace-package")).toBe(false);
  });
});

describe("declaredDependencies", () => {
  it("reads each dependency field", () => {
    expect(
      declaredDependencies({ dependencies: { b: "1" }, devDependencies: { a: "1" }, peerDependencies: { c: "1" }, optionalDependencies: { b: "1", d: "1" } }),
    ).toEqual(["a", "b", "c", "d"]);
  });
});

describe("defaultOptions", () => {
  it("does not follow node_modules and the build folders of each package", () => {
    const packages = [{ dir: "packages/a" }, { dir: "apps/web.site" }];
    const [modules, build] = doNotFollowPaths(packages);
    expect(modules).toBe("(^|/)node_modules/");
    const re = new RegExp(build ?? "");
    expect(re.test("packages/a/dist/index.js")).toBe(true);
    expect(re.test("packages/a/build/index.js")).toBe(true);
    expect(re.test("apps/web.site/dist/x.js")).toBe(true);
    expect(re.test("packages/a/src/dist/x.js")).toBe(false);
    expect(re.test("packages/b/dist/x.js")).toBe(false);
    expect(doNotFollowPaths(packages, [])).toEqual(["(^|/)node_modules/"]);
    expect(doNotFollowPaths(packages, ["out/"])[1]).toBe("^(packages/a|apps/web\\.site)/(out)/");
  });

  it("resolves with the conditions of an ESM import", () => {
    const options = defaultOptions(undefined, { packages: [] });
    expect(options["enhancedResolveOptions"]).toMatchObject({ conditionNames: ["import", "node", "default"] });
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
    pkg("packages/a", { name: "@f/a", exports: { ".": "./src/index.js" }, dependencies: { "@f/declared": "^1.0.0" } });
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
        'import { t } from "@f/typo";', // a name in the scope @f that is not a package: it does not resolve
        'import { d } from "@f/declared";', // a declared dependency that is not installed: not unknown
        'import { o } from "@other/missing";', // a different scope: not a rule of the boundaries
        "export const a = [b, u, c, i, x, h, m, t, d, o];",
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
        "unknown-workspace-package: packages/a/src/index.js -> @f/typo",
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

// The fixture of the client repository (its scripts/check-boundaries.test.mjs, for boundaries 0.1.0),
// with the rules of client as user rules. With the defaults of 0.1.0, two of its tests failed: the
// analysis followed dist/, and the "require" condition resolved a require-only entry.
describe("boundaries on the fixture of the client repository", () => {
  let root = "";
  let violations: string[] = [];
  let config: ReturnType<typeof boundaries>;
  const REF = "Invariant I9.";
  const write = (files: Record<string, string | object>) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), typeof text === "string" ? text : JSON.stringify(text));
    }
  };
  const link = (name: string, folder: string) => {
    mkdirSync(dirname(join(root, "node_modules", name)), { recursive: true });
    symlinkSync(join(root, "packages", folder), join(root, "node_modules", name), "junction");
  };
  const of = (from: string) => violations.filter((v) => v.includes(`: ${from} -> `)).sort();
  const TRANSPORTS = ["^packages/client/src/adapters/", "^packages/client-mcp/src/transport/"];
  const SERVER = [
    "^packages/client/src/server/(procedure-server|index)\\.ts$",
    "^packages/client/dist/server/",
    "^packages/client-mcp/src/host\\.ts$",
    "^@procedures/server(/|$)",
  ];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "boundaries-client-"));
    write({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      // The built root entry of the core exports the server, as the real one does.
      "packages/client/package.json": { name: "@procedures/client", type: "module", exports: { ".": "./dist/index.js", "./server": "./dist/server/index.js" } },
      "packages/client/dist/index.js": 'export * from "./server/index.js";\n',
      "packages/client/dist/server/index.js": "export const server = 1;\n",
      "packages/client/src/index.ts": 'export { ProcedureServer } from "./server/procedure-server.js";\n',
      "packages/client/src/server/procedure-server.ts": 'import { methodName } from "./method.js";\nexport class ProcedureServer { name = methodName; }\n',
      "packages/client/src/server/method.ts": 'export const methodName = "m";\n',
      "packages/client/src/adapters/http/good.ts": 'import { methodName } from "../../server/method.js";\nexport const m = methodName;\n',
      "packages/client/src/adapters/websocket/through-barrel.ts": 'import { ProcedureServer } from "../../index.js";\nexport const server = ProcedureServer;\n',
      "packages/client-mcp/package.json": { name: "@procedures/mcp-server", type: "module", exports: { ".": "./dist/index.js" } },
      "packages/client-mcp/src/host.ts": "export const host = 1;\n",
      "packages/client-mcp/src/transport/good.ts": 'import { client } from "@procedures/client";\nexport const value = client;\n',
      "packages/client-mcp/src/transport/server-entry.ts": 'import { server } from "@procedures/client/server";\nexport const value = server;\n',
      "packages/client-mcp/src/transport/server-package.ts": 'import { start } from "@procedures/server";\nexport const value = start;\n',
      "packages/lib-a/package.json": { name: "@procedures/lib-a", type: "module", exports: { ".": "./dist/index.js" } },
      "packages/lib-a/src/inside.ts": 'import { x } from "./sub/x.js";\nexport const value = x;\n',
      "packages/lib-a/src/sub/x.ts": "export const x = 1;\n",
      "packages/lib-a/src/by-name.ts": 'import { b } from "@procedures/lib-b";\nexport const value = b;\n',
      "packages/lib-a/src/relative-src.ts": 'import { y } from "../../lib-b/src/y.js";\nexport const value = y;\n',
      "packages/lib-a/src/relative-dist.ts": 'import { b } from "../../lib-b/dist/index.js";\nexport const value = b;\n',
      "packages/lib-a/src/name-src.ts": 'import { y } from "@procedures/lib-b/src/y.js";\nexport const value = y;\n',
      "packages/lib-a/src/not-exported.ts": 'import { y } from "@procedures/lib-b/internal";\nexport const value = y;\n',
      "packages/lib-a/src/require-only.ts": 'import { c } from "@procedures/lib-b/cjs";\nexport const value = c;\n',
      "packages/lib-a/src/app-by-name.ts": 'import { page } from "@procedures/site";\nexport const value = page;\n',
      "packages/lib-a/src/app-relative.ts": 'import { page } from "../../site/src/page.js";\nexport const value = page;\n',
      "packages/lib-b/package.json": { name: "@procedures/lib-b", type: "module", exports: { ".": "./dist/index.js", "./cjs": { require: "./dist/cjs.cjs" } } },
      "packages/lib-b/dist/index.js": "export const b = 1;\n",
      "packages/lib-b/dist/cjs.cjs": "exports.c = 1;\n",
      "packages/lib-b/src/y.ts": "export const y = 1;\n",
      "packages/site/package.json": { name: "@procedures/site", private: true, type: "module", exports: { ".": "./dist/index.js" } },
      "packages/site/dist/index.js": "export const page = 1;\n",
      "packages/site/src/page.ts": 'import { b } from "@procedures/lib-b";\nexport const page = b;\n',
    });
    link("@procedures/client", "client");
    link("@procedures/lib-b", "lib-b");
    link("@procedures/site", "site");
    // Only the defaults, and the two rules of client as user rules with no reference in their comments.
    config = boundaries(root, {
      apps: "private",
      reference: REF,
      forbidden: [
        { name: "transport-imports-server", severity: "error", comment: "A transport does not import the server.", from: { path: TRANSPORTS }, to: { path: SERVER } },
        { name: "transport-reaches-server", severity: "error", from: { path: TRANSPORTS }, to: { path: SERVER, reachable: true } },
        { name: "already-referenced", severity: "error", comment: `${REF} Text.`, from: { path: "^nothing/" }, to: {} },
      ],
    });
    violations = await violationsOf(root, config, ["packages"]);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("does not follow dist/: an import of the root entry of the core does not reach the server in dist/", () => {
    expect(of("packages/client-mcp/src/transport/good.ts")).toEqual([]);
    // The build output is not a start of the analysis.
    expect(violations.filter((v) => v.includes(": packages/client/dist/"))).toEqual([]);
  });

  it("finds a direct import of the server entry in dist/, and a server reached through a barrel in src/", () => {
    expect(of("packages/client-mcp/src/transport/server-entry.ts")).toEqual([
      "transport-imports-server: packages/client-mcp/src/transport/server-entry.ts -> packages/client/dist/server/index.js",
      "transport-reaches-server: packages/client-mcp/src/transport/server-entry.ts -> packages/client/dist/server/index.js",
    ]);
    expect(of("packages/client/src/adapters/websocket/through-barrel.ts")).toEqual([
      "transport-reaches-server: packages/client/src/adapters/websocket/through-barrel.ts -> packages/client/src/server/procedure-server.ts",
    ]);
  });

  it("an import by name reaches only an entry of the exports map, with the conditions of an ESM import", () => {
    expect(of("packages/lib-a/src/name-src.ts")).toEqual(["not-a-declared-export: packages/lib-a/src/name-src.ts -> @procedures/lib-b/src/y.js"]);
    expect(of("packages/lib-a/src/not-exported.ts")).toEqual(["not-a-declared-export: packages/lib-a/src/not-exported.ts -> @procedures/lib-b/internal"]);
    expect(of("packages/lib-a/src/require-only.ts")).toEqual(["not-a-declared-export: packages/lib-a/src/require-only.ts -> @procedures/lib-b/cjs"]);
  });

  it("an import in the scope @procedures names a package of the workspace", () => {
    expect(of("packages/client-mcp/src/transport/server-package.ts")).toEqual([
      "transport-imports-server: packages/client-mcp/src/transport/server-package.ts -> @procedures/server",
      "transport-reaches-server: packages/client-mcp/src/transport/server-package.ts -> @procedures/server",
      "unknown-workspace-package: packages/client-mcp/src/transport/server-package.ts -> @procedures/server",
    ]);
  });

  it("a relative import does not leave its package, into src/ or into dist/", () => {
    expect(of("packages/lib-a/src/relative-src.ts")).toEqual([
      "deep-import-into-procedures-lib-b: packages/lib-a/src/relative-src.ts -> packages/lib-b/src/y.ts",
      "relative-import-out-of-procedures-lib-a: packages/lib-a/src/relative-src.ts -> packages/lib-b/src/y.ts",
    ]);
    expect(of("packages/lib-a/src/relative-dist.ts")).toEqual([
      "relative-import-out-of-procedures-lib-a: packages/lib-a/src/relative-dist.ts -> packages/lib-b/dist/index.js",
    ]);
  });

  it("no package imports an app, by name or by a relative path", () => {
    expect(of("packages/lib-a/src/app-by-name.ts")).toEqual([
      "import-of-the-app-procedures-site: packages/lib-a/src/app-by-name.ts -> packages/site/dist/index.js",
    ]);
    expect(of("packages/lib-a/src/app-relative.ts")).toContain(
      "import-of-the-app-procedures-site: packages/lib-a/src/app-relative.ts -> packages/site/src/page.ts",
    );
  });

  it("the good imports pass", () => {
    for (const file of [
      "packages/client/src/adapters/http/good.ts",
      "packages/client/src/server/procedure-server.ts",
      "packages/client/src/index.ts",
      "packages/client-mcp/src/transport/good.ts",
      "packages/lib-a/src/inside.ts",
      "packages/lib-a/src/by-name.ts",
      "packages/site/src/page.ts",
    ]) {
      expect(of(file), file).toEqual([]);
    }
  });

  it("puts the reference before the comment of each user rule that does not start with it", () => {
    const comment = (name: string) => config.forbidden.find((r) => r.name === name)?.comment;
    expect(comment("transport-imports-server")).toBe(`${REF} A transport does not import the server.`);
    expect(comment("transport-reaches-server")).toBe(REF);
    expect(comment("already-referenced")).toBe(`${REF} Text.`);
  });
});
