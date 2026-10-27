import { defineConfig } from "tsdown";

// The build for npm: ES modules in build/. index.js is the library with its types, and cli.js is the
// bin with the shebang of the source. The workspace runs the source (main is src/index.ts).
export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  outDir: "build",
  format: "esm",
  platform: "node",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
  publint: true,
});
