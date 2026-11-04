import { defineConfig } from "tsdown";

// The build for npm: ES modules in build/. index.js is the library with its types, chrome.js is the
// browser entry with no Node.js import, explorer/index.js is the response explorer for the browser,
// vite.js is the entry for vite.config.ts, and cli.js is the bin with the shebang of the source. The
// workspace imports the source (main is src/index.ts). A shared chunk has no hash in its name, so the
// API report does not change when only the text of a chunk changes.
export default defineConfig({
  entry: ["src/index.ts", "src/chrome.ts", "src/explorer/index.ts", "src/vite.ts", "src/cli.ts"],
  outDir: "build",
  format: "esm",
  platform: "node",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
  outputOptions: { chunkFileNames: "chunks/[name].js" },
  publint: true,
});
