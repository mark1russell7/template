// Tests the step of the action "stamp-gate" (stamp-gate/action.yml) with a real git repository and a fake pnpm. The fake
// pnpm records each call, and it writes the stamp records that the case gives. Each fault of a step gives match=true, so a
// fault can skip no bench. A computer with no bash, or with only the bash of WSL on Windows, skips the cases. CI skips none.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const here = import.meta.dirname;
const root = resolve(here, "..", "..");
const action = readFileSync(resolve(root, ".github/actions/stamp-gate/action.yml"), "utf8");

const ci = process.env["CI"] !== undefined;
// The bash of WSL does not read the paths of Windows, so on Windows only the bash of Git for Windows (MSYS) counts
const uname = spawnSync("bash", ["-c", "uname -s"], { encoding: "utf8" });
const hasBash = uname.status === 0 && (process.platform !== "win32" || /^(MINGW|MSYS|CYGWIN)/u.test(uname.stdout));
const skip = !hasBash && !ci ? "bash is not installed" : false;

/** This function gives the script of the step decide: the block of its key run, with the indent of the block removed. */
function stepScript(): string {
  const step = action.indexOf("\n    - id: decide\n");
  assert.ok(step >= 0, "The action has the step decide.");
  const key = "\n      run: |\n";
  const run = action.indexOf(key, step);
  assert.ok(run > step, "The step decide has a run block.");
  const lines: string[] = [];
  for (const line of action.slice(run + key.length).split("\n")) {
    if (line !== "" && !line.startsWith("        ")) break;
    lines.push(line.slice(8));
  }
  return lines.join("\n");
}

// A fake pnpm. It appends "<folder name> <arguments>" to $FAKE/calls. An install fails when $FAKE/fail-install exists.
// A stamp fails when $FAKE/fail-stamp exists. Else it copies $FAKE/stamp-base (for a root in the merge base) or
// $FAKE/stamp-head to the file of --out. The command changed writes match=false when the two files are equal, else match=true.
const FAKE_PNPM = `#!/usr/bin/env bash
echo "$(basename "$PWD") $*" >> "$FAKE/calls"
if [ "$1" = install ]; then
  [ -e "$FAKE/fail-install" ] && exit 1
  exit 0
fi
shift 2
command="$1"; shift
declare -A option
while [ "$#" -gt 0 ]; do option["$1"]="$2"; shift 2; done
if [ "$command" = stamp ]; then
  [ -e "$FAKE/fail-stamp" ] && exit 1
  case "\${option[--root]}" in
    *stamp-gate-base) cp "$FAKE/stamp-base" "\${option[--out]}" ;;
    *) cp "$FAKE/stamp-head" "\${option[--out]}" ;;
  esac
  exit 0
fi
if cmp -s "\${option[--base]}" "\${option[--head]}"; then echo "match=false" >> "$GITHUB_OUTPUT"; else echo "match=true" >> "$GITHUB_OUTPUT"; fi
`;

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

interface Case {
  readonly env?: Record<string, string>;
  /** The files that the pull request changes, with their text. */
  readonly change?: Record<string, string>;
  readonly stampBase?: string;
  readonly stampHead?: string;
  readonly failInstall?: boolean;
  readonly failStamp?: boolean;
}

interface Outcome {
  readonly match: string | undefined;
  readonly calls: readonly string[];
  readonly stdout: string;
  readonly stamps: string;
}

/** This function runs the step in a new repository: a base commit, and a head commit with the change of the case. */
function runStep(test: Case): Outcome {
  const dir = mkdtempSync(join(tmpdir(), "stamp-gate-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  const fake = join(dir, "fake");
  const bin = join(dir, "bin");
  const temp = join(dir, "temp");
  for (const folder of [repo, fake, bin, temp, join(repo, "packages", "joint", "bench")]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(repo, "packages", "joint", "bench", "child.ts"), "export const child = 1;\n");
  writeFileSync(join(repo, "packages", "joint", "bench", "stamp.json"), "{}\n");
  writeFileSync(join(repo, "packages", "joint", "src.ts"), "export const size = 1;\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  for (const [path, text] of Object.entries(test.change ?? { "packages/joint/src.ts": "export const size = 2;\n" })) writeFileSync(join(repo, path), text);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "head");
  const head = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(bin, "pnpm"), FAKE_PNPM);
  chmodSync(join(bin, "pnpm"), 0o755);
  writeFileSync(join(fake, "stamp-base"), test.stampBase ?? "same");
  writeFileSync(join(fake, "stamp-head"), test.stampHead ?? "same");
  if (test.failInstall === true) writeFileSync(join(fake, "fail-install"), "");
  if (test.failStamp === true) writeFileSync(join(fake, "fail-stamp"), "");
  const output = join(dir, "output");
  writeFileSync(output, "");
  const bashPath = (path: string): string => (process.platform === "win32" ? spawnSync("cygpath", ["-u", path], { encoding: "utf8" }).stdout.trim() || path : path);
  const result = spawnSync("bash", ["-c", stepScript()], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
      FAKE: bashPath(fake),
      GITHUB_OUTPUT: bashPath(output),
      RUNNER_TEMP: bashPath(temp),
      EVENT: "pull_request",
      CONFIG: "packages/joint/bench/stamp.json",
      PACKAGE: "packages/joint",
      ALWAYS: "  packages/joint/bench\n\n  .github/workflows/bench.yml\n",
      CHANGES: "true",
      INSTALL: "success",
      BASE: base,
      HEAD: head,
      STAMPS: "",
      ...test.env,
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const matches = readFileSync(output, "utf8").split("\n").filter((line) => line.startsWith("match="));
  assert.ok(matches.length <= 1, `The step writes match one time, not ${String(matches.length)} times.`);
  const calls = existsSync(join(fake, "calls")) ? readFileSync(join(fake, "calls"), "utf8").trim().split("\n") : [];
  return { match: matches[0]?.slice("match=".length), calls, stdout: result.stdout, stamps: join(temp, "stamps") };
}

describe("stamp-gate", { skip }, () => {
  it("does not run the bench and reads nothing when the job changes found no file", () => {
    const outcome = runStep({ env: { CHANGES: "false", EVENT: "push" } });
    assert.equal(outcome.match, "false");
    assert.deepEqual(outcome.calls, []);
  });

  it("runs the bench for another event, a failed install of the head, or an unknown base", () => {
    for (const env of [{ EVENT: "workflow_dispatch" }, { INSTALL: "failure" }, { BASE: "" }, { BASE: "0000000000000000000000000000000000000000" }]) {
      const outcome = runStep({ env });
      assert.equal(outcome.match, "true", JSON.stringify(env));
      assert.deepEqual(outcome.calls, [], JSON.stringify(env));
    }
  });

  it("runs the bench with no stamp when the pull request changes a path of the input always", () => {
    const outcome = runStep({ change: { "packages/joint/bench/child.ts": "export const child = 2;\n" } });
    assert.equal(outcome.match, "true");
    assert.match(outcome.stdout, /changes a path of the input always/u);
    assert.deepEqual(outcome.calls, []);
  });

  it("does not run the bench when the stamps are the same, and keeps the two records", () => {
    const outcome = runStep({});
    assert.equal(outcome.match, "false");
    assert.deepEqual(
      outcome.calls.map((call) => call.replace(/ --(config|root|out|base|head) \S+/gu, " --$1 _")),
      ["stamp-gate-base install --frozen-lockfile", "joint exec rigor-stamp stamp --config _ --root _ --out _", "joint exec rigor-stamp stamp --config _ --root _ --out _", "joint exec rigor-stamp changed --base _ --head _"],
    );
    assert.equal(readFileSync(join(outcome.stamps, "head.json"), "utf8"), "same");
    assert.equal(readFileSync(join(outcome.stamps, "base.json"), "utf8"), "same");
  });

  it("runs the bench when the stamps differ", () => {
    assert.equal(runStep({ stampBase: "base", stampHead: "head" }).match, "true");
  });

  it("runs the bench when the install of the merge base or a stamp fails", () => {
    const install = runStep({ failInstall: true });
    assert.equal(install.match, "true");
    assert.match(install.stdout, /install of the merge base failed/u);
    const stamp = runStep({ failStamp: true });
    assert.equal(stamp.match, "true");
    assert.match(stamp.stdout, /stamp of the head failed/u);
  });

  it("runs the bench when the package folder is not in the checkout", () => {
    const outcome = runStep({ env: { PACKAGE: "packages/none" } });
    assert.equal(outcome.match, "true");
    assert.match(outcome.stdout, /package folder packages\/none is not in the checkout/u);
  });
});
