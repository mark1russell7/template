// The tests of released.ts: node --test scripts/release/

import assert from "node:assert/strict";
import { test } from "node:test";
import { awaitReleased, remoteTags, type ReadTiming } from "./released.ts";
import type { Packument } from "./workspace.ts";

/** A clock that does not wait: each sleep moves the time forward. */
function fakeTiming(limitMs: number, waitMs: number): ReadTiming & { slept: number[] } {
  let time = 0;
  const slept: number[] = [];
  return {
    slept,
    limitMs,
    waitMs,
    now: () => time,
    sleep: async (ms) => {
      slept.push(ms);
      time += ms;
    },
  };
}

const conventions = { name: "@x/conventions", version: "0.52.7", tag: "@x/conventions@0.52.7" };
const withVersion: Packument = { versions: { "0.52.6": {}, "0.52.7": {} } };
const without: Packument = { versions: { "0.52.6": {} } };

test("remoteTags reads the tags of git ls-remote, also the peeled lines", () => {
  const text = "abc\trefs/tags/v1.0.0\ndef\trefs/tags/@x/a@0.1.0\nfed\trefs/tags/@x/a@0.1.0^{}\r\n\n";
  assert.deepEqual([...remoteTags(text)], ["v1.0.0", "@x/a@0.1.0"]);
});

test("a version with no tag is new: no read of npm", async () => {
  let reads = 0;
  const result = await awaitReleased([conventions], new Set(), async () => (reads++, without), fakeTiming(60_000, 10_000));
  assert.equal(reads, 0);
  assert.deepEqual(result.missing, []);
  assert.equal(result.found.size, 0);
});

test("a tagged version that npm shows late: the reads go on until npm shows it", async () => {
  const answers = [without, without, withVersion];
  const timing = fakeTiming(60_000, 10_000);
  const result = await awaitReleased([conventions], new Set([conventions.tag]), async () => answers.shift(), timing);
  assert.deepEqual(result.missing, []);
  assert.equal(result.found.get("@x/conventions"), withVersion);
  assert.deepEqual(timing.slept, [10_000, 10_000]);
  assert.equal(result.waitedMs, 20_000);
});

test("a tagged version that npm does not show at the limit is missing", async () => {
  const timing = fakeTiming(30_000, 10_000);
  const result = await awaitReleased([conventions], new Set([conventions.tag]), async () => without, timing);
  assert.deepEqual(result.missing, ["@x/conventions@0.52.7"]);
  assert.ok(result.waitedMs <= 30_000);
});

test("a new package that npm does not have yet, with its tag, is missing at the limit", async () => {
  const result = await awaitReleased([conventions], new Set([conventions.tag]), async () => undefined, fakeTiming(0, 10_000));
  assert.deepEqual(result.missing, ["@x/conventions@0.52.7"]);
});
