// The tests of the job release-check of reusable-ci.yml and of its action (.github/actions/release-check). Start them
// with "pnpm test:workflows". The check is the release build on the commit of a pull request, so its build is the same
// as the build of reusable-release-build.yml. These tests hold that.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf-8");

/** The lines of a "run: |" block after a line, with the indent of the block removed. */
function runBlock(text: string, after: string): string {
  const start = text.indexOf(after);
  assert.ok(start >= 0, `The file has the line ${after.trim()}.`);
  const run = text.indexOf("run: |\n", start);
  assert.ok(run >= 0, `A run block follows ${after.trim()}.`);
  const lines = text.slice(run + "run: |\n".length).split("\n");
  const indent = /^ */u.exec(lines[0] ?? "")?.[0].length ?? 0;
  const block: string[] = [];
  for (const line of lines) {
    if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
    block.push(line.slice(indent));
  }
  return block.join("\n").trimEnd();
}

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

  it("runs in reusable-ci.yml only on a pull request, and in a private repository only with release-check-private", () => {
    const job = jobText(ci, "release-check");
    const guard = /\n    if: (.+)\n/u.exec(job)?.[1] ?? "";
    // A release run (release.yml) starts no pull_request event, so it does not start the job
    assert.ok(guard.includes("github.event_name == 'pull_request'"), `The guard "${guard}" has the pull_request part.`);
    assert.match(guard, /&& inputs\.release-check(?: |$)/u, `The guard "${guard}" has the input release-check.`);
    // A private repository pays for each job start, so the job starts there only when the caller asks for it
    assert.ok(guard.includes("&& (!github.event.repository.private || inputs.release-check-private)"), `The guard "${guard}" has the private part.`);
    assert.equal(guard, "github.event_name == 'pull_request' && inputs.release-check && (!github.event.repository.private || inputs.release-check-private)");
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
