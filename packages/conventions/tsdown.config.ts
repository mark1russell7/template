import { defineConfig } from "tsdown";

// The build for npm: ES modules in build/. index.js is the library with its types, workspace.js is the
// subpath ./workspace, owners.js is the subpath ./owners, and cli.js is the bin with the shebang of the source. The workspace runs the
// source (main is src/index.ts).
export default defineConfig({
  entry: { index: "src/index.ts", workspace: "src/workspace-entry.ts", owners: "src/owners.ts", cli: "src/cli.ts" },
  outDir: "build",
  format: "esm",
  platform: "node",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
  publint: true,
});
