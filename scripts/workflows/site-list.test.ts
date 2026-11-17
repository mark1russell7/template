// Tests of the sites of the audit of the live sites (site-list.ts): the sites of each owner, the named sites, the skip,
// and the errors of a name that no owner has or that two owners have.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listOf, siteList } from "./site-list.ts";

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
