import { defineConfig } from "tsdown";

// The build of the CLI for npm: one ES module in build/, with the shebang of the source. The workspace runs the source with tsx.
// The package has a bin and no entry to import, so it has no types, and attw has nothing to examine.
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "build",
  format: "esm",
  platform: "node",
  fixedExtension: false,
  sourcemap: true,
  dts: false,
  publint: true,
});
