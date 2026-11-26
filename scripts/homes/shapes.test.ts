// The tests of shapes.ts: node --test scripts/homes/

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { functionsOf, MIN_SHAPE_TOKENS, shapeHash, type FunctionShape } from "@mark1russell7/code-shape";
import { HOME_SHAPES } from "../../packages/conventions/src/home-shapes.ts";
import { HOMES } from "../../packages/conventions/src/map.ts";
import { indexPackages } from "./exports.ts";
import { bodyTokens, builtFunctions, entryNames, MAX_SHAPE_TOKENS, selectShapes, SHAPES_FILE, shapesModule, specifierOf } from "./shapes.ts";

/** A function of `count` tokens with the name `name`. */
const fn = (name: string, count: number, token = "$id"): FunctionShape => ({ name, line: 1, tokens: Array.from({ length: count }, (_, index) => (index === 0 ? token : "$id")) });

test("selectShapes keeps the exported functions with a body of 16 to MAX_SHAPE_TOKENS tokens, and one function for each shape in the order of the packages", () => {
  const index = selectShapes([
    ["@o/a", { version: "1.0.0", entries: new Map([[".", ["long", "short", "same", "huge"]], ["./sub", ["renamed", "long"]]]), functions: [fn("long", 20, "a"), fn("short", MIN_SHAPE_TOKENS - 1), fn("inner", 30, "b"), fn("same", 25, "c"), fn("huge", MAX_SHAPE_TOKENS + 1), fn("renamed$1", 22, "d")] }],
    ["@o/b", { version: "2.0.0", entries: new Map([[".", ["copy", "own"]]]), functions: [fn("copy", 25, "c"), fn("own", MIN_SHAPE_TOKENS, "e")] }],
  ]);
  assert.deepEqual(
    index["@o/a"]?.functions.map((item) => item.name),
    ["long", "renamed", "same"],
  );
  // A name of the root entry needs no entry. A name of another entry gives it
  assert.deepEqual(
    index["@o/a"]?.functions.map((item) => item.from),
    [undefined, "@o/a/sub", undefined],
  );
  // The shape of copy is the shape of same of @o/a, so only own stays
  assert.deepEqual(
    index["@o/b"]?.functions.map((item) => item.name),
    ["own"],
  );
  assert.equal(index["@o/b"]?.version, "2.0.0");
});

test("entryNames gives the values of each entry of a report, and specifierOf the entry to import a name from", () => {
  const report = ["# The public API of p", "", "## . (build/index.d.ts): 2 names", "", "median: build/index.d.ts#median", "type Options: build/index.d.ts#Options", "", "## ./read (build/read.d.ts): 2 names", "", "isRecord: build/read.d.ts#isRecord", "median: build/read.d.ts#median", "", "## bin: 1 commands", "", "p: build/cli.js", "", "## Declarations", "", "x: y"].join("\n");
  const entries = entryNames(report);
  assert.deepEqual([...entries], [[".", ["median"]], ["./read", ["isRecord", "median"]]]);
  assert.equal(specifierOf("@o/p", entries, "median"), "@o/p");
  assert.equal(specifierOf("@o/p", entries, "isRecord"), "@o/p/read");
  assert.equal(specifierOf("@o/p", entries, "inner"), undefined);
});

test("shapesModule sorts the packages, and writes one line for each function", () => {
  const text = shapesModule({ b: { version: "1.0.0", functions: [{ name: "y", tokens: ["(", ")"] }, { name: "z", from: "b/sub", tokens: ["$id"] }] }, a: { version: "0.1.0", functions: [] } });
  const lines = text.split("\n");
  assert.equal(lines[3], '  "a": { version: "0.1.0", functions: [] },');
  assert.equal(lines[4], '  "b": { version: "1.0.0", functions: [');
  assert.equal(lines[5], '    { name: "y", tokens: ["(",")"] },');
  assert.equal(lines[6], '    { name: "z", from: "b/sub", tokens: ["$id"] },');
  assert.equal(lines[7], "  ] },");
  assert.ok(text.endsWith("};\n"));
});

test("builtFunctions reads each built JavaScript file, and no file of node_modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "home-shapes-test-"));
  try {
    mkdirSync(join(dir, "build"), { recursive: true });
    mkdirSync(join(dir, "node_modules/x"), { recursive: true });
    writeFileSync(join(dir, "build/index.js"), "export function one(a) {\n  return a + 1;\n}\n");
    writeFileSync(join(dir, "build/two.mjs"), "export const two = (b) => b * 2;\n");
    writeFileSync(join(dir, "build/index.d.ts"), "export declare function one(a: number): number;\n");
    writeFileSync(join(dir, "node_modules/x/index.js"), "export function dependency() {}\n");
    assert.deepEqual(
      builtFunctions(dir).map((item) => item.name),
      ["one", "two"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The index comes from npm, so it is not read on a pull request. Only the map decides its keys, as for the index of the exports.
test("the index has a row for each package of a published home of the map, and no other row", () => {
  const want = [...new Set(indexPackages(HOMES))].sort();
  const have = Object.keys(HOME_SHAPES).sort();
  const missing = want.filter((name) => !have.includes(name));
  const extra = have.filter((name) => !want.includes(name));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, "Run node scripts/homes/shapes.ts after a change of the published homes of the map, and commit the index");
});

test("each function of the index has 16 to MAX_SHAPE_TOKENS tokens, and each shape is in the index one time", () => {
  const hashes = new Set<string>();
  for (const [name, entry] of Object.entries(HOME_SHAPES)) {
    for (const item of entry.functions) {
      assert.ok(item.tokens.length >= MIN_SHAPE_TOKENS && item.tokens.length <= MAX_SHAPE_TOKENS, `${name} ${item.name}: ${item.tokens.length} tokens`);
      const hash = shapeHash(item.tokens);
      assert.ok(!hashes.has(hash), `${name} ${item.name}: a second copy of a shape`);
      hashes.add(hash);
    }
  }
});

test("bodyTokens gives the tokens in the braces after the parameters, with no first return", () => {
  const [isRecord] = functionsOf('export function isRecord(value) {\n  return typeof value === "object" && value !== null && !Array.isArray(value);\n}\n');
  assert.equal(bodyTokens(isRecord?.tokens ?? []).join(" "), "typeof $id === $str && $id !== null && ! $id . $id ( $id )");
  const [arrow] = functionsOf("export const twice = async ({ a = (1) }) => a * 2;\n");
  assert.deepEqual(bodyTokens(arrow?.tokens ?? []), ["$id", "*", "$num"]);
  const [block] = functionsOf("function each(xs) {\n  for (const x of xs) use(x);\n  return xs;\n}\n");
  assert.equal(bodyTokens(block?.tokens ?? []).join(" "), "for ( const $id of $id ) $id ( $id ) return $id");
  assert.deepEqual(bodyTokens(["a", "b"]), ["a", "b"]);
});

test("the index has the body of isRecord of @mark1russell7/optional, and stays small", () => {
  const isRecord = HOME_SHAPES["@mark1russell7/optional"]?.functions.find((item) => item.name === "isRecord");
  assert.equal(isRecord?.tokens.join(" "), "typeof $id === $str && $id !== null && ! $id . $id ( $id )");
  assert.ok(readFileSync(SHAPES_FILE).byteLength < 300 * 1024, "home-shapes.ts is bigger than 300 KB");
});
