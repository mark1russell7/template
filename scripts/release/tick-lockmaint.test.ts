// The tests of tick-lockmaint.ts: node --test scripts/release/

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Gh } from "./dispatch.ts";
import { BOX, decide, FIX_TIME, parseArgs, run, stabilityState, TICKED } from "./tick-lockmaint.ts";

const pending = [{ context: "renovate/stability-days", state: "PENDING" }];
const body = `Lock file maintenance\n\n${BOX}If you want to rebase/retry this PR, check this box\n`;

test("the state of the stability check, or none", () => {
  assert.equal(stabilityState(pending), "PENDING");
  assert.equal(stabilityState([{ name: "ci", conclusion: "SUCCESS" }]), "none");
  assert.equal(stabilityState([{ context: "renovate/stability-days", conclusion: "SUCCESS" }]), "SUCCESS");
});

test("a pending check, an unticked box and a public repository give a tick", () => {
  assert.deepEqual(decide(body, pending, "public", false), { kind: "tick" });
});

test("a check that is not pending, a ticked box, or no check give a skip", () => {
  assert.equal(decide(body, [{ context: "renovate/stability-days", state: "SUCCESS" }], "public", false).kind, "skip");
  assert.equal(decide(body.replace(BOX, TICKED), pending, "public", false).kind, "skip");
  assert.equal(decide(body, [], "public", false).kind, "skip");
});

test("a private repository is skipped unless --private is given, because its CI minutes are paid", () => {
  const skip = decide(body, pending, "private", false);
  assert.equal(skip.kind, "skip");
  assert.match(skip.kind === "skip" ? skip.why : "", /paid CI/);
  assert.deepEqual(decide(body, pending, "private", true), { kind: "tick" });
});

test("the options: the defaults and each flag", () => {
  assert.deepEqual(parseArgs([]), { before: FIX_TIME, owners: ["mark1russell7", "metrograph-labs"], dryRun: false, withPrivate: false });
  const o = parseArgs(["--before", "2026-12-01T00:00:00Z", "--owner", "a", "--owner", "b", "--dry-run", "--private"]);
  assert.deepEqual(o, { before: "2026-12-01T00:00:00Z", owners: ["a", "b"], dryRun: true, withPrivate: true });
});

test("a run ticks only the old pending public PR, and a dry run edits nothing", () => {
  const prs = [
    { repository: { nameWithOwner: "o/pub" }, number: 1, updatedAt: "2026-11-25T00:00:00Z" },
    { repository: { nameWithOwner: "o/priv" }, number: 2, updatedAt: "2026-11-25T00:00:00Z" },
    { repository: { nameWithOwner: "o/pub" }, number: 3, updatedAt: "2026-11-27T00:00:00Z" },
  ];
  const edits: string[] = [];
  const gh: Gh = (args) => {
    if (args[0] === "search") return JSON.stringify(prs);
    if (args[0] === "api") return args[1] === "repos/o/pub" ? "public\n" : "private\n";
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ body, statusCheckRollup: pending });
    if (args[0] === "pr" && args[1] === "edit") { edits.push(`${args[4]}#${args[2]}`); return ""; }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const lines = run(gh, parseArgs([]));
  assert.deepEqual(edits, ["o/pub#1"]);
  assert.match(lines[0]!, /o\/pub#1 .*: ticked/);
  assert.match(lines[1]!, /o\/priv#2 .*: skip \(private/);
  assert.deepEqual(JSON.parse(lines.at(-1)!), { before: FIX_TIME, found: 2, ticked: 1, skip: 1 });
  edits.length = 0;
  run(gh, parseArgs(["--dry-run"]));
  assert.deepEqual(edits, []);
});
