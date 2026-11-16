// The tests of the step "Deepen to the merge base" of the job checks of reusable-ci.yml. Start them with
// "pnpm test:workflows". Each test makes a git fixture in a temporary folder, copies a shallow checkout from it as
// actions/checkout does, and runs the script of the step with bash. A local remote needs no token, and git ignores
// the header of the token for it.
//
// The fixture: main has 45 commits. The branch topic starts at main 35 and has 25 commits. Then topic merges the branch
// side, which starts at the older main 30. Main 35 is the true merge base of main and topic. At depth 16, topic does not
// get to main 35, but it gets to main 30 through side. Thus git merge-base then gives main 30, a wrong merge base.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { runBlock } from "./run-block.ts";

const root = resolve(import.meta.dirname, "..", "..");

const STEP = runBlock(readFileSync(join(root, ".github", "workflows", "reusable-ci.yml"), "utf8"), "- name: Deepen to the merge base\n");

let folder = "";
/** The environment of each git command: no system or global settings of the computer. */
let env: NodeJS.ProcessEnv = {};

function git(cwd: string, args: readonly string[], input?: string): string {
  const result = spawnSync("git", args, { cwd, env, input, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** The commit of each name of the fixture, for example "main 35", "topic 25", "side 2" and "merge". */
const commits = new Map<string, string>();
const sha = (name: string): string => {
  const value = commits.get(name);
  assert.ok(value !== undefined, `The fixture has no commit ${name}.`);
  return value;
};

/** The fixture as a stream of git fast-import, and the name of each mark. */
function fixture(): { stream: string; names: string[] } {
  const lines: string[] = [];
  const names: string[] = [];
  let time = 1_800_000_000;
  const commit = (ref: string, name: string, from?: string, merge?: string): void => {
    names.push(name);
    time += 60;
    lines.push(`commit ${ref}`, `mark :${String(names.length)}`, `committer Test <test@example.test> ${String(time)} +0000`);
    lines.push(`data ${String(Buffer.byteLength(name))}`, name);
    if (from !== undefined) lines.push(`from :${String(names.indexOf(from) + 1)}`);
    if (merge !== undefined) lines.push(`merge :${String(names.indexOf(merge) + 1)}`);
    // The first commit adds a file in a folder, so a test can start the step in a working directory below the root
    if (names.length === 1) lines.push("M 644 inline pkg/notes.txt", "data 5", "notes");
    lines.push("");
  };
  for (let index = 1; index <= 45; index += 1) commit("refs/heads/main", `main ${String(index)}`, index === 1 ? undefined : `main ${String(index - 1)}`);
  for (let index = 1; index <= 25; index += 1) commit("refs/heads/topic", `topic ${String(index)}`, index === 1 ? "main 35" : `topic ${String(index - 1)}`);
  commit("refs/heads/side", "side 1", "main 30");
  commit("refs/heads/side", "side 2", "side 1");
  // The head of the pull request: topic merges side, and its second parent is an old commit
  commit("refs/heads/topic", "head", "topic 25", "side 2");
  // The merge commit of the pull request, as GitHub makes it: the tip of main, then the head
  commit("refs/pull/1/merge", "merge", "main 45", "head");
  // A branch with no old merge, for the test that the step stops early
  commit("refs/heads/short", "short 1", "main 43");
  commit("refs/heads/short", "short 2", "short 1");
  commit("refs/pull/2/merge", "short merge", "main 45", "short 2");
  return { stream: `${lines.join("\n")}done\n`, names };
}

before(() => {
  folder = mkdtempSync(join(tmpdir(), "deepen-"));
  const empty = join(folder, "gitconfig");
  writeFileSync(empty, "");
  env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: empty, GIT_TERMINAL_PROMPT: "0" };
  const origin = join(folder, "origin.git");
  mkdirSync(origin);
  git(origin, ["init", "--quiet", "--bare"]);
  // GitHub gives each commit that a branch can reach, also by its id
  git(origin, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
  const { stream, names } = fixture();
  const marks = join(folder, "marks");
  git(origin, ["fast-import", "--quiet", `--export-marks=${marks}`], stream);
  for (const line of readFileSync(marks, "utf8").trim().split("\n")) {
    const [mark, id] = line.split(" ");
    commits.set(names[Number(mark?.slice(1)) - 1] ?? "", id ?? "");
  }
});

after(() => {
  if (folder !== "") rmSync(folder, { recursive: true, force: true });
});

/** A shallow checkout of a ref of the fixture, as actions/checkout makes it with fetch-depth 2. */
function checkout(name: string, ref: string): string {
  const work = join(folder, name);
  mkdirSync(work);
  git(work, ["init", "--quiet"]);
  git(work, ["remote", "add", "origin", pathToFileURL(join(folder, "origin.git")).href]);
  git(work, ["fetch", "--quiet", "--no-tags", "--depth=2", "origin", `+${ref}:refs/remotes/checkout`]);
  git(work, ["checkout", "--quiet", "--detach", "refs/remotes/checkout"]);
  return work;
}

/** Runs the script of the step as the runner does: bash -eo pipefail, with the environment of the step. */
function step(cwd: string, pullBase = ""): void {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", STEP], {
    cwd,
    env: { ...env, TOKEN: "dummy", PULL_BASE: pullBase },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `The step failed: ${result.stderr}`);
}

const shallow = (work: string): boolean => git(work, ["rev-parse", "--is-shallow-repository"]) === "true";

describe("the step Deepen to the merge base", () => {
  it("has a fixture where depth 16 gives a wrong merge base", () => {
    assert.equal(git(join(folder, "origin.git"), ["merge-base", sha("main 45"), sha("head")]), sha("main 35"));
    const work = checkout("depth-16", "refs/pull/1/merge");
    git(work, ["fetch", "--quiet", "--no-tags", "--deepen=16", "origin", sha("main 45"), sha("head")]);
    assert.equal(git(work, ["merge-base", sha("main 45"), sha("head")]), sha("main 30"));
  });

  it("gives the true merge base for the merge commit of a pull request", () => {
    const work = checkout("pull-request", "refs/pull/1/merge");
    step(work);
    assert.equal(git(work, ["merge-base", "HEAD^1", "HEAD^2"]), sha("main 35"));
  });

  it("gives the true merge base for a run that workflow_dispatch starts, from a working directory below the root", () => {
    const work = checkout("dispatch", "refs/heads/topic");
    step(join(work, "pkg"), sha("main 45"));
    assert.equal(git(work, ["merge-base", sha("main 45"), "HEAD"]), sha("main 35"));
  });

  it("stops when the shallow checkout has the history from the merge base to the two tips", () => {
    const work = checkout("short", "refs/pull/2/merge");
    step(work);
    assert.equal(git(work, ["merge-base", "HEAD^1", "HEAD^2"]), sha("main 43"));
    // The step did not fetch the whole history
    assert.ok(shallow(work));
  });

  it("does not fetch when the checkout has the whole history", () => {
    const work = checkout("whole", "refs/pull/1/merge");
    git(work, ["fetch", "--quiet", "--no-tags", "--unshallow", "origin", sha("main 45"), sha("head")]);
    // A fetch now fails, so the step passes only when it does not fetch
    git(work, ["remote", "set-url", "origin", pathToFileURL(join(folder, "missing.git")).href]);
    step(work);
    assert.equal(git(work, ["merge-base", "HEAD^1", "HEAD^2"]), sha("main 35"));
  });
});
