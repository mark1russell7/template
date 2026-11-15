// The tests of npm-drift.ts: node --test scripts/homes/

import assert from "node:assert/strict";
import { test } from "node:test";
import { presenceOf, presences, report } from "./npm-drift.ts";

/** A fetch that answers from a table of URL ends: a status and a body, or an error to throw. */
function fakeFetch(answers: Record<string, { status: number; body?: unknown } | Error>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(answers).find((end) => url.endsWith(end));
    const answer = key === undefined ? undefined : answers[key];
    if (answer === undefined) throw new Error(`no answer for ${url}`);
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
  }) as typeof fetch;
}

test("presenceOf: a version is on npm, a 404 and no versions are not, another status and a throw are no read", async () => {
  const fetchFn = fakeFetch({
    "/@scope%2fhere": { status: 200, body: { versions: { "1.0.0": {} } } },
    "/@scope%2fgone": { status: 200, body: { versions: {} } },
    "/@scope%2fnew": { status: 404 },
    "/@scope%2fbusy": { status: 503 },
    "/@scope%2fcut": new Error("socket hang up"),
  });
  assert.deepEqual(await presenceOf("@scope/here", fetchFn), { onNpm: true });
  assert.deepEqual(await presenceOf("@scope/gone", fetchFn), { onNpm: false });
  assert.deepEqual(await presenceOf("@scope/new", fetchFn), { onNpm: false });
  assert.deepEqual(await presenceOf("@scope/busy", fetchFn), { error: "HTTP 503" });
  assert.deepEqual(await presenceOf("@scope/cut", fetchFn), { error: "socket hang up" });
});

test("presences gives one answer for each name, in more than one group", async () => {
  const names = Array.from({ length: 14 }, (_, index) => `@scope/p${String(index)}`);
  const fetchFn = fakeFetch(Object.fromEntries(names.map((name, index) => [`/${name.replaceAll("/", "%2f")}`, { status: index % 2 === 0 ? 404 : 200, body: { versions: { "0.1.0": {} } } }])));
  const facts = await presences(names, fetchFn);
  assert.equal(facts.size, 14);
  assert.deepEqual(facts.get("@scope/p0"), { onNpm: false });
  assert.deepEqual(facts.get("@scope/p13"), { onNpm: true });
});

test("report: a difference and a failed read fail the check, a planned home with no name is a no read that passes", () => {
  assert.deepEqual(report([], 3), { code: 0, text: "The map of homes against npm: 3 names asked, 0 differences.\n" });
  const unnamed = report([{ area: "cli", kind: "unnamed", text: "cli: no name" }], 3);
  assert.equal(unnamed.code, 0);
  assert.match(unnamed.text, /No read: the planned homes cli name no package in pending\./);
  const failing = report([{ area: "geo", kind: "stale-pending", name: "@scope/geo", text: "geo: @scope/geo is on npm" }, { area: "x", kind: "no-read", name: "@scope/x", text: "x: no read" }], 3);
  assert.equal(failing.code, 1);
  assert.match(failing.text, /2 differences\.\n- stale-pending: geo: @scope\/geo is on npm\n- no-read: x: no read\n/);
});
