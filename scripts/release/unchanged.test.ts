// The tests of unchanged.ts: node --test scripts/release/

import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { caretLine, installedManifest, shippedDifferences, tarballFiles } from "./unchanged.ts";

// A small ustar writer, enough for the tests: regular files, folders and pax path records.
function header(name: string, size: number, type: string, mtime: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write(`${mtime.toString(8).padStart(11, "0")}\0`, 136);
  block.write("        ", 148);
  block.write(type, 156);
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function entry(name: string, data: Buffer, type: string, mtime: number): Buffer[] {
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return [header(name, data.length, type, mtime), data, padding];
}

function tgz(files: Record<string, string>, options: { mtime?: number; reverse?: boolean; pax?: boolean } = {}): Buffer {
  const mtime = options.mtime ?? 499162500;
  const names = Object.keys(files);
  if (options.reverse) names.reverse();
  const parts: Buffer[] = [...entry("package/", Buffer.alloc(0), "5", mtime)];
  for (const name of names) {
    const path = `package/${name}`;
    const data = Buffer.from(files[name] ?? "", "utf8");
    if (options.pax) {
      const record = ` path=${path}\n`;
      let length = record.length;
      while (`${length}${record}`.length !== length) length = `${length}${record}`.length;
      parts.push(...entry("PaxHeader", Buffer.from(`${length}${record}`, "utf8"), "x", mtime));
      parts.push(...entry("short-name", data, "0", mtime));
    } else {
      parts.push(...entry(path, data, "0", mtime));
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: options.mtime ? 1 : 9 });
}

const manifest = (fields: Record<string, unknown>): string =>
  JSON.stringify({ name: "@scope/core", version: "0.1.23", main: "build/index.js", ...fields }, null, 2);

const BASE = {
  "package.json": manifest({ dependencies: { a: "^1.0.0" }, devDependencies: { vitest: "^3.0.0" }, scripts: { build: "tsc" } }),
  "build/index.js": "export const answer = 42;\n",
  "README.md": "# core\n",
};

const differences = (published: Record<string, string>, packed: Record<string, string>, options: Parameters<typeof tgz>[1] = {}): string[] =>
  shippedDifferences(tarballFiles(tgz(published)), tarballFiles(tgz(packed, options)));

test("reads the files of a tarball, without the first folder and without the folders", () => {
  const files = tarballFiles(tgz(BASE));
  assert.deepEqual([...files.keys()].sort(), ["README.md", "build/index.js", "package.json"]);
  assert.equal(files.get("build/index.js")?.toString("utf8"), BASE["build/index.js"]);
});

test("reads the path of a pax record, for a long path", () => {
  const long = `build/${"x".repeat(120)}.js`;
  const files = tarballFiles(tgz({ [long]: "a\n" }, { pax: true }));
  assert.deepEqual([...files.keys()], [long]);
});

test("green: the same files give no difference, with other times, order and compression", () => {
  assert.deepEqual(differences(BASE, BASE, { mtime: 1700000000, reverse: true }), []);
});

test("green: a change of devDependencies or of a script that is not an install script", () => {
  const packed = { ...BASE, "package.json": manifest({ dependencies: { a: "^1.0.0" }, devDependencies: { vitest: "^4.0.0" }, scripts: { build: "tsc -b", test: "vitest" } }) };
  assert.deepEqual(differences(BASE, packed), []);
});

test("green: the key order of package.json does not count", () => {
  const packed = { ...BASE, "package.json": JSON.stringify({ scripts: { build: "tsc" }, devDependencies: { vitest: "^3.0.0" }, dependencies: { a: "^1.0.0" }, main: "build/index.js", version: "0.1.23", name: "@scope/core" }) };
  assert.deepEqual(differences(BASE, packed), []);
});

test("red: a change of the code that ships", () => {
  assert.deepEqual(differences(BASE, { ...BASE, "build/index.js": "export const answer = 43;\n" }), ["build/index.js (changed)"]);
});

test("red: a file added or removed", () => {
  const { "README.md": _readme, ...withoutReadme } = BASE;
  assert.deepEqual(differences(BASE, { ...withoutReadme, "build/extra.js": "x\n" }), ["README.md (removed)", "build/extra.js (added)"]);
});

test("red: a change of dependencies, exports or an install script", () => {
  assert.deepEqual(differences(BASE, { ...BASE, "package.json": manifest({ dependencies: { a: "^2.0.0" }, devDependencies: { vitest: "^3.0.0" } }) }), ["package.json (changed)"]);
  assert.deepEqual(differences(BASE, { ...BASE, "package.json": manifest({ dependencies: { a: "^1.0.0" }, exports: { ".": "./build/index.js" } }) }), ["package.json (changed)"]);
  assert.deepEqual(differences(BASE, { ...BASE, "package.json": manifest({ dependencies: { a: "^1.0.0" }, scripts: { postinstall: "node x.js" } }) }), ["package.json (changed)"]);
});

test("a caret range counts by its line", () => {
  assert.equal(caretLine("^0.38.4"), "^0.38");
  assert.equal(caretLine("^1.2.3"), "^1");
  assert.equal(caretLine("^0.0.5"), "^0.0.5");
  assert.equal(caretLine("~1.2.3"), "~1.2.3");
  assert.equal(caretLine(">=1 <2"), ">=1 <2");
});

const withDependencies = (dependencies: Record<string, string>): Record<string, string> => ({
  ...BASE,
  "package.json": manifest({ dependencies, devDependencies: { vitest: "^3.0.0" }, scripts: { build: "tsc" } }),
});

test("green: a sibling release raises the floor of a caret range (seen 11-08: api-report ^0.38.1 to ^0.38.4)", () => {
  assert.deepEqual(differences(withDependencies({ a: "^0.38.1" }), withDependencies({ a: "^0.38.4" })), []);
  assert.deepEqual(differences(BASE, withDependencies({ a: "^1.4.0" })), []);
});

test("red: a caret range on a new line, or a new dependency", () => {
  assert.deepEqual(differences(withDependencies({ a: "^0.38.1" }), withDependencies({ a: "^0.39.0" })), ["package.json (changed)"]);
  assert.deepEqual(differences(withDependencies({ a: "^0.38.1" }), withDependencies({ a: "^0.38.1", b: "^1.0.0" })), ["package.json (changed)"]);
});

test("the installed manifest keeps install scripts and drops the others", () => {
  const raw = Buffer.from(manifest({ scripts: { build: "tsc", postinstall: "node x.js" }, devDependencies: { a: "1" } }));
  const kept = JSON.parse(installedManifest(raw)) as Record<string, unknown>;
  assert.deepEqual(kept["scripts"], { postinstall: "node x.js" });
  assert.equal(kept["devDependencies"], undefined);
});
