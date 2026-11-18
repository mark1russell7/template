import { defineConfig } from "tsdown";

// The bundles of the shared actions in .github/actions/bundles: one file for each entry, with each dependency in it, so that
// an action runs with no install. The script check:actions of the root builds them again and fails when a committed
// bundle is not current. Each entry is a build of its own, so no two bundles share a chunk. onlyBundle stops a build that
// takes in a package that is not on its list. The test .github/actions/bundles.test.ts examines that each import of a bundle
// is a module of Node.js.
const bundle = (name: string, entry: string, packages: string[]) =>
  defineConfig({
    entry: { [name]: entry },
    outDir: "../../.github/actions/bundles",
    format: "esm",
    platform: "node",
    target: "node22",
    fixedExtension: true,
    hash: false,
    clean: false,
    dts: false,
    sourcemap: false,
    minify: false,
    publint: false,
    report: false,
    deps: { alwaysBundle: packages, onlyBundle: packages },
    // No comment with the path of each module: the path names the store folder of pnpm, which a bump of a peer changes
    inputOptions: { experimental: { attachDebugInfo: "none" } },
    banner: { js: `// The bundle of ${entry} of @mark1russell7/conventions. Do not edit: pnpm build:actions writes it.` },
  });

export default [bundle("select", "src/select-main.ts", ["@mark1russell7/collections", "@mark1russell7/files"])];
