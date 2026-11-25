// The tests of mode.ts: node --test scripts/release/

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { main, pendingChangesetFiles, releaseMode } from "./mode.ts";

const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** This function makes a repository in a temporary folder, with each file of the map. */
function repo(files: Record<string, unknown>): string {
  const folder = mkdtempSync(join(tmpdir(), "release-mode-"));
  folders.push(folder);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), typeof content === "string" ? content : JSON.stringify(content));
  }
  return folder;
}

const ROOT = { "package.json": { name: "root", private: true }, "packages/a/package.json": { name: "@x/a", version: "0.4.1" } };
const CONFIG = { ".changeset/config.json": { fixed: [] }, ".changeset/README.md": "# Changesets\n" };
const FIX = '---\n"@x/a": patch\n---\n\nA fix.\n';

test("a repository with no .changeset/config.json: the mode publish, as before the mode", () => {
  const folder = repo({ ...ROOT, ".changeset/one.md": FIX });
  assert.equal(pendingChangesetFiles(folder), undefined);
  const decision = releaseMode(folder);
  assert.equal(decision.mode, "publish");
  assert.deepEqual(decision.changesets, []);
  assert.match(decision.reason, /does not use Changesets/u);
});

test("Changesets with no changeset: the mode publish. README.md is not a changeset", () => {
  const folder = repo({ ...ROOT, ...CONFIG });
  assert.deepEqual(pendingChangesetFiles(folder), []);
  assert.equal(releaseMode(folder).mode, "publish");
});

test("Changesets with changesets: the mode version, with the files in order", () => {
  const folder = repo({ ...ROOT, ...CONFIG, ".changeset/b-two.md": FIX, ".changeset/a-one.md": FIX, ".changeset/notes.txt": "x" });
  const decision = releaseMode(folder);
  assert.equal(decision.mode, "version");
  assert.deepEqual(decision.changesets, [".changeset/a-one.md", ".changeset/b-two.md"]);
  assert.match(decision.reason, /^2 changesets wait: \.changeset\/a-one\.md, \.changeset\/b-two\.md\./u);
});

test("the reason lists at most 10 changesets, then a count", () => {
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`.changeset/c${String(i).padStart(2, "0")}.md`, FIX]));
  assert.match(releaseMode(repo({ ...ROOT, ...CONFIG, ...files })).reason, /\.changeset\/c09\.md and 2 more\./u);
});

test("pre mode: a changeset that pre.json names is consumed, and a new one is pending", () => {
  const pre = { mode: "pre", tag: "next", initialVersions: {}, changesets: ["old-one"] };
  const consumed = repo({ ...ROOT, ...CONFIG, ".changeset/pre.json": pre, ".changeset/old-one.md": FIX });
  assert.equal(releaseMode(consumed).mode, "publish");
  const fresh = repo({ ...ROOT, ...CONFIG, ".changeset/pre.json": pre, ".changeset/old-one.md": FIX, ".changeset/new-one.md": FIX });
  assert.deepEqual(releaseMode(fresh).changesets, [".changeset/new-one.md"]);
});

test("pre mode exit: each changeset is pending again", () => {
  const pre = { mode: "exit", tag: "next", initialVersions: {}, changesets: ["old-one"] };
  const folder = repo({ ...ROOT, ...CONFIG, ".changeset/pre.json": pre, ".changeset/old-one.md": FIX });
  assert.deepEqual(releaseMode(folder).changesets, [".changeset/old-one.md"]);
});

test("a pre.json of an unknown form stops the decision", () => {
  assert.throws(() => releaseMode(repo({ ...ROOT, ...CONFIG, ".changeset/pre.json": "{" })), /pre\.json is not JSON/u);
  assert.throws(() => releaseMode(repo({ ...ROOT, ...CONFIG, ".changeset/pre.json": { mode: "pre" } })), /"changesets" as a list/u);
});

test("main writes the mode to GITHUB_OUTPUT and the reason to the summary", () => {
  const plain = repo(ROOT);
  const output = join(plain, "output.txt");
  const summary = join(plain, "summary.md");
  assert.equal(main(plain, { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary }), 0);
  assert.equal(readFileSync(output, "utf8"), "mode=publish\n");
  assert.match(readFileSync(summary, "utf8"), /^Release mode: \*\*publish\*\*\. The repository does not use Changesets\./u);

  const pending = repo({ ...ROOT, ...CONFIG, ".changeset/one.md": FIX });
  const versionOutput = join(pending, "output.txt");
  assert.equal(main(pending, { GITHUB_OUTPUT: versionOutput }), 0);
  assert.equal(readFileSync(versionOutput, "utf8"), "mode=version\n");
});

test("main gives 1 and writes no mode when pre.json is broken", () => {
  const folder = repo({ ...ROOT, ...CONFIG, ".changeset/pre.json": "{" });
  const output = join(folder, "output.txt");
  assert.equal(main(folder, { GITHUB_OUTPUT: output }), 1);
  assert.throws(() => readFileSync(output, "utf8"));
});
