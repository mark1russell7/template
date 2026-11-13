// The tests of check-plan.ts: node --test scripts/release/

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { main, pendingChangesets, plan, raisedPackages } from "./check-plan.ts";

const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** This function makes a repository in a temporary folder, with each file of the map. */
function repo(files: Record<string, unknown>): string {
  const folder = mkdtempSync(join(tmpdir(), "check-plan-"));
  folders.push(folder);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), typeof content === "string" ? content : JSON.stringify(content));
  }
  return folder;
}

const ROOT = { "package.json": { name: "root", private: true } };
const A = { "packages/a/package.json": { name: "@x/a", version: "0.4.1" } };
const B = { "packages/b/package.json": { name: "@x/b", version: "1.2.0" } };
const SITE = { "packages/site/package.json": { name: "@x/site", version: "0.0.0", private: true } };
const CONFIG = { ".changeset/config.json": { fixed: [] }, ".changeset/README.md": "# Changesets\n" };

test("a changeset raises each package that it names", () => {
  assert.deepEqual(raisedPackages([{ "@x/b": "patch" }, { "@x/a": "minor" }], [], ["@x/a", "@x/b", "@x/c"]), ["@x/a", "@x/b"]);
});

test("a changeset of one member of a fixed group raises each member", () => {
  assert.deepEqual(raisedPackages([{ "@x/a": "patch" }], [["@x/a", "@x/b"]], ["@x/a", "@x/b", "@x/c"]), ["@x/a", "@x/b"]);
  assert.deepEqual(raisedPackages([{ "@x/c": "patch" }], [["@x/a", "@x/b"]], ["@x/a", "@x/b", "@x/c"]), ["@x/c"]);
});

test("a glob of a fixed group matches the names of the repository", () => {
  assert.deepEqual(raisedPackages([{ "@x/a": "patch" }], [["@x/*"]], ["@x/a", "@x/b", "@y/c"]), ["@x/a", "@x/b"]);
});

test("an empty changeset raises no package", () => {
  assert.deepEqual(raisedPackages([{}], [["@x/a", "@x/b"]], ["@x/a", "@x/b"]), []);
});

test("a repository with no published package: no run, and a notice", () => {
  const result = plan(repo({ ...ROOT, ...SITE }));
  assert.equal(result.run, false);
  assert.match(result.notice, /no published package/u);
});

test("a repository with no .changeset/config.json: a run with no pending package and no notice", () => {
  assert.deepEqual(plan(repo({ ...ROOT, ...A })), { run: true, pending: [], notice: "" });
  assert.equal(pendingChangesets(repo({ ...ROOT, ...A }), ["@x/a"]), undefined);
});

test("Changesets with no changeset: a run with no pending package, and a notice", () => {
  const result = plan(repo({ ...ROOT, ...A, ...CONFIG }));
  assert.equal(result.run, true);
  assert.deepEqual(result.pending, []);
  assert.match(result.notice, /no changeset raises a version/u);
});

test("Changesets with a changeset: the pending packages are the published packages that it raises", () => {
  const result = plan(
    repo({
      ...ROOT,
      ...A,
      ...B,
      ...SITE,
      ...CONFIG,
      ".changeset/one.md": '---\n"@x/a": patch\n"@x/site": patch\n---\n\nA fix.\n',
    }),
  );
  assert.deepEqual(result.pending, ["@x/a"]);
  assert.match(result.notice, /1 pending changesets raise the version of 1 published packages later: @x\/a\./u);
});

test("Changesets with a fixed group: one changeset raises each member", () => {
  const folder = repo({
    ...ROOT,
    ...A,
    ...B,
    ".changeset/config.json": { fixed: [["@x/a", "@x/b"]] },
    ".changeset/one.md": "---\n'@x/b': minor\n---\n\nA feature.\n",
  });
  assert.deepEqual(plan(folder).pending, ["@x/a", "@x/b"]);
  assert.deepEqual(pendingChangesets(folder, ["@x/a", "@x/b"])?.files, [".changeset/one.md"]);
});

test("a changeset that Changesets cannot read stops the plan, and the error names the file", () => {
  const folder = repo({ ...ROOT, ...A, ...CONFIG, ".changeset/bad.md": "no front matter\n" });
  assert.throws(() => plan(folder), /\.changeset\/bad\.md: it has no front matter/u);
});

test("main writes run, pending and notice to GITHUB_OUTPUT", () => {
  const folder = repo({ ...ROOT, ...A, ...CONFIG, ".changeset/one.md": '---\n"@x/a": patch\n---\n\nA fix.\n' });
  const output = join(folder, "output.txt");
  assert.equal(main(folder, { GITHUB_OUTPUT: output }), 0);
  const lines = readFileSync(output, "utf8").split("\n");
  assert.equal(lines[0], "run=true");
  assert.equal(lines[1], "pending=@x/a");
  assert.match(lines[2] ?? "", /^notice=This repository uses Changesets\./u);
});

test("main gives 1 for a changeset that Changesets cannot read", () => {
  const folder = repo({ ...ROOT, ...A, ...CONFIG, ".changeset/bad.md": "---\n@x/a: huge\n---\n" });
  const output = join(folder, "output.txt");
  assert.equal(main(folder, { GITHUB_OUTPUT: output }), 1);
});
