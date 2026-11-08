// Tests ref.ts of the action build-ref: the decision of the job ref of reusable-pages.yml. The job build checks out the
// commit of the event, and this step decides if it builds and deploys. The step fails closed, and a fork never deploys.
// The end-to-end tests start the script on the event files of fixtures/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildRef, summary, type RefInput, type RefResult } from "./build-ref/ref.ts";

const script = join(import.meta.dirname, "build-ref", "ref.ts");
const fixtures = join(import.meta.dirname, "build-ref", "fixtures");
/** The commit of the CI run of fixtures/workflow-run-main.json. */
const RUN_SHA = "0123456789abcdef0123456789abcdef01234567";
/** A different commit: the head of the default branch after a newer push. */
const NEWER = "1111111111111111111111111111111111111111";
const MAIN = "refs/heads/main";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(fixtures, name), "utf8")) as unknown;

const ref = (over: Partial<RefInput>): RefResult =>
  buildRef({
    eventName: "workflow_run",
    event: fixture("workflow-run-main.json"),
    repository: "owner/site",
    sha: RUN_SHA,
    ref: MAIN,
    defaultBranch: "main",
    state: "",
    pending: "head",
    ...over,
  });

/** The workflow_run event of fixtures/workflow-run-main.json with other fields of its run. */
function runEvent(run: Record<string, unknown>): unknown {
  const event = fixture("workflow-run-main.json") as { workflow_run: Record<string, unknown> };
  return { ...event, workflow_run: { ...event.workflow_run, ...run } };
}

function error(result: RefResult): string {
  assert.ok("error" in result, `The step gives a decision: ${JSON.stringify(result)}`);
  return result.error;
}

/** The decision of a result with no reason, for example "build, deploy", "build" or "nothing". */
function decision(result: RefResult): string {
  assert.ok(!("error" in result), `The step fails: ${JSON.stringify(result)}`);
  return result.deploy ? "build, deploy" : result.build ? "build" : "nothing";
}

const RELEASE = runEvent({ name: "Release" });

/** The rows of the rules (a) to (d): the event, the CI state of github.sha, the input pending and the decision. */
const ROWS: readonly { row: string; input: Partial<RefInput>; expected: string }[] = [
  { row: "(a) a push to the default branch", input: { eventName: "push", event: {} }, expected: "build, deploy" },
  { row: "(a) a push to a different branch", input: { eventName: "push", event: {}, ref: "refs/heads/feature" }, expected: "build" },
  { row: "(b) a pull request", input: { eventName: "pull_request", event: {}, ref: "refs/pull/7/merge" }, expected: "build" },
  { row: "(c) a schedule, CI green", input: { eventName: "schedule", event: {}, state: "green" }, expected: "build, deploy" },
  { row: "(c) a schedule, CI red", input: { eventName: "schedule", event: {}, state: "red" }, expected: "nothing" },
  { row: "(c) a schedule, CI running, pending head", input: { eventName: "schedule", event: {}, state: "running" }, expected: "build, deploy" },
  { row: "(c) a schedule, no CI run, pending head", input: { eventName: "schedule", event: {}, state: "none" }, expected: "build, deploy" },
  { row: "(c) a schedule, CI running, pending green", input: { eventName: "schedule", event: {}, state: "running", pending: "green" }, expected: "nothing" },
  { row: "(c) a schedule, CI green, pending green", input: { eventName: "schedule", event: {}, state: "green", pending: "green" }, expected: "build, deploy" },
  { row: "(c) a run by hand on the default branch, CI green", input: { eventName: "workflow_dispatch", event: {}, state: "green" }, expected: "build, deploy" },
  { row: "(c) a run by hand on the default branch, CI red", input: { eventName: "workflow_dispatch", event: {}, state: "red" }, expected: "nothing" },
  { row: "(c) a run by hand on a different branch", input: { eventName: "workflow_dispatch", event: {}, ref: "refs/heads/feature", state: "red" }, expected: "build" },
  { row: "(c) a repository dispatch, CI green", input: { eventName: "repository_dispatch", event: {}, state: "green" }, expected: "build, deploy" },
  { row: "(c) a repository dispatch, CI red", input: { eventName: "repository_dispatch", event: {}, state: "red" }, expected: "nothing" },
  { row: "(c) after a release, CI green", input: { event: RELEASE, sha: NEWER, state: "green" }, expected: "build, deploy" },
  { row: "(c) after a release, CI running, pending head", input: { event: RELEASE, sha: NEWER, state: "running" }, expected: "build, deploy" },
  { row: "(c) after a release, CI red", input: { event: RELEASE, sha: NEWER, state: "red" }, expected: "nothing" },
  { row: "(d) after CI, the commit of CI is the head", input: {}, expected: "build, deploy" },
  { row: "(d) after CI, a newer commit is the head", input: { sha: NEWER }, expected: "nothing" },
  { row: "(d) after CI of a run by hand, the commit of CI is the head", input: { event: runEvent({ event: "workflow_dispatch" }) }, expected: "build, deploy" },
];

describe("build-ref: the rules (a) to (d)", () => {
  for (const { row, input, expected } of ROWS) {
    it(`${row}: ${expected}`, () => {
      assert.equal(decision(ref(input)), expected);
    });
  }

  it("gives a reason with the commit for each row", () => {
    for (const { row, input } of ROWS) {
      const result = ref(input);
      assert.ok(!("error" in result) && result.reason.includes(input.sha ?? RUN_SHA), row);
    }
  });

  it("tells why a red head and a newer commit deploy nothing", () => {
    const red = ref({ eventName: "schedule", event: {}, state: "red" });
    assert.ok(!("error" in red));
    assert.match(red.reason, /CI failed on it\. The site keeps its last deploy/);
    const newer = ref({ sha: NEWER });
    assert.ok(!("error" in newer));
    assert.match(newer.reason, new RegExp(`CI passed on ${RUN_SHA}, and the default branch is at ${NEWER}`));
  });
});

describe("build-ref: the checks of a workflow_run", () => {
  it("never deploys the commit of a fork", () => {
    assert.match(error(ref({ event: fixture("workflow-run-fork.json") })), /of the repository "attacker\/site", not of owner\/site/);
    assert.match(error(ref({ event: runEvent({ head_repository: {} }) })), /of the repository ""/);
    assert.match(error(ref({ event: runEvent({ name: "Release", head_repository: { full_name: "attacker/site" } }), state: "green" })), /never follows a run of a fork/);
  });

  it("compares the repository names with no case, as GitHub does", () => {
    assert.equal(decision(ref({ event: runEvent({ head_repository: { full_name: "Owner/Site" } }) })), "build, deploy");
  });

  it("fails for a branch that is not the default branch", () => {
    assert.match(error(ref({ event: fixture("workflow-run-branch.json") })), /of the branch "feature", not of the default branch "main"/);
  });

  it("fails for a run of a pull request, and for each event of a run that it does not know", () => {
    assert.match(error(ref({ event: fixture("workflow-run-pull-request.json") })), /came from the event "pull_request"/);
    assert.match(error(ref({ event: runEvent({ event: "pull_request_target" }) })), /came from the event "pull_request_target"/);
    assert.match(error(ref({ event: runEvent({ event: undefined }) })), /came from the event ""/);
  });

  it("fails for a run that did not pass", () => {
    assert.match(error(ref({ event: runEvent({ conclusion: "failure" }) })), /concluded "failure"/);
  });

  it("fails when a field is not there or is not a commit hash", () => {
    assert.match(error(ref({ event: {} })), /has no field workflow_run/);
    assert.match(error(ref({ event: runEvent({ head_sha: "main" }) })), /is "main", not a commit hash/);
  });
});

describe("build-ref: the inputs", () => {
  it("fails when the commit of the event or the default branch is not there", () => {
    assert.match(error(ref({ sha: "HEAD" })), /commit of the event is "HEAD"/);
    assert.match(error(ref({ defaultBranch: "" })), /no default branch/);
  });

  it("fails on a head of the default branch with a CI state or an input pending that it does not know", () => {
    assert.match(error(ref({ eventName: "schedule", event: {}, state: "" })), /The CI state of .* is ""/);
    assert.match(error(ref({ event: RELEASE, state: "unknown" })), /is "unknown"/);
    assert.match(error(ref({ eventName: "schedule", event: {}, state: "green", pending: "later" })), /pending is "later"/);
  });

  it("fails for an event that it does not know", () => {
    for (const eventName of ["pull_request_target", "issue_comment", "workflow_call", ""]) {
      assert.match(error(ref({ eventName, event: {} })), /does not know the event/, eventName);
    }
  });

  it("writes the decision and the reason to the summary", () => {
    assert.equal(summary({ build: true, deploy: false, reason: "A reason" }), "### Pages: build yes, deploy no\n\nA reason.\n");
    assert.equal(summary({ error: "An error." }), "### Pages: no build\n\nAn error.\n");
  });
});

describe("build-ref: the step on the event files", () => {
  /** This function starts ref.ts as the step does, and gives its exit code, its output, GITHUB_OUTPUT and the summary. */
  function step(eventName: string, file: string, env: Record<string, string> = {}): { code: number | null; out: string; output: string; summary: string } {
    const dir = mkdtempSync(join(tmpdir(), "build-ref-"));
    const read = (path: string): string => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    };
    try {
      const output = join(dir, "output");
      const stepSummary = join(dir, "summary");
      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: eventName,
          GITHUB_EVENT_PATH: join(fixtures, file),
          GITHUB_REPOSITORY: "owner/site",
          GITHUB_SHA: RUN_SHA,
          GITHUB_REF: MAIN,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: stepSummary,
          DEFAULT_BRANCH: "main",
          STATE: "",
          PENDING: "head",
          ...env,
        },
      });
      return { code: result.status, out: result.stdout + result.stderr, output: read(output), summary: read(stepSummary) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("deploys after a same-repository CI run on main, and writes the outputs and the summary", () => {
    const { code, output, summary } = step("workflow_run", "workflow-run-main.json");
    assert.equal(code, 0);
    assert.equal(output, "build=true\ndeploy=true\n");
    assert.match(summary, /^### Pages: build yes, deploy yes\n/);
  });

  it("writes a notice and deploys nothing on a schedule with a red head", () => {
    const { code, out, output, summary } = step("schedule", "schedule.json", { STATE: "red" });
    assert.equal(code, 0);
    assert.match(out, /::notice title=Pages::.*The site keeps its last deploy/);
    assert.equal(output, "build=false\ndeploy=false\n");
    assert.match(summary, /^### Pages: build no, deploy no\n/);
  });

  it("fails a fork, a branch that is not the default and a run of a pull request, and writes no outputs", () => {
    for (const file of ["workflow-run-fork.json", "workflow-run-branch.json", "workflow-run-pull-request.json"]) {
      const { code, out, output, summary } = step("workflow_run", file);
      assert.equal(code, 1, file);
      assert.match(out, /::error::/, file);
      assert.equal(output, "", file);
      assert.match(summary, /^### Pages: no build\n/, file);
    }
  });

  it("fails when it cannot read the event file", () => {
    const { code, out } = step("push", "no-such-file.json");
    assert.equal(code, 1);
    assert.match(out, /cannot read the event file/);
  });
});
