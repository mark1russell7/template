// The tests of entries.ts: node --test scripts/release/

import assert from "node:assert/strict";
import { test } from "node:test";
import { entryPoints, missingEntryPoints } from "./entries.ts";

// The manifest of @mark1russell7/otel-sink 0.1.0, and the files of its tarball: the build did not run.
const OTEL_SINK = {
  name: "@mark1russell7/otel-sink",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  bin: { "otel-sink": "dist/main.js" },
  exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" }, "./package.json": "./package.json" },
};
const SOURCE_ONLY = ["CHANGELOG.md", "LICENSE", "README.md", "package.json", "src/index.ts", "src/main.ts"];

test("a tarball with no dist misses each entry point that names dist (otel-sink 0.1.0)", () => {
  const missing = missingEntryPoints(OTEL_SINK, SOURCE_ONLY).map(({ field }) => field);
  assert.deepEqual(missing, ["main", "types", 'bin["otel-sink"]', 'exports["."]["types"]', 'exports["."]["default"]']);
});

test("the built tarball misses no entry point", () => {
  const built = [...SOURCE_ONLY, "dist/index.js", "dist/index.d.ts", "dist/main.js"];
  assert.deepEqual(missingEntryPoints(OTEL_SINK, built), []);
});

test("main can omit the extension or name a folder; other fields cannot", () => {
  assert.deepEqual(missingEntryPoints({ main: "lib/index" }, ["lib/index.js"]), []);
  assert.deepEqual(missingEntryPoints({ main: "./lib" }, ["lib/index.js"]), []);
  assert.deepEqual(
    missingEntryPoints({ types: "lib/index" }, ["lib/index.js"]).map(({ field }) => field),
    ["types"],
  );
});

test("a string bin, a string exports and fallback arrays are entry points", () => {
  const manifest = { bin: "cli.js", exports: ["./a.js", "./b.js"] };
  assert.deepEqual(
    entryPoints(manifest).map(({ field, path }) => `${field}=${path}`),
    ["bin=cli.js", "exports[0]=./a.js", "exports[1]=./b.js"],
  );
  assert.deepEqual(missingEntryPoints(manifest, ["cli.js", "a.js"]).map(({ field }) => field), ["exports[1]"]);
});

test("a pattern target needs one matching file, and a null target names no file", () => {
  const manifest = { exports: { "./*": "./dist/*.js", "./internal/*": null } };
  assert.deepEqual(missingEntryPoints(manifest, ["dist/a.js"]), []);
  assert.deepEqual(missingEntryPoints(manifest, ["src/a.ts"]).map(({ field }) => field), ['exports["./*"]']);
});

test("a manifest with no entry fields has nothing to miss", () => {
  assert.deepEqual(missingEntryPoints({ name: "only-files" }, ["README.md"]), []);
});
