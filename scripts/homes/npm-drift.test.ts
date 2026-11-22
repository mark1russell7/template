// The tests of npm-drift.ts: the split of the differences by the base map, the report and the read of a map file.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { NpmDrift } from "../../packages/conventions/src/map.ts";
import { driftKey, homesOf, report, splitByBase } from "./npm-drift.ts";

const temp = mkdtempSync(join(tmpdir(), "npm-drift-"));
after(() => rmSync(temp, { recursive: true, force: true }));

const stale: NpmDrift = { area: "search", kind: "stale-pending", name: "@s/search", text: "search: @s/search is on npm" };
const missing: NpmDrift = { area: "labs", kind: "missing", name: "@s/labs", text: "labs: @s/labs is not on npm" };
const noRead: NpmDrift = { area: "geo", kind: "no-read", name: "@s/geo", text: "geo: no read of @s/geo on npm (HTTP 503)" };
const unnamed: NpmDrift = { area: "cli", kind: "unnamed", text: "cli: the planned home names no package in pending" };

test("a difference of the base does not fail the pull request, and a new one does", () => {
  const { added, inherited } = splitByBase([stale, missing], [stale]);
  assert.deepEqual(added, [missing]);
  assert.deepEqual(inherited, [stale]);
  assert.equal(report(added, 3, inherited).code, 1);
  assert.equal(report([], 3, [stale]).code, 0);
});

test("a no read fails also when the base has the same no read", () => {
  const { added, inherited } = splitByBase([noRead], [noRead]);
  assert.deepEqual(added, [noRead]);
  assert.deepEqual(inherited, []);
  assert.equal(report(added, 1, inherited).code, 1);
});

test("the key tells the kind, the area and the name apart", () => {
  assert.notEqual(driftKey(stale), driftKey({ ...stale, kind: "stale-state" }));
  assert.notEqual(driftKey(stale), driftKey({ ...stale, area: "other" }));
  assert.notEqual(driftKey(stale), driftKey({ ...stale, name: "@s/other" }));
});

test("the report names the differences of the base apart from the differences of the change", () => {
  const { text } = report([missing], 4, [stale, unnamed]);
  assert.match(text, /^The map of homes against npm: 4 names asked, 1 difference\.\n- missing: labs/);
  assert.match(text, /The base branch has 1 more difference\. They do not fail this pull request.*\n- stale-pending: search/);
  assert.doesNotMatch(text, /unnamed: cli/);
});

test("the report with no base is the report of before", () => {
  assert.equal(report([stale, unnamed], 2).text, "The map of homes against npm: 2 names asked, 1 difference.\n- stale-pending: search: @s/search is on npm\nNo read: the planned homes cli name no package in pending.\n");
});

test("a map file of another commit gives its homes, and a file with no HOMES is an error", async () => {
  const good = join(temp, "map.ts");
  writeFileSync(good, 'export const HOMES = [{ area: "a", title: "A", covers: "x", packages: [], repo: "o/a", state: "planned", words: [] }];\n');
  assert.deepEqual((await homesOf(good)).map((home) => home.area), ["a"]);
  const bad = join(temp, "bad.ts");
  writeFileSync(bad, "export const OTHER = 1;\n");
  await assert.rejects(homesOf(bad), /exports no HOMES list/);
});
