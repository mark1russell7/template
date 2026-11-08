// Tests ref.ts of the action build-ref: the commit that the job build of reusable-pages.yml checks out. The step fails
// closed, and a fork never gives the commit. The end-to-end tests start the script on the event files of fixtures/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildRef, type RefInput, type RefResult } from "./build-ref/ref.ts";

const script = join(import.meta.dirname, "build-ref", "ref.ts");
const fixtures = join(import.meta.dirname, "build-ref", "fixtures");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const GREEN = "fedcba9876543210fedcba9876543210fedcba98";
const EVENT_SHA = "1111111111111111111111111111111111111111";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(fixtures, name), "utf8")) as unknown;

const ref = (over: Partial<RefInput>): RefResult =>
  buildRef({ eventName: "workflow_run", event: fixture("workflow-run-main.json"), repository: "owner/site", sha: EVENT_SHA, green: "", ...over });

/** The workflow_run event of fixtures/workflow-run-main.json with other fields of its run. */
function runEvent(run: Record<string, unknown>): unknown {
  const event = fixture("workflow-run-main.json") as { workflow_run: Record<string, unknown> };
  return { ...event, workflow_run: { ...event.workflow_run, ...run } };
}

function error(result: RefResult): string {
  assert.ok("error" in result, `The step gives a commit: ${JSON.stringify(result)}`);
  return result.error;
}

describe("build-ref: a workflow_run build", () => {
  it("takes the commit of a passed run of a push to the default branch of this repository", () => {
    assert.deepEqual(ref({}), { sha: SHA, reason: "The commit of CI" });
  });

  it("takes the commit of green-main after a release", () => {
    assert.deepEqual(ref({ event: runEvent({ name: "Release" }), green: GREEN }), { sha: GREEN, reason: "The commit of green-main" });
  });

  it("never takes the commit of a fork", () => {
    assert.match(error(ref({ event: fixture("workflow-run-fork.json") })), /of the repository "attacker\/site", not of owner\/site/);
    assert.match(error(ref({ event: runEvent({ head_repository: {} }) })), /of the repository ""/);
    assert.match(error(ref({ event: fixture("workflow-run-fork.json"), green: GREEN })), /never takes the commit of a fork/);
  });

  it("compares the repository names with no case, as GitHub does", () => {
    assert.deepEqual(ref({ event: runEvent({ head_repository: { full_name: "Owner/Site" } }) }), { sha: SHA, reason: "The commit of CI" });
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
    assert.match(error(ref({ event: { workflow_run: (fixture("workflow-run-main.json") as { workflow_run: unknown }).workflow_run } })), /no default branch/);
    assert.match(error(ref({ event: runEvent({ head_sha: "main" }) })), /is "main", not a commit hash/);
    assert.match(error(ref({ event: runEvent({ name: "Release" }), green: "HEAD" })), /green-main is "HEAD"/);
  });
});

describe("build-ref: the other events", () => {
  it("takes the commit of green-main on a schedule, and fails with no such commit", () => {
    assert.deepEqual(ref({ eventName: "schedule", event: fixture("schedule.json"), green: GREEN }), { sha: GREEN, reason: "The commit of green-main" });
    assert.match(error(ref({ eventName: "schedule", event: fixture("schedule.json") })), /green-main gave none/);
  });

  it("takes the commit of the event for a push, by hand, a repository dispatch and a pull request", () => {
    for (const eventName of ["push", "workflow_dispatch", "repository_dispatch", "pull_request"]) {
      assert.deepEqual(ref({ eventName, event: {} }), { sha: EVENT_SHA, reason: `The commit of the event ${eventName}` }, eventName);
    }
  });

  it("fails when green-main gives a commit to an event that keeps its own commit", () => {
    assert.match(error(ref({ eventName: "push", event: {}, green: GREEN })), /keeps its own commit/);
  });

  it("fails for an event that it does not know", () => {
    for (const eventName of ["pull_request_target", "issue_comment", "workflow_call", ""]) {
      assert.match(error(ref({ eventName, event: {} })), /does not know the event/, eventName);
    }
  });
});

describe("build-ref: the step on the event files", () => {
  /** This function starts ref.ts as the step does, and gives its exit code, its output and the file GITHUB_OUTPUT. */
  function step(eventName: string, file: string, green = ""): { code: number | null; out: string; output: string } {
    const dir = mkdtempSync(join(tmpdir(), "build-ref-"));
    try {
      const output = join(dir, "output");
      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: join(fixtures, file), GITHUB_REPOSITORY: "owner/site", GITHUB_SHA: EVENT_SHA, GITHUB_OUTPUT: output, GREEN: green },
      });
      let written = "";
      try {
        written = readFileSync(output, "utf8");
      } catch {
        written = "";
      }
      return { code: result.status, out: result.stdout + result.stderr, output: written };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("passes a same-repository workflow_run on main, and writes the commit", () => {
    const { code, output } = step("workflow_run", "workflow-run-main.json");
    assert.equal(code, 0);
    assert.equal(output, `sha=${SHA}\n`);
  });

  it("passes a schedule with the commit of green-main", () => {
    const { code, output } = step("schedule", "schedule.json", GREEN);
    assert.equal(code, 0);
    assert.equal(output, `sha=${GREEN}\n`);
  });

  it("fails a fork, a branch that is not the default and a run of a pull request, and writes no commit", () => {
    for (const file of ["workflow-run-fork.json", "workflow-run-branch.json", "workflow-run-pull-request.json"]) {
      const { code, out, output } = step("workflow_run", file);
      assert.equal(code, 1, file);
      assert.match(out, /::error::/, file);
      assert.equal(output, "", file);
    }
  });

  it("fails when it cannot read the event file", () => {
    const { code, out } = step("push", "no-such-file.json");
    assert.equal(code, 1);
    assert.match(out, /cannot read the event file/);
  });
});
