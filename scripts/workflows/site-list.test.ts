// Tests of the sites of the audit of the live sites (site-list.ts): the sites of each owner, the named sites, the skip,
// the errors of a name that no owner has or that two owners have, and the shards of the job nav.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { listOf, NAV_SHARD_SIZE, shardOf, shardsOf, siteList } from "./site-list.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const found = [
  { owner: "mark1russell7", name: "vex" },
  { owner: "metrograph-labs", name: "codeatlas" },
  { owner: "mark1russell7", name: "typeset" },
  { owner: "mark1russell7", name: "mark1russell7.github.io" },
];

test("listOf reads a list with commas", () => {
  assert.deepEqual(listOf(" a, b ,,c "), ["a", "b", "c"]);
  assert.deepEqual(listOf(undefined), []);
});

test("with no names, the list has each site of each owner in order, less the sites to skip", () => {
  const result = siteList(found, [], ["typeset"]);
  assert.deepEqual(result.list, ["codeatlas", "mark1russell7.github.io", "vex"]);
  assert.deepEqual(result.owners, { codeatlas: "metrograph-labs", "mark1russell7.github.io": "mark1russell7", vex: "mark1russell7" });
  assert.deepEqual(result.errors, []);
});

test("with names, the list has the named sites in their order, with the name of GitHub", () => {
  const result = siteList(found, ["Vex", "codeatlas", "vex"], []);
  assert.deepEqual(result.list, ["vex", "codeatlas"]);
  assert.deepEqual(result.owners, { vex: "mark1russell7", codeatlas: "metrograph-labs" });
});

test("a named site that no owner has, and a name that two owners have, are errors", () => {
  const result = siteList([...found, { owner: "mark1russell7", name: "CodeAtlas" }], ["nowhere"], []);
  assert.deepEqual(result.errors, ["More than one owner has a site with the name codeatlas.", "No owner has a public site with the name nowhere."]);
  assert.deepEqual(result.list, []);
});

test("shardOf puts each site in exactly one shard", () => {
  const sites = ["e", "a", "d", "c", "b", "f", "g"];
  const shards = [0, 1, 2, 3].map((shard) => shardOf(sites, shard, 4));
  assert.deepEqual(shards.flat().sort(), [...sites].sort());
  assert.deepEqual(shards[0], ["a", "e"]);
});

test("shardsOf gives the fewest shards of at most the size, with counts that differ by one or less", () => {
  for (const count of [0, 1, 7, 8, 9, 16, 17, 55, 56, 57, 200]) {
    const sites = [...Array(count).keys()].map((at) => `site-${String(at).padStart(3, "0")}`);
    const shards = shardsOf(sites, NAV_SHARD_SIZE);
    assert.equal(shards.length, Math.ceil(count / NAV_SHARD_SIZE), `${String(count)} sites`);
    assert.deepEqual(shards.flatMap((shard) => shard.sites).sort(), sites);
    const sizes = shards.map((shard) => shard.sites.length);
    assert.ok(sizes.every((size) => size >= 1 && size <= NAV_SHARD_SIZE), `${String(count)} sites: ${sizes.join(",")}`);
    if (sizes.length > 0) assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${String(count)} sites: ${sizes.join(",")}`);
    assert.deepEqual(shards.map((shard) => shard.index), [...shards.keys()]);
  }
  assert.deepEqual(shardsOf(["b", "a", "c"], 2), [
    { name: "1 of 2", index: 0, sites: ["a", "c"] },
    { name: "2 of 2", index: 1, sites: ["b"] },
  ]);
});

test("shardsOf refuses a size that is not a positive integer", () => {
  for (const size of [0, -1, 1.5, Number.NaN]) assert.throws(() => shardsOf(["a"], size), RangeError);
});

test("the job nav of site-audit.yml runs one job for each shard of the job sites", () => {
  const text = readFileSync(join(root, ".github/workflows/site-audit.yml"), "utf8");
  const has = (part: string, line: string): void => assert.ok(part.split("\n").includes(line), `no line ${JSON.stringify(line)}`);
  has(text, "      shards: ${{ steps.sites.outputs.shards }}");
  const nav = text.slice(text.indexOf("\n  nav:\n"), text.indexOf("\n  nav-report:\n"));
  has(nav, "    name: nav (${{ matrix.shard.name }})");
  has(nav, "        shard: ${{ fromJSON(needs.sites.outputs.shards) }}");
  has(nav, "          SITES: ${{ toJSON(matrix.shard.sites) }}");
  has(nav, "          name: site-nav-shard-${{ matrix.shard.index }}");
  assert.ok(!nav.includes("matrix.repo"), "the job nav still reads matrix.repo");
});
