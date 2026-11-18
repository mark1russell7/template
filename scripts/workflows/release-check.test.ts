// The tests of the job release-check of reusable-ci.yml and of its action (.github/actions/release-check). Start them
// with "pnpm test:workflows". The check is the release build on the commit of a pull request, so its build is the same
// as the build of reusable-release-build.yml. These tests hold that.

import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runBlock } from "./run-block.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf-8");

/** The text of a job, from its key to the key of the next job. */
function jobText(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `The workflow has the job ${name}.`);
  const next = /\n  [a-z-]+:\n/gu;
  next.lastIndex = start + 1;
  const end = next.exec(workflow)?.index ?? workflow.length;
  return workflow.slice(start, end);
}

describe("the release check", () => {
  const action = read(".github/actions/release-check/action.yml");
  const build = read(".github/workflows/reusable-release-build.yml");
  const ci = read(".github/workflows/reusable-ci.yml");

  it("builds with the same commands as the release build", () => {
    const release = runBlock(build, "      - name: Build\n");
    assert.match(release, /pnpm run build/u);
    assert.equal(runBlock(action, "    - name: Build\n"), release);
  });

  it("installs with the lockfile only, as the release build", () => {
    assert.match(build, /run: pnpm install --frozen-lockfile\n/u);
    assert.match(action, /run: pnpm install --frozen-lockfile\n/u);
  });

  it("starts pack.ts and tags.ts of the release, with the pending packages of the plan only", () => {
    assert.match(action, /scripts\/release\/check-plan\.ts/u);
    assert.match(action, /scripts\/release\/pack\.ts/u);
    assert.match(action, /scripts\/release\/tags\.ts/u);
    assert.match(action, /RELEASE_PENDING: \$\{\{ steps\.plan\.outputs\.pending \}\}/u);
    assert.doesNotMatch(build, /RELEASE_PENDING/u);
  });

  it("copies each module that the scripts load, also through the imports of those modules", () => {
    // On 2026-11-18 check.ts got an import of the bundle files.mjs, and the copy did not have the folder of the bundles
    const copy = runBlock(action, "    - name: Copy the release scripts\n");
    const folders = [...copy.matchAll(/cp -R "\$TEMPLATE\/([^"]+)"/gu)].map((match) => match[1] ?? "");
    const loaded = new Set<string>();
    const queue = ["scripts/release/check-plan.ts", "scripts/release/pack.ts", "scripts/release/tags.ts"];
    for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
      if (loaded.has(path)) continue;
      loaded.add(path);
      const file = path;
      assert.ok(folders.some((folder) => file.startsWith(`${folder}/`)), `A script loads ${file}, and the step does not copy it.`);
      for (const match of read(file).matchAll(/^\s*(?:import|export)\s(?!type\s)[^;]*?\sfrom\s*"(\.{1,2}\/[^"]+)"/gmu)) {
        queue.push(posix.join(posix.dirname(file), match[1] ?? ""));
      }
    }
    assert.ok(loaded.has(".github/actions/changeset-check/check.ts"), `The test follows the imports of check-plan.ts: ${[...loaded].join(", ")}`);
  });

  it("runs in reusable-ci.yml only on a pull request or on the pull request of a dispatched run, and in a private repository only with release-check-private", () => {
    const job = jobText(ci, "release-check");
    // The guard is on one line, or in a folded block of more lines
    const block = /\n    if: >-\n((?: {6}.*\n)+)/u.exec(job)?.[1];
    const guard = (block ?? /\n    if: (.+)\n/u.exec(job)?.[1] ?? "").replace(/\s+/gu, " ").trim();
    // A release run (release.yml) starts no pull_request event and the job pull does not start on the default branch, so
    // it does not start the job. A dispatched run starts it only for the pull request that the job pull found.
    assert.ok(guard.includes("github.event_name == 'pull_request' || needs.pull.outputs.found == 'true'"), `The guard "${guard}" has the pull request part.`);
    assert.match(guard, /&& inputs\.release-check(?: |$)/u, `The guard "${guard}" has the input release-check.`);
    // A private repository pays for each job start, so the job starts there only when the caller asks for it
    assert.ok(guard.includes("&& (!github.event.repository.private || inputs.release-check-private)"), `The guard "${guard}" has the private part.`);
    assert.equal(
      guard,
      "${{ !cancelled() && inputs.release-check && (github.event_name == 'pull_request' || needs.pull.outputs.found == 'true') && (!github.event.repository.private || inputs.release-check-private) }}",
    );
    assert.match(job, /\n    needs: pull\n/u);
    assert.match(ci, /\n      release-check-private:\n(?: {8}.*\n)+? {8}type: boolean\n {8}default: false\n/u);
    assert.match(job, /uses: \.\/\.release-template\/\.github\/actions\/release-check\n/u);
    assert.match(job, /working-directory: \$\{\{ \(inputs\.working-directory == '\.' .*&& 'repo' \|\| format\('repo\/\{0\}', inputs\.working-directory\) \}\}/u);
    assert.match(job, /build: \$\{\{ inputs\.release-build \}\}/u);
  });

  it("is a job of the matrix of actions-test.yml for each case of the fixture, and the check Actions OK needs it", () => {
    const tests = read(".github/workflows/actions-test.yml");
    const fixture = read(".github/actions/release-check/fixture.ts");
    const cases = /const CASES = \[([^\]]+)\]/u.exec(fixture)?.[1]?.match(/[a-z-]+/gu) ?? [];
    assert.deepEqual(cases, ["same", "changed", "greater", "none", "changesets-pending", "changesets-missing"]);
    assert.match(jobText(tests, "release-check"), new RegExp(`case: \\[${cases.join(", ")}\\]`, "u"));
    assert.match(jobText(tests, "actions-ok"), /needs: \[[^\]]*\brelease-check\b[^\]]*\]/u);
  });
});
