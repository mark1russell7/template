// The tests of exports.ts: node --test scripts/homes/

import assert from "node:assert/strict";
import { test } from "node:test";
import { indexModule, valueNames } from "./exports.ts";

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
