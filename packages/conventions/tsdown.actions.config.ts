import { defineConfig } from "tsdown";

// The bundles of the shared actions in .github/actions/bundles: one file for each entry, with each dependency in it, so that
// an action runs with no install. The script check:actions of the root builds them again and fails when a committed
// bundle is not current. Each entry is a build of its own, so no two bundles share a chunk. onlyBundle stops a build that
// takes in a package that is not on its list. The test .github/actions/bundles.test.ts examines that each import of a bundle
// is a module of Node.js. A library bundle (types: true) also has a .d.mts file, so that a script of an action that
// imports it has the types.
// A package goes into a bundle with each of its subpaths (`@mark1russell7/files/glob`). A package of `dependencies` is
// external, and a name in alwaysBundle matches only that name, not a subpath.
const withSubpaths = (name: string): RegExp => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:/|$)`);
const bundle = (name: string, entry: string, packages: string[], types = false) =>
  defineConfig({
    entry: { [name]: entry },
    outDir: "../../.github/actions/bundles",
    format: "esm",
    platform: "node",
    target: "node22",
    fixedExtension: true,
    hash: false,
    clean: false,
    dts: types ? { sourcemap: false } : false,
    sourcemap: false,
    minify: false,
    publint: false,
    report: false,
    deps: { alwaysBundle: packages.map(withSubpaths), onlyBundle: packages },
    // No comment with the path of each module: the path names the store folder of pnpm, which a bump of a peer changes
    inputOptions: { experimental: { attachDebugInfo: "none" } },
    banner: { js: `// The bundle of ${entry} of @mark1russell7/conventions. Do not edit: pnpm build:actions writes it.` },
  });

export default [
  bundle("select", "src/select-main.ts", ["@mark1russell7/collections", "@mark1russell7/files"]),
  bundle("private-names", "src/private-names-main.ts", ["@mark1russell7/files"]),
  bundle("files", "src/files-bundle.ts", ["@mark1russell7/files"], true),
];
