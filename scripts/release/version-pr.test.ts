// The tests of version-pr.ts: node --test scripts/release/

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Gh } from "./dispatch.ts";
import { addNote, headCheck, main, NOTE, NOTE_MARK, startHeldChecks, withNote } from "./version-pr.ts";

const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const SHA = "a".repeat(40);

/** A fake gh: it gives the answer of the first rule whose start matches the arguments, and keeps each call. */
function fakeGh(rules: readonly (readonly [string, string | Error])[]): { run: Gh; calls: string[][]; bodies: string[] } {
  const calls: string[][] = [];
  const bodies: string[] = [];
  const run: Gh = (args) => {
    calls.push([...args]);
    const file = args[args.indexOf("--body-file") + 1];
    if (args.includes("--body-file") && file !== undefined) bodies.push(readFileSync(file, "utf8"));
    const rule = rules.find(([start]) => args.join(" ").startsWith(start));
    if (rule === undefined) throw new Error(`no rule for gh ${args.join(" ")}`);
    if (rule[1] instanceof Error) throw rule[1];
    return rule[1];
  };
  return { run, calls, bodies };
}

test("withNote puts the steps at the top once", () => {
  const body = "This PR was opened by the Changesets release GitHub action.\n\n# Releases";
  const once = withNote(body);
  assert.ok(once.startsWith(`${NOTE_MARK}\n`));
  assert.ok(once.endsWith(body));
  assert.equal(withNote(once), once);
  assert.equal(withNote(""), `${NOTE}\n`);
});

test("the steps tell a person to wait for the checks, and to merge the pull request with an own account", () => {
  assert.match(NOTE, /starts the same workflows with workflow_dispatch/u);
  assert.match(NOTE, /--ref changeset-release\/main/u);
  assert.match(NOTE, /merge the pull request with your own account/u);
});

const HEAD = `${SHA} changeset-release/main\n`;
const RUNS = `api repos/o/r/actions/runs?head_sha=${SHA}&event=pull_request`;

test("startHeldChecks starts each held workflow once, with workflow_dispatch on the branch of the pull request", () => {
  const fake = fakeGh([
    ["pr view 12 --repo o/r --json headRefOid,headRefName", HEAD],
    [RUNS, ".github/workflows/ci.yml\n.github/workflows/security.yml\n.github/workflows/ci.yml\n"],
    ["workflow run", ""],
  ]);
  const result = startHeldChecks("o/r", "12", fake.run, () => undefined);
  assert.deepEqual(result.started, ["ci.yml", "security.yml"]);
  const starts = fake.calls.filter((call) => call[0] === "workflow");
  assert.deepEqual(starts, [
    ["workflow", "run", "ci.yml", "--repo", "o/r", "--ref", "changeset-release/main"],
    ["workflow", "run", "security.yml", "--repo", "o/r", "--ref", "changeset-release/main"],
  ]);
});

test("startHeldChecks reads the runs again until GitHub has made them, and stops after the last try", () => {
  let reads = 0;
  const waits: number[] = [];
  const late: Gh = (args) => {
    if (args[0] === "pr") return HEAD;
    if (args[0] === "api") return (reads += 1) < 3 ? "" : ".github/workflows/ci.yml\n";
    return "";
  };
  assert.deepEqual(startHeldChecks("o/r", "12", late, (ms) => waits.push(ms)).started, ["ci.yml"]);
  assert.deepEqual(waits, [5000, 5000]);

  const none = fakeGh([
    ["pr view 12", HEAD],
    [RUNS, ""],
  ]);
  const result = startHeldChecks("o/r", "12", none.run, () => undefined, 3);
  assert.deepEqual(result.started, []);
  assert.match(result.lines[0] ?? "", /holds no run/u);
  assert.equal(none.calls.filter((call) => call[0] === "api").length, 3);
});

test("startHeldChecks warns for a workflow with no workflow_dispatch trigger, and still starts the others", () => {
  const fake: Gh = (args) => {
    if (args[0] === "pr") return HEAD;
    if (args[0] === "api") return ".github/workflows/ci.yml\n.github/workflows/old.yml\n";
    if (args[2] === "old.yml") throw new Error("HTTP 422: Workflow does not have 'workflow_dispatch' trigger");
    return "";
  };
  const result = startHeldChecks("o/r", "12", fake, () => undefined);
  assert.deepEqual(result.started, ["ci.yml"]);
  assert.match(result.lines.join("\n"), /^::warning title=Version pull request::old\.yml did not start/mu);
});

test("startHeldChecks refuses a pull request with no head", () => {
  const fake = fakeGh([["pr view 12", " \n"]]);
  assert.throws(() => startHeldChecks("o/r", "12", fake.run, () => undefined), /has no head commit and branch/u);
});

test("headCheck: the head of main changes the pull request, an older commit of main does not", () => {
  const head = fakeGh([[`api repos/o/r/compare/main...${SHA}`, "identical\n"]]);
  assert.equal(headCheck("o/r", SHA, head.run).head, true);
  const behind = fakeGh([[`api repos/o/r/compare/main...${SHA}`, "behind\n"]]);
  const result = headCheck("o/r", SHA, behind.run);
  assert.equal(result.head, false);
  assert.match(result.line, /^::notice title=Version pull request::main has commits after/u);
});

test("headCheck: a commit that is not on main is an error", () => {
  const ahead = fakeGh([[`api repos/o/r/compare/main...${SHA}`, "diverged\n"]]);
  assert.throws(() => headCheck("o/r", SHA, ahead.run), /is not on main \(status: diverged\)/u);
});

test("addNote edits the text once, and not again when the text has the steps", () => {
  const fresh = fakeGh([
    ["pr view 12 --repo o/r --json body", "Releases\n"],
    ["pr edit 12 --repo o/r --body-file", ""],
  ]);
  assert.equal(addNote("o/r", "12", fresh.run), true);
  assert.deepEqual(fresh.bodies, [withNote("Releases")]);

  const done = fakeGh([["pr view 12 --repo o/r --json body", `${withNote("Releases")}\n`]]);
  assert.equal(addNote("o/r", "12", done.run), false);
  assert.equal(done.calls.length, 1);
});

test("main head writes head=true or head=false to GITHUB_OUTPUT", () => {
  const folder = mkdtempSync(join(tmpdir(), "version-pr-"));
  folders.push(folder);
  const output = join(folder, "output.txt");
  const env = { GITHUB_REPOSITORY: "o/r", GITHUB_SHA: SHA, GITHUB_OUTPUT: output };
  assert.equal(main(["head"], env, fakeGh([["api", "identical"]]).run), 0);
  assert.equal(main(["head"], env, fakeGh([["api", "behind"]]).run), 0);
  assert.equal(readFileSync(output, "utf8"), "head=true\nhead=false\n");
});

test("main gives 1 for an error of gh, and 2 for a wrong command", () => {
  const env = { GITHUB_REPOSITORY: "o/r", GITHUB_SHA: SHA };
  assert.equal(main(["head"], env, fakeGh([["api", new Error("HTTP 502")]]).run), 1);
  assert.equal(main(["note", "12; rm"], env, fakeGh([]).run), 2);
  assert.equal(main(["checks", "-1"], env, fakeGh([]).run), 2);
  assert.equal(main(["publish"], env, fakeGh([]).run), 2);
});
