// Tests the action merge-parents. Each test makes a git fixture in a temporary folder: main moves on after the branch
// topic starts, and a merge commit merges topic into the newer main, as GitHub makes the merge commit of a pull request.
// A clone of depth 1 of the merge commit is the checkout of actions/checkout. The test starts the run block with bash.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { runBlock } from "../../scripts/workflows/run-block.ts";

const STEP = runBlock(readFileSync(join(import.meta.dirname, "merge-parents", "action.yml"), "utf8"), "    - id: parents\n");

let folder = "";
let env: NodeJS.ProcessEnv = {};

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const commit = (cwd: string, message: string): string => {
  git(cwd, ["commit", "--allow-empty", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
};

/** The fixture commits: main 1 (the old base), topic 1, main 2 (main moved on), and the merge of topic 1 into main 2. */
const sha: Record<string, string> = {};

function run(checkout: string): { status: number | null; output: Record<string, string>; stderr: string; stdout: string } {
  const out = join(folder, `output-${String(Math.random()).slice(2)}`);
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", STEP], {
    cwd: folder,
    env: { ...env, CHECKOUT: checkout, GITHUB_OUTPUT: out },
    encoding: "utf8",
  });
  let text = "";
  try {
    text = readFileSync(out, "utf8");
  } catch {
    text = "";
  }
  const output = Object.fromEntries(
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return { status: result.status, output, stderr: result.stderr, stdout: result.stdout };
}

before(() => {
  folder = mkdtempSync(join(tmpdir(), "merge-parents-"));
  env = {
    PATH: process.env["PATH"],
    HOME: folder,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(folder, "no-global-config"),
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.test",
  };
  const origin = join(folder, "origin");
  git(folder, ["init", "-q", "-b", "main", origin]);
  sha["main 1"] = commit(origin, "main 1");
  git(origin, ["checkout", "-q", "-b", "topic"]);
  sha["topic 1"] = commit(origin, "topic 1");
  git(origin, ["checkout", "-q", "main"]);
  sha["main 2"] = commit(origin, "main 2");
  git(origin, ["checkout", "-q", "-b", "pull-merge"]);
  git(origin, ["merge", "-q", "--no-ff", "-m", "merge", "topic"]);
  sha["merge"] = git(origin, ["rev-parse", "HEAD"]);
  const url = pathToFileURL(origin).href;
  git(folder, ["clone", "-q", "--depth=1", "--branch", "pull-merge", url, "merge-checkout"]);
  git(folder, ["clone", "-q", "--depth=1", "--branch", "topic", url, "plain-checkout"]);
});

after(() => {
  if (folder !== "") rmSync(folder, { recursive: true, force: true });
});

describe("merge-parents", () => {
  it("gives the newer tip of main as the base, not the old base where the branch started", () => {
    const result = run("merge-checkout");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output["base"], sha["main 2"]);
    assert.notEqual(result.output["base"], sha["main 1"]);
    assert.equal(result.output["head"], sha["topic 1"]);
  });

  it("reads the parents in a checkout of depth 1, where git rev-parse HEAD^1 fails", () => {
    const shallow = spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD^1"], { cwd: join(folder, "merge-checkout"), env, encoding: "utf8" });
    assert.notEqual(shallow.status, 0, "The fixture checkout must be shallow, so that HEAD^1 is not in it.");
    assert.equal(run("merge-checkout").status, 0);
  });

  it("stops the job when the checkout is not a merge commit", () => {
    const result = run("plain-checkout");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error::.*has 1 parents, not 2/);
    assert.deepEqual(result.output, {});
  });
});
