import { defineConfig, type Plugin } from "vite";
import { siteData } from "./src/node/data.ts";

// The Pages workflow sets SITE_BASE to "/template". A local build uses the root.
const env = process.env;
const base = env["SITE_BASE"] ? `${env["SITE_BASE"].replace(/\/$/, "")}/` : "/";
const build = { sha: (env["GITHUB_SHA"] ?? "local").slice(0, 7), date: new Date().toISOString().slice(0, 10) };

/**
 * This plugin gives the module `virtual:site-data`: the files that the CLI writes for each preset, and the shared
 * workflows. The plugin starts the CLI at build time, so the page shows what the CLI of this commit writes.
 */
function data(): Plugin {
  const id = "virtual:site-data";
  const resolved = `\0${id}`;
  return {
    name: "template-site-data",
    resolveId: (source) => (source === id ? resolved : null),
    load: (name) => (name === resolved ? `export default ${JSON.stringify(siteData(build))};` : null),
  };
}

export default defineConfig({
  base,
  plugins: [data()],
  build: { target: "es2022" },
});
