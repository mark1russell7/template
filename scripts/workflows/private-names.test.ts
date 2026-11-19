// The tests of the step "Private names of the change" of the job checks of reusable-ci.yml. Start them with
// "pnpm test:workflows". Each test makes a git repository with a merge commit, as GitHub makes it for a pull request,
// and starts the script of the step with bash. The step starts the committed bundle private-names.mjs of this
// repository. The commands pnpm, npx, npm and conventions on the PATH of each test, and the installed packages of a
// fixture, write a marker file: a test fails when the step starts one of them. The private name of the tests is made up.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { runBlock } from "./run-block.ts";

const root = resolve(import.meta.dirname, "..", "..");

const WORKFLOW = readFileSync(join(root, ".github", "workflows", "reusable-ci.yml"), "utf8");

const STEP = runBlock(WORKFLOW, "      - name: Private names of the change\n");

/** The bundle that the step starts, from the checkout of the shared actions. */
const BUNDLE = join(root, ".github", "actions", "bundles", "private-names.mjs").replace(/\\/g, "/");

/** The commands that the step must not start: each one writes a marker file and fails. */
const POISONED = ["pnpm", "npx", "npm", "conventions"];

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
  // Commands on the PATH that write a marker and fail. The step must start none of them
  mkdirSync(join(folder, "bin"));
  for (const name of POISONED) writeFileSync(join(folder, "bin", name), `#!/bin/sh\necho "${name} $*" >> "$MARKERS/path-${name}"\nexit 97\n`, { mode: 0o755 });
});

after(() => {
  if (folder !== "") rmSync(folder, { recursive: true, force: true });
});

/** The PATH of a test: the commands that write a marker come first. */
const poisonedPath = (): string => [join(folder, "bin"), process.env["PATH"] ?? ""].join(delimiter);

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

/**
 * This function puts installed packages in a fixture, as an install leaves them: a bin and a package of conventions,
 * and a package with a postinstall script. Each one writes a marker file when something starts it.
 */
function plantPackages(work: string): void {
  const marker = (name: string): string => `require("node:fs").appendFileSync(require("node:path").join(process.env.MARKERS, "${name}"), "ran\\n");\n`;
  mkdirSync(join(work, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(work, "node_modules", ".bin", "conventions"), `#!/bin/sh\necho ran >> "$MARKERS/bin-conventions"\nexit 97\n`, { mode: 0o755 });
  const conventions = join(work, "node_modules", "@mark1russell7", "conventions");
  mkdirSync(join(conventions, "src"), { recursive: true });
  writeFileSync(join(conventions, "package.json"), JSON.stringify({ name: "@mark1russell7/conventions", version: "9.9.9", main: "src/index.js", bin: { conventions: "src/cli.js" } }));
  writeFileSync(join(conventions, "src", "index.js"), marker("package-conventions"));
  writeFileSync(join(conventions, "src", "cli.js"), marker("package-conventions-cli"));
  const hook = join(work, "node_modules", "install-hook");
  mkdirSync(hook, { recursive: true });
  writeFileSync(join(hook, "package.json"), JSON.stringify({ name: "install-hook", version: "1.0.0", main: "index.js", scripts: { postinstall: "node index.js" } }));
  writeFileSync(join(hook, "index.js"), marker("package-hook"));
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly summary: string;
  /** The list file exists after the step. */
  readonly listLeft: boolean;
  /** The names of the marker files: each one tells that the step started a command that it must not start. */
  readonly markers: readonly string[];
}

/** This function starts the script of the step as the runner does: bash -eo pipefail, with the environment of the step. */
function step(cwd: string, vars: Record<string, string>): Run {
  const temp = join(folder, `temp-${String(fixtures++)}`);
  const markers = join(temp, "markers");
  mkdirSync(markers, { recursive: true });
  const summary = join(temp, "summary.md");
  writeFileSync(summary, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", STEP], {
    cwd,
    env: { ...env, PATH: poisonedPath(), MARKERS: markers, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary, BUNDLE, NAMES: "", PULL_NUMBER: "", PULL_BASE: "", CONVENTIONS_PULL_REQUEST: "", ...vars },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, summary: readFileSync(summary, "utf8"), listLeft: existsSync(join(temp, "private-names.json")), markers: readdirSync(markers) };
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

  it("warns with no read and passes when the checkout of the shared actions has no bundle", () => {
    const { work } = repository("the zorbit");
    const run = step(work, { PULL_NUMBER: "1", NAMES, BUNDLE: join(folder, "no-bundle.mjs") });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "::warning title=Private names::No read: the checkout of the shared actions has no bundle private-names.mjs.\n");
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
    assert.deepEqual(run.markers, []);
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

  it("starts no command of the repository and no code of its installed packages", () => {
    const { work, head } = repository("the zorbit note");
    plantPackages(work);
    const run = step(work, { PULL_NUMBER: "1", NAMES, GITHUB_EVENT_PATH: event("A clean title", "") });
    assert.deepEqual(run.markers, [], run.stdout);
    // The check still reads the change: the bundle finds the name in the added line
    assert.equal(run.status, 1, run.stdout);
    assert.ok(run.stdout.includes(`  commit ${head.slice(0, 12)} notes.md:2  A text names name 1 of the private name list.`), run.stdout);
    noName(run.stdout);
    assert.equal(run.listLeft, false);
  });

  it("finds a marker when a command of the repository runs, so that the test above can fail", () => {
    const { work } = repository("clean");
    plantPackages(work);
    const markers = join(folder, `markers-${String(fixtures++)}`);
    mkdirSync(markers);
    const script = "pnpm exec conventions; node node_modules/@mark1russell7/conventions/src/cli.js; node node_modules/install-hook/index.js; node_modules/.bin/conventions; true";
    spawnSync("bash", ["--noprofile", "--norc", "-c", script], { cwd: work, env: { ...env, PATH: poisonedPath(), MARKERS: markers }, encoding: "utf8" });
    assert.deepEqual(readdirSync(markers).sort(), ["bin-conventions", "package-conventions-cli", "package-hook", "path-pnpm"]);
  });
});

describe("the place of the step Private names of the change in the job checks", () => {
  const start = WORKFLOW.indexOf("\n  checks:\n");
  const next = WORKFLOW.slice(start + 1).search(/\n {2}[a-z-]+:\n/u);
  const job = next < 0 ? WORKFLOW.slice(start) : WORKFLOW.slice(start, start + 1 + next);
  /** The text of a step of the job checks, from its first line to the next step or comment. */
  const stepText = (line: string): string => {
    const at = job.indexOf(line);
    assert.ok(at >= 0, `The job checks has the step ${line.trim()}`);
    const rest = job.slice(at + line.length);
    const end = rest.search(/^ {6}(?:- |# )/mu);
    return line + (end < 0 ? rest : rest.slice(0, end));
  };
  const name = "      - name: Private names of the change\n";
  const install = "      - run: pnpm install --frozen-lockfile\n";

  it("comes before the install, and starts no package manager and no installed package", () => {
    assert.ok(job.indexOf(name) >= 0 && job.indexOf(name) < job.indexOf(install), "The step comes before the install");
    const text = stepText(name);
    for (const word of ["pnpm", "npx", "npm ", "node_modules", "yarn", "steps.install"]) assert.ok(!text.includes(word), `The step names ${word}`);
    assert.ok(text.includes("BUNDLE: ${{ github.workspace }}/.shared-actions/.github/actions/bundles/private-names.mjs\n"), "The step starts the bundle of the shared actions");
    assert.ok(text.includes('node "$BUNDLE" --base "$base" --head "$head"'), "The step starts the bundle with node");
    assert.ok(text.includes("continue-on-error: true\n"), "A break does not stop the install and the scripts");
    assert.ok(text.includes("id: private-names\n"));
  });

  it("has the checkout of the shared actions before it, and their removal after it and before the install", () => {
    const checkout = job.indexOf("          path: .shared-actions\n");
    const remove = job.indexOf("        run: rm -rf .shared-actions\n");
    assert.ok(checkout >= 0 && checkout < job.indexOf(name) && job.indexOf(name) < remove && remove < job.indexOf(install));
    const conditions = [...job.matchAll(/^ {6}- if: (.*CI_SELECTION_ON.*)$/gmu)].map((match) => match[1] ?? "");
    assert.equal(conditions.length, 2);
    for (const condition of conditions) assert.ok(condition.includes("env.CI_PRIVATE_NAMES_ON == 'true'"), condition);
    assert.ok(job.includes("      CI_PRIVATE_NAMES_ON: ${{ strategy.job-index == 0 && (github.event.pull_request.commits > 0 || needs.pull.outputs.found == 'true') }}\n"));
  });

  it("has the download of the pull request of the run before it", () => {
    const download = job.indexOf("      - name: Pull request of the run\n");
    assert.ok(download >= 0 && download < job.indexOf(name));
  });

  it("has a step after the scripts that fails the job when the check fails", () => {
    const result = "      - name: Private names result\n";
    assert.ok(job.indexOf("      - name: Scripts\n") >= 0 && job.indexOf("      - name: Scripts\n") < job.indexOf(result));
    const text = stepText(result);
    assert.ok(text.includes("if: ${{ !cancelled() && steps.private-names.outcome == 'failure' }}\n"), text);
    assert.ok(text.includes("exit 1\n"), text);
  });
});
