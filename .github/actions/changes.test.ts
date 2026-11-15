// Tests the step of the action "changes" (changes/action.yml) with a fake gh, and the job changes of each gate workflow of
// the template that starts on workflow_dispatch. A run of an event that is not a pull request reads the files of the
// pull request of the input pull-request only on the head of that pull request. Each other case runs the gate: the step
// fails open. A computer with no bash, or with only the bash of WSL on Windows, skips the cases of the step. A computer
// with no jq skips the cases that reach match.jq. CI skips none. gates.test.ts tests match.jq itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const here = import.meta.dirname;
const root = resolve(here, "..", "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

const ci = process.env["CI"] !== undefined;
// The bash of WSL does not read the paths of Windows, so on Windows only the bash of Git for Windows (MSYS) counts
const uname = spawnSync("bash", ["-c", "uname -s"], { encoding: "utf8" });
const hasBash = uname.status === 0 && (process.platform !== "win32" || /^(MINGW|MSYS|CYGWIN)/u.test(uname.stdout));
const hasJq = spawnSync("jq", ["--version"]).status === 0;
const skipBash = !hasBash && !ci ? "bash is not installed" : false;
const skipJq = skipBash !== false ? skipBash : !hasJq && !ci ? "jq is not installed" : false;

const REPO = "acme/widgets";
const HEAD = "1111111111111111111111111111111111111111";
const OLD_HEAD = "2222222222222222222222222222222222222222";
const NEW_HEAD = "3333333333333333333333333333333333333333";

const action = read(".github/actions/changes/action.yml");

/** This function gives the script of the step match: the block of its key run, with the indent of the block removed. */
function stepScript(): string {
  const step = action.indexOf("\n    - id: match\n");
  assert.ok(step >= 0, "The action has the step match.");
  const key = "\n      run: |\n";
  const run = action.indexOf(key, step);
  assert.ok(run > step, "The step match has a run block.");
  const lines: string[] = [];
  for (const line of action.slice(run + key.length).split("\n")) {
    if (line !== "" && !line.startsWith("        ")) break;
    lines.push(line.slice(8));
  }
  return lines.join("\n");
}

// A fake gh: it records each call in $FAKE_GH/calls. A read of the files gives $FAKE_GH/files, or fails when that file
// is not there. Read N of the head of a pull request gives line N of $FAKE_GH/heads, or fails for the line "fail".
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH/calls"
path=""
for arg in "$@"; do case "$arg" in repos/*) path=$arg ;; esac; done
case "$path" in
  */files[?]*)
    [ -f "$FAKE_GH/files" ] || { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
    cat "$FAKE_GH/files" ;;
  */pulls/*)
    n=$(( $(cat "$FAKE_GH/head-reads" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$FAKE_GH/head-reads"
    head=$(sed -n "\${n}p" "$FAKE_GH/heads")
    [ "$head" != fail ] || { echo "HTTP 404: Not Found" >&2; exit 1; }
    echo "$head" ;;
  *) echo "The fake gh does not know the call: $*" >&2; exit 2 ;;
esac
`;

/** A case of the step: the event, the inputs and the answers of the fake gh. */
interface Case {
  readonly event: string;
  /** The number of the pull request of a pull_request event (github.event.pull_request.number). */
  readonly number?: string;
  /** The input pull-request. */
  readonly pull?: string;
  /** The answers of the reads of the head, in their order. "fail" is a failed read. */
  readonly heads?: readonly string[];
  /** The files of the pull request, or "fail" for a failed read. */
  readonly files?: readonly string[] | "fail";
  readonly paths?: string;
}

interface Outcome {
  readonly status: number | null;
  /** Each value of match in GITHUB_OUTPUT. */
  readonly match: readonly string[];
  readonly log: string;
  /** The arguments of each call of gh. */
  readonly calls: readonly string[];
}

const temps: string[] = [];
after(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
});

/** This function gives a path with "/", which the bash of Git for Windows and of Linux both read. */
const posix = (path: string): string => path.replaceAll("\\", "/");

/** This function starts the script of the step with bash, as GitHub does for "shell: bash", and a fake gh. */
function runStep(test: Case): Outcome {
  const temp = mkdtempSync(join(tmpdir(), "changes-"));
  temps.push(temp);
  const bin = join(temp, "bin");
  const fake = join(temp, "gh");
  mkdirSync(bin);
  mkdirSync(fake);
  writeFileSync(join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  writeFileSync(join(fake, "heads"), (test.heads ?? []).map((head) => `${head}\n`).join(""));
  if (test.files !== "fail") writeFileSync(join(fake, "files"), (test.files ?? []).map((file) => `${file}\n`).join(""));
  const script = join(temp, "step.sh");
  writeFileSync(script, stepScript());
  const output = join(temp, "output");
  writeFileSync(output, "");
  // On Windows, the name of the variable is "Path". A second variable "PATH" would make two.
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name.toUpperCase() !== "PATH") env[name] = value;
  Object.assign(env, {
    PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
    FAKE_GH: posix(fake),
    GITHUB_OUTPUT: posix(output),
    GITHUB_REPOSITORY: REPO,
    GITHUB_SHA: HEAD,
    GITHUB_ACTION_PATH: posix(join(here, "changes")),
    GH_TOKEN: "t0ken",
    EVENT: test.event,
    NUMBER: test.number ?? "",
    PULL: test.pull ?? "",
    PATHS: test.paths ?? "packages/core/src/**",
    IGNORE: "",
  });
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", posix(script)], { cwd: temp, env, encoding: "utf8" });
  const calls = readdirSync(fake).includes("calls") ? readFileSync(join(fake, "calls"), "utf8").split("\n").filter((line) => line !== "") : [];
  const match = [...readFileSync(output, "utf8").matchAll(/^match=(.*)$/gmu)].map((line) => line[1] ?? "");
  return { status: result.status, match, log: `${result.stdout}${result.stderr}`, calls };
}

const HEAD_CALL = (number: number): string => `api repos/${REPO}/pulls/${String(number)} --jq .head.sha`;
const FILES_CALL = (number: number): string => `api --paginate repos/${REPO}/pulls/${String(number)}/files?per_page=100 --jq .[] | .filename, (.previous_filename // empty)`;

describe("changes: a run of an event that is not a pull request", { skip: skipBash }, () => {
  for (const event of ["push", "schedule", "workflow_dispatch"]) {
    it(`runs the gate on ${event} with no input pull-request, and reads nothing`, () => {
      const out = runStep({ event });
      assert.equal(out.status, 0, out.log);
      assert.deepEqual(out.match, ["true"]);
      assert.deepEqual(out.calls, []);
      assert.match(out.log, new RegExp(`The event is ${event}, not a pull request, and the input pull-request is empty\\. So the gate runs\\.`, "u"));
    });
  }

  for (const pull of ["0", "12abc", "7/files", "-1", "12345678901"]) {
    it(`runs the gate for the input "${pull}", which is not the number of a pull request, and reads nothing`, () => {
      const out = runStep({ event: "workflow_dispatch", pull });
      assert.equal(out.status, 0, out.log);
      assert.deepEqual(out.match, ["true"]);
      assert.deepEqual(out.calls, []);
      assert.ok(out.log.includes(`The input pull-request is "${pull}", not the number of a pull request. So the gate runs.`), out.log);
    });
  }

  it("runs the gate when the head of the pull request is not the commit of the run, and does not read the files", () => {
    const out = runStep({ event: "workflow_dispatch", pull: "7", heads: [OLD_HEAD], files: ["docs/a.md"] });
    assert.equal(out.status, 0, out.log);
    assert.deepEqual(out.match, ["true"]);
    assert.deepEqual(out.calls, [HEAD_CALL(7)]);
    assert.ok(out.log.includes(`The head of #7 is ${OLD_HEAD}, not ${HEAD}, the commit of the run. So the gate runs.`), out.log);
  });

  it("runs the gate when the read of the head fails", () => {
    const out = runStep({ event: "workflow_dispatch", pull: "7", heads: ["fail"], files: ["docs/a.md"] });
    assert.equal(out.status, 0, out.log);
    assert.deepEqual(out.match, ["true"]);
    assert.deepEqual(out.calls, [HEAD_CALL(7)]);
    assert.match(out.log, /The read of the head of #7 failed\. So the gate runs\./u);
  });

  it("runs the gate when the read of the files fails", () => {
    const out = runStep({ event: "workflow_dispatch", pull: "7", heads: [HEAD], files: "fail" });
    assert.equal(out.status, 0, out.log);
    assert.deepEqual(out.match, ["true"]);
    assert.deepEqual(out.calls, [HEAD_CALL(7), FILES_CALL(7)]);
    assert.match(out.log, /The read of the files of #7 failed\. So the gate runs\./u);
  });

  it("runs the gate for 3000 files or more, the limit of the API", () => {
    const files = Array.from({ length: 3000 }, (_, index) => `docs/${String(index)}.md`);
    const out = runStep({ event: "workflow_dispatch", pull: "7", heads: [HEAD, HEAD], files });
    assert.equal(out.status, 0, out.log);
    assert.deepEqual(out.match, ["true"]);
    assert.match(out.log, /The pull request has 3000 files or more, the limit of the API\. So the gate runs\./u);
  });

  it("runs the gate when the head moves during the read of the files, or when the second read fails", () => {
    const moved = runStep({ event: "workflow_dispatch", pull: "7", heads: [HEAD, NEW_HEAD], files: ["docs/a.md"] });
    assert.equal(moved.status, 0, moved.log);
    assert.deepEqual(moved.match, ["true"]);
    assert.deepEqual(moved.calls, [HEAD_CALL(7), FILES_CALL(7), HEAD_CALL(7)]);
    assert.ok(moved.log.includes(`The head of #7 moved to ${NEW_HEAD} during the read of its files. So the gate runs.`), moved.log);
    const failed = runStep({ event: "workflow_dispatch", pull: "7", heads: [HEAD, "fail"], files: ["docs/a.md"] });
    assert.deepEqual(failed.match, ["true"]);
    assert.match(failed.log, /The second read of the head of #7 failed\. So the gate runs\./u);
  });
});

describe("changes: the files of the pull request of the input", { skip: skipJq }, () => {
  it("skips the gate when the pull request on the commit of the run changes no file of the gate", () => {
    const out = runStep({ event: "workflow_dispatch", pull: "7", heads: [HEAD, HEAD], files: ["docs/a.md", "README.md"] });
    assert.equal(out.status, 0, out.log);
    assert.deepEqual(out.match, ["false"]);
    assert.deepEqual(out.calls, [HEAD_CALL(7), FILES_CALL(7), HEAD_CALL(7)]);
    assert.match(out.log, /The event is workflow_dispatch, and the run is on the head of #7\. The action reads the files of #7\./u);
    assert.match(out.log, /2 files\. Match: false\./u);
  });

  it("runs the gate when the pull request changes a file of the gate", () => {
    const out = runStep({ event: "workflow_dispatch", pull: "7", heads: [HEAD, HEAD], files: ["docs/a.md", "packages/core/src/a.ts"] });
    assert.equal(out.status, 0, out.log);
    assert.deepEqual(out.match, ["true"]);
  });

  it("reads the pull request of the event on a pull_request run, not the input, and reads no head", () => {
    for (const event of ["pull_request", "pull_request_target"]) {
      const out = runStep({ event, number: "5", pull: "7", heads: [OLD_HEAD], files: ["docs/a.md"] });
      assert.equal(out.status, 0, out.log);
      assert.deepEqual(out.match, ["false"]);
      assert.deepEqual(out.calls, [FILES_CALL(5)]);
    }
  });
});

describe("changes: a pull_request run", { skip: skipBash }, () => {
  it("fails when the read of the files fails, as before", () => {
    const out = runStep({ event: "pull_request", number: "5", files: "fail" });
    assert.notEqual(out.status, 0);
    assert.deepEqual(out.match, []);
    assert.deepEqual(out.calls, [FILES_CALL(5)]);
  });
});

describe("changes: the input pull-request", () => {
  it("is optional and empty by default, and the step reads it, and the number of the event", () => {
    assert.match(action, /\n {2}pull-request:\n(?: {4}.*\n)+? {4}default: ""\n/u);
    assert.match(action, /\n {8}PULL: \$\{\{ inputs\.pull-request \}\}\n/u);
    assert.match(action, /\n {8}NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}\n/u);
  });
});

describe("the job changes of each gate of the template that starts on workflow_dispatch", () => {
  const folder = resolve(root, ".github", "workflows");
  const DISPATCHED = "github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/') && github.ref != format('refs/heads/{0}', github.event.repository.default_branch)";

  /** This function gives the block of the key `on` of a workflow, to the next key at the start of a line, after a line break. */
  const onBlock = (text: string): string => `\n${/\non:\n((?:[ #].*\n|\n)*)/u.exec(text)?.[1] ?? ""}`;

  /** This function gives the text of a job, from its key to the key of the next job. */
  function jobText(text: string, name: string): string {
    const start = text.indexOf(`\n  ${name}:\n`);
    assert.ok(start >= 0, `The workflow has the job ${name}.`);
    const next = /\n  [a-z-]+:\n/gu;
    next.lastIndex = start + 1;
    return text.slice(start, next.exec(text)?.index ?? text.length);
  }

  const gates = readdirSync(folder)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => ({ name, text: readFileSync(join(folder, name), "utf8") }))
    .filter(({ text }) => /\n {8}uses: (?:\.\/|mark1russell7\/template\/)\.github\/actions\/changes(?:@|\n)/u.test(text) && /\n {2}workflow_dispatch:/u.test(onBlock(text)));

  it("finds the gates of the template", () => {
    assert.deepEqual(gates.map(({ name }) => name).sort(), ["actions-test.yml", "site-audit.yml"]);
  });

  for (const { name, text } of gates) {
    it(`${name}: finds the pull request of a dispatched run with pull-of-run, and gives its number to changes`, () => {
      const job = jobText(text, "changes");
      assert.match(job, /\n {6}contents: read\n/u);
      assert.match(job, /\n {6}pull-requests: read\n/u);
      // The checkout has the folder of the two actions
      assert.match(job, /\n {10}sparse-checkout: \.github\/actions\n/u);
      // Node 22.18 or later runs pull.ts with no build
      const node = /\n {6}- if: (.+)\n {8}uses: actions\/setup-node@[0-9a-f]{40} # v\d+\.\d+\.\d+\n {8}with:\n {10}node-version: "(\d+)(?:\.(\d+))?[^"]*"\n/u.exec(job);
      assert.ok(node !== null, "The job sets up Node before pull-of-run.");
      assert.equal(node[1], DISPATCHED);
      const major = Number(node[2]);
      assert.ok(major > 22 || (major === 22 && Number(node[3] ?? "0") >= 18), `Node ${node[2] ?? ""} cannot run pull.ts`);
      // The lookup fails open: a failure of pull-of-run does not stop the job, and gives no number
      const pull = job.indexOf(`\n      - id: pull\n        if: ${DISPATCHED}\n        continue-on-error: true\n        uses: ./.github/actions/pull-of-run\n`);
      assert.ok(pull > 0, "The job has the step pull, on a dispatched run of a branch only, with continue-on-error.");
      const changes = job.indexOf("\n      - id: changes\n        uses: ./.github/actions/changes\n        with:\n          pull-request: ${{ steps.pull.outputs.found == 'true' && steps.pull.outputs.number || '' }}\n");
      assert.ok(changes > 0, "The step changes gets the number of the pull request only when pull-of-run found it.");
      assert.ok(job.indexOf("uses: actions/setup-node@") < pull && pull < changes, "The steps are in the order setup-node, pull, changes.");
    });
  }

  it("is the example of CI.md", () => {
    const doc = read("CI.md");
    assert.ok(doc.includes(`\n      - id: pull\n        if: ${DISPATCHED}\n        continue-on-error: true\n        uses: mark1russell7/template/.github/actions/pull-of-run@<commit> # main\n`));
    assert.ok(doc.includes("\n          pull-request: ${{ steps.pull.outputs.found == 'true' && steps.pull.outputs.number || '' }}\n"));
  });
});
