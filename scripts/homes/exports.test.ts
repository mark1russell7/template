// The tests of exports.ts: node --test scripts/homes/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GRACE_DAYS, changedPackages, firstChange, indexModule, laterVersions, namesOf, sameNames, valueNames, verdictOf, versionsOf } from "./exports.ts";

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

test("versionsOf gives the version of each package of an index module", () => {
  const text = indexModule({ a: { version: "0.1.0", names: ["x"] }, "@s/b": { version: "1.2.3", names: [] } });
  assert.deepEqual([...versionsOf(text)], [["@s/b", "1.2.3"], ["a", "0.1.0"]]);
});

test("laterVersions gives the versions after a version up to the latest, in the order of the times, with no pre-release", () => {
  const time = {
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-11-16T00:00:00.000Z",
    "0.1.0": "2026-11-01T00:00:00.000Z",
    "0.3.0": "2026-11-10T00:00:00.000Z",
    "0.2.0": "2026-11-05T00:00:00.000Z",
    "0.4.0-rc.1": "2026-11-12T00:00:00.000Z",
    "0.4.0": "2026-11-14T00:00:00.000Z",
    "0.2.1": "2026-11-15T00:00:00.000Z",
  };
  assert.deepEqual(laterVersions(time, "0.1.0", "0.4.0"), ["0.2.0", "0.3.0", "0.4.0"]);
  assert.deepEqual(laterVersions(time, "0.4.0", "0.4.0"), []);
  assert.deepEqual(laterVersions(time, "9.9.9", "0.4.0"), []);
  assert.deepEqual(laterVersions(time, "0.3.0", "0.4.0-rc.1"), ["0.4.0-rc.1"]);
});

test("sameNames compares two lists of names in any order", () => {
  assert.equal(sameNames(["b", "a"], ["a", "b"]), true);
  assert.equal(sameNames(["a"], ["a", "b"]), false);
  assert.equal(sameNames(["a", "c"], ["a", "b"]), false);
  assert.equal(sameNames([], []), true);
});

const releases = {
  "1.0.0": "2026-11-01T00:00:00.000Z",
  "1.0.1": "2026-11-03T00:00:00.000Z",
  "1.1.0": "2026-11-05T00:00:00.000Z",
  "1.2.0": "2026-11-07T00:00:00.000Z",
};

/** A namesAt that gives the names of a table, and records each version that it reads. */
function namesFrom(table: Readonly<Record<string, readonly string[]>>, reads: string[]): (version: string) => Promise<readonly string[]> {
  return async (version) => {
    reads.push(version);
    const names = table[version];
    if (names === undefined) throw new Error(`no tarball for ${version}`);
    return names;
  };
}

test("firstChange skips a later version with the same names, and stops at the first version with other names", async () => {
  const reads: string[] = [];
  const at = namesFrom({ "1.0.1": ["x"], "1.1.0": ["y", "x"], "1.2.0": ["x", "y"] }, reads);
  assert.equal(await firstChange(releases, "1.0.0", "1.2.0", ["x"], at), "2026-11-05T00:00:00.000Z");
  assert.deepEqual(reads, ["1.0.1", "1.1.0"]);
});

test("firstChange gives undefined when each later version has the same names", async () => {
  const reads: string[] = [];
  const at = namesFrom({ "1.0.1": ["x"], "1.1.0": ["x"], "1.2.0": ["x"] }, reads);
  assert.equal(await firstChange(releases, "1.0.0", "1.2.0", ["x"], at), undefined);
  assert.deepEqual(reads, ["1.0.1", "1.1.0", "1.2.0"]);
});

test("firstChange gives the time of the latest version when only the latest version has other names", async () => {
  const at = namesFrom({ "1.0.1": ["x"], "1.1.0": ["x"], "1.2.0": ["x", "z"] }, []);
  assert.equal(await firstChange(releases, "1.0.0", "1.2.0", ["x"], at), "2026-11-07T00:00:00.000Z");
});

test("firstChange fails when the read of a tarball fails, so the check does not pass", async () => {
  const at = namesFrom({ "1.0.1": ["x"], "1.2.0": ["x", "z"] }, []);
  await assert.rejects(firstChange(releases, "1.0.0", "1.2.0", ["x"], at), /no tarball for 1\.1\.0/u);
});

test("verdictOf gives a changed home its grace from the start of its new names, and fails a new or gone package at once", () => {
  const current = indexModule({ a: { version: "0.1.0", names: ["x"] }, b: { version: "1.0.0", names: ["y"] }, gone: { version: "1.0.0", names: ["g"] } });
  const next = indexModule({ a: { version: "0.2.0", names: ["x", "w"] }, b: { version: "1.1.0", names: ["y", "v"] }, fresh: { version: "0.0.1", names: ["f"] } });
  const changed = changedPackages(current, next);
  assert.deepEqual(changed, ["a", "b", "fresh", "gone"]);
  const starts = new Map([
    ["a", "2026-11-14T00:00:00.000Z"],
    ["b", "2026-11-02T00:00:00.000Z"],
    ["fresh", "2026-11-15T00:00:00.000Z"],
  ]);
  const now = new Date("2026-11-16T08:00:00.000Z");
  // a: the names changed on 11-14, so the grace ends on 11-21. b: the names changed on 11-02, so the grace ended on 11-09.
  assert.deepEqual(verdictOf(current, next, changed, starts, now), {
    fail: ["b", "fresh", "gone"],
    grace: [{ name: "a", ends: "2026-11-21T00:00:00.000Z" }],
  });
  // At the end of the grace the check fails. A package with no start also fails.
  assert.deepEqual(verdictOf(current, next, ["a"], starts, new Date("2026-11-21T00:00:00.000Z")).fail, ["a"]);
  assert.deepEqual(verdictOf(current, next, ["a"], new Map(), now).fail, ["a"]);
  assert.equal(GRACE_DAYS, 7);
});

test("the job exports writes and uploads the new index also in the grace", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/homes-npm.yml", import.meta.url), "utf8");
  assert.match(workflow, /\n {8}id: compare\n {8}run: node scripts\/homes\/exports\.ts --check\n/u);
  assert.match(workflow, /\n {8}id: write\n {8}if: \(failure\(\) && steps\.compare\.outcome == 'failure'\) \|\| steps\.compare\.outputs\.stale == 'true'\n/u);
  assert.match(workflow, /\n {8}if: \(failure\(\) \|\| steps\.compare\.outputs\.stale == 'true'\) && steps\.write\.outputs\.changed == 'true'\n/u);
});
