// The tests of exports.ts: node --test scripts/homes/

import assert from "node:assert/strict";
import { test } from "node:test";
import { changedPackages, indexModule, namesOf, valueNames } from "./exports.ts";

test("valueNames gives the values of a report, with no types and no default", () => {
  const report = ["# The public API of p", "", "## . (build/index.d.ts): 4 names", "", "median: build/index.d.ts#median", "type Options: build/index.d.ts#Options", "default: build/index.d.ts#default", "QUANTILES: build/index.d.ts#QUANTILES", "median: build/b.d.ts#median"].join("\n");
  assert.deepEqual(valueNames(report), ["QUANTILES", "median"]);
});

test("indexModule sorts the packages and writes one line for each", () => {
  const text = indexModule({ b: { version: "1.0.0", names: ["y"] }, a: { version: "0.1.0", names: ["x"] } });
  const lines = text.split("\n");
  assert.equal(lines[3], '  "a": { version: "0.1.0", names: ["x"] },');
  assert.equal(lines[4], '  "b": { version: "1.0.0", names: ["y"] },');
  assert.ok(text.endsWith("};\n"));
});

test("changedPackages ignores a new version with the same names, and finds new, gone and changed packages", () => {
  const before = indexModule({ a: { version: "0.1.0", names: ["x"] }, b: { version: "1.0.0", names: ["y"] }, c: { version: "2.0.0", names: ["z"] } });
  assert.equal(namesOf(before).size, 3);
  assert.deepEqual(changedPackages(before, indexModule({ a: { version: "0.1.1", names: ["x"] }, b: { version: "1.0.0", names: ["y"] }, c: { version: "2.0.0", names: ["z"] } })), []);
  const after = indexModule({ a: { version: "0.2.0", names: ["x", "w"] }, c: { version: "2.0.0", names: ["z"] }, d: { version: "0.0.1", names: ["v"] } });
  assert.deepEqual(changedPackages(before, after), ["a", "b", "d"]);
  // No index yet: each package is new
  assert.deepEqual(changedPackages("", before), ["a", "b", "c"]);
});
