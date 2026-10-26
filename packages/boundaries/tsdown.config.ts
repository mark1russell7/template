import { defineConfig } from "tsdown";

// The build for npm: build/index.js (ES module) and build/index.cjs (CommonJS, for a
// .dependency-cruiser.cjs file), with the types. The workspace imports the source (main is src/index.ts).
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "build",
  format: ["esm", "cjs"],
  platform: "node",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
  publint: true,
});
