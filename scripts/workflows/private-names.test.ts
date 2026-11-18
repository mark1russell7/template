// The tests of the step "Private names of the change" of the job checks of reusable-ci.yml. Start them with
// "pnpm test:workflows". Each test makes a git repository with a merge commit, as GitHub makes it for a pull request,
// and starts the script of the step with bash. A shell function takes the place of "pnpm exec": it starts the CLI of
// conventions from the source of this repository, or a CLI with no --base. The private name of the tests is made up.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { runBlock } from "./run-block.ts";

const root = resolve(import.meta.dirname, "..", "..");

const STEP = runBlock(readFileSync(join(root, ".github", "workflows", "reusable-ci.yml"), "utf8"), "      - name: Private names of the change\n");

/** The CLI of conventions in this repository. */
const CLI = join(root, "packages", "conventions", "src", "cli.ts").replace(/\\/g, "/");

/** A made-up private name list. */
const NAMES = JSON.stringify({ names: [{ id: "zorbit-app", project: "A made-up app", seeds: ["zorbit"], patterns: ["\\bzorbit\\b"] }], allow: [] });

let folder = "";
let fixtures = 0;
/** The environment of each command: no system or global settings of git, and no variable of a CI run. */
let env: NodeJS.ProcessEnv = {};

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

before(() => {
  folder = mkdtempSync(join(tmpdir(), "private-names-")).replace(/\\/g, "/");
  const empty = join(folder, "gitconfig");
  writeFileSync(empty, "");
  env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: empty, GIT_TERMINAL_PROMPT: "0" };
  for (const name of ["CI", "GITHUB_ACTIONS", "GITHUB_EVENT_PATH", "GITHUB_EVENT_NAME", "CONVENTIONS_PRIVATE_NAMES_FILE", "CONVENTIONS_PRIVATE_PATTERNS", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  // A CLI of an old conventions: its help has no --base
  writeFileSync(join(folder, "old-cli.mjs"), 'process.stdout.write("Usage: conventions check\\n       conventions pre-push <remote> [<url>]\\n");\n');
});

after(() => {
  if (folder !== "") rmSync(folder, { recursive: true, force: true });
});

/** A repository of a pull request. The branch topic adds `added` to notes.md. The checkout is the merge commit. */
function repository(added: string): { work: string; base: string; head: string } {
  const work = join(folder, `repo-${String(fixtures++)}`);
  mkdirSync(work);
  git(work, ["init", "--quiet", "-b", "main"]);
  writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "one", private: true })}\n`);
  writeFileSync(join(work, "notes.md"), "one\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "first"]);
  git(work, ["checkout", "--quiet", "-b", "topic"]);
  writeFileSync(join(work, "notes.md"), `one\n${added}\n`);
  git(work, ["commit", "--quiet", "-am", "the change"]);
  const head = git(work, ["rev-parse", "HEAD"]);
  git(work, ["checkout", "--quiet", "main"]);
  writeFileSync(join(work, "other.md"), "two\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "main moves"]);
  const base = git(work, ["rev-parse", "HEAD"]);
  git(work, ["merge", "--quiet", "--no-ff", "-m", "merge", "topic"]);
  git(work, ["checkout", "--quiet", "--detach", "HEAD"]);
  return { work, base, head };
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly summary: string;
  /** The list file exists after the step. */
  readonly listLeft: boolean;
}

/** This function starts the script of the step as the runner does: bash -eo pipefail, with the environment of the step. */
function step(cwd: string, vars: Record<string, string>, cli = CLI): Run {
  const temp = join(folder, `temp-${String(fixtures++)}`);
  mkdirSync(temp);
  const summary = join(temp, "summary.md");
  writeFileSync(summary, "");
  const pnpm = 'pnpm() { [ "$1" = exec ] && [ "$2" = conventions ] || return 99; shift 2; node "$FAKE_CLI" "$@"; }\n';
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", pnpm + STEP], {
    cwd,
    env: { ...env, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary, FAKE_CLI: cli, NAMES: "", PULL_NUMBER: "", PULL_BASE: "", CONVENTIONS_PULL_REQUEST: "", ...vars },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, summary: readFileSync(summary, "utf8"), listLeft: existsSync(join(temp, "private-names.json")) };
}

/** This function writes the event file of a pull request, and gives its path. */
function event(title: string, body: string): string {
  const file = join(folder, `event-${String(fixtures++)}.json`);
  writeFileSync(file, JSON.stringify({ pull_request: { number: 1, title, body } }));
  return file;
}

/** This function asserts that no line has the made-up name, other than a line that masks it. */
function noName(text: string): void {
  for (const line of text.split("\n")) if (!line.startsWith("::add-mask::")) assert.ok(!/zorbit/i.test(line), `A line shows the private name: ${line}`);
}

describe("the step Private names of the change", () => {
  it("writes only a summary line on a run with no pull request", () => {
    const { work } = repository("clean");
    const run = step(work, { NAMES });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
    assert.equal(run.summary, "**Private names of the change:** no read: the run has no pull request. The check reads only the change of a pull request.\n");
  });

  it("warns with no read and passes when the pull request gets no secret", () => {
    const { work } = repository("the zorbit");
    const run = step(work, { PULL_NUMBER: "1" });
    assert.equal(run.status, 0);
    const reason = "the secret CONVENTIONS_PRIVATE_NAMES has no value. A pull request from a fork or from Dependabot gets no secret. Else the caller must give the secret, by name or with secrets: inherit.";
    assert.equal(run.stdout, `::warning title=Private names::No read: ${reason}\n`);
    assert.equal(run.summary, `**Private names of the change:** no read: ${reason}\n`);
  });

  it("warns with no read and passes when the conventions of the repository has no --base", () => {
    const { work } = repository("the zorbit");
    const run = step(work, { PULL_NUMBER: "1", NAMES }, join(folder, "old-cli.mjs"));
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "::warning title=Private names::No read: the conventions of the repository has no command pre-push --base. Update @mark1russell7/conventions (CI.md).\n");
    assert.equal(run.listLeft, false);
  });

  it("fails on a private name in an added line and in the title, masks the list first, and shows no name", () => {
    const { work, head } = repository("the zorbit note");
    const run = step(work, { PULL_NUMBER: "1", NAMES, GITHUB_EVENT_PATH: event("Add the zorbit", "A body.\n") });
    assert.equal(run.status, 1, run.stdout);
    const lines = run.stdout.trimEnd().split("\n");
    // The masks come first: the id, the seed and the pattern of the list
    assert.deepEqual(lines.slice(0, 3), ["::add-mask::zorbit-app", "::add-mask::zorbit", "::add-mask::\\bzorbit\\b"]);
    assert.ok(!lines.slice(3).some((line) => line.startsWith("::add-mask::")));
    assert.match(lines[3] ?? "", /^conventions pre-push: 1 commits and the text of the pull request, \d+ lines read, 2 breaks\. The check fails\.$/);
    assert.ok(lines.includes(`  commit ${head.slice(0, 12)} notes.md:2  A text names name 1 of the private name list.`), run.stdout);
    assert.ok(lines.includes("  pull request title:1  A text names name 1 of the private name list."), run.stdout);
    assert.match(lines.at(-1) ?? "", /^::error title=Private names::conventions pre-push: 1 commits and the text of the pull request, \d+ lines read, 2 breaks\. The check fails\.$/);
    assert.match(run.summary, /^### Private names of the change\n\n```text\nconventions pre-push: .* 2 breaks\. The check fails\.\n/);
    noName(run.stdout);
    noName(run.summary);
    assert.equal(run.listLeft, false);
  });

  it("passes a clean change, and reads the base of the job pull on a dispatched run", () => {
    const { work, base, head } = repository("a clean line");
    const pass = step(work, { PULL_NUMBER: "1", NAMES, GITHUB_EVENT_PATH: event("A clean title", "") });
    assert.equal(pass.status, 0, pass.stdout);
    assert.match(pass.stdout, /\nconventions pre-push: 1 commits and the text of the pull request, \d+ lines read, 0 breaks\.\n$/);
    assert.equal(pass.listLeft, false);
    // A dispatched run: the checkout is the head of the branch, and the base comes from the job pull
    git(work, ["checkout", "--quiet", "--detach", head]);
    const file = join(folder, `pull-request-${String(fixtures++)}.json`);
    writeFileSync(file, JSON.stringify({ number: 1, title: "the zorbit", body: "", commits: 1 }));
    const dispatched = step(work, { NAMES, PULL_BASE: base, CONVENTIONS_PULL_REQUEST: file });
    assert.equal(dispatched.status, 1, dispatched.stdout);
    assert.match(dispatched.stdout, /\nconventions pre-push: 1 commits and the text of the pull request, \d+ lines read, 1 breaks\. The check fails\.\n/);
    assert.ok(!dispatched.stdout.includes("notes.md"), dispatched.stdout);
    noName(dispatched.stdout);
  });
});
