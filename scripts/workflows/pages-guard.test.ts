// The tests of the guard of the job ref of reusable-pages.yml, and of the commit of the job build. Start them with
// "pnpm test:workflows". A workflow_run starts only after a CI run of a push to the default branch passed.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(resolve(root, ".github/workflows/reusable-pages.yml"), "utf-8");

/** The text of a job, from its key to the key of the next job. */
function jobText(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `The workflow has the job ${name}.`);
  const next = /\n  [a-z-]+:\n/g;
  next.lastIndex = start + 1;
  const end = next.exec(workflow)?.index ?? workflow.length;
  return workflow.slice(start, end);
}

/** The expression of the "if" key of a job. */
function jobGuard(name: string): string {
  const match = /\n    if: (.+)\n/.exec(jobText(name));
  assert.ok(match, `The job ${name} has an if key.`);
  return match[1] ?? "";
}

/** The checkouts of the repository in a job: the checkouts with no `repository` key. */
function repositoryCheckouts(name: string): string[] {
  return jobText(name)
    .split("\n      - ")
    .filter((step) => step.includes("uses: actions/checkout@") && !step.includes("repository:"));
}

/** The expression of the "if" key of a step, from the line before that key. */
function stepCondition(line: string): string {
  const at = workflow.indexOf(`${line}\n        if: `);
  assert.ok(at >= 0, `The step "${line.trim()}" has an if key.`);
  const start = at + line.length + "\n        if: ".length;
  return workflow.slice(start, workflow.indexOf("\n", start));
}

/**
 * This function evaluates the guard for an event. It knows only the operators of the guard:
 * ==, !=, && and || on the values of the github context and on strings.
 */
function evaluate(expression: string, github: unknown): unknown {
  const js = expression
    .replace(/'([^']*)'/g, (_: string, text: string) => JSON.stringify(text))
    .replace(/!=/g, "!==")
    .replace(/(?<![!=])==/g, "===")
    .replace(/\bgithub((?:\.[A-Za-z_][A-Za-z0-9_-]*)+)/g, (_: string, path: string) => `get(${JSON.stringify(path.slice(1))})`);
  assert.match(js, /^[\sget()"A-Za-z0-9_.\-!=&|]+$/, `The guard has only known operators: ${js}`);
  const get = (path: string): unknown =>
    path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | null | undefined)?.[key], github);
  return new Function("get", `return (${js});`)(get);
}

/** The github context of a workflow_run event. */
function workflowRun(run: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    event_name: "workflow_run",
    event: { repository: { default_branch: "main" }, workflow_run: { conclusion: "success", event: "push", head_branch: "main", ...run } },
  };
}

describe("the guard of the job ref of reusable-pages.yml", () => {
  const guard = jobGuard("ref");

  it("starts for the events push, pull_request, schedule, workflow_dispatch and repository_dispatch", () => {
    for (const event_name of ["push", "pull_request", "schedule", "workflow_dispatch", "repository_dispatch"]) {
      assert.equal(evaluate(guard, { event_name, event: {} }), true, event_name);
    }
  });

  it("starts after a CI run of a push to the default branch passed", () => {
    assert.equal(evaluate(guard, workflowRun({})), true);
  });

  it("starts nothing after a CI run of a push to a different branch", () => {
    assert.equal(evaluate(guard, workflowRun({ head_branch: "feature" })), false);
  });

  it("starts nothing after a failed CI run or a CI run of a pull request", () => {
    assert.equal(evaluate(guard, workflowRun({ conclusion: "failure" })), false);
    assert.equal(evaluate(guard, workflowRun({ event: "pull_request" })), false);
  });

  it("starts after a release of a push and after a release that a person starts", () => {
    assert.equal(evaluate(guard, workflowRun({ name: "Release" })), true);
    assert.equal(evaluate(guard, workflowRun({ name: "Release", event: "workflow_dispatch" })), true);
  });

  it("starts nothing after a failed release, or a release that a person starts on a different branch", () => {
    assert.equal(evaluate(guard, workflowRun({ name: "Release", conclusion: "failure" })), false);
    assert.equal(evaluate(guard, workflowRun({ name: "Release", event: "workflow_dispatch", head_branch: "feature" })), false);
  });
});

describe("the commit of the job build of reusable-pages.yml", () => {
  it("checks out the commit of the event with no ref, so that no computed commit reaches the checkout", () => {
    const checkouts = repositoryCheckouts("build");
    assert.equal(checkouts.length, 1);
    assert.doesNotMatch(checkouts[0] ?? "", /\n {10}ref:/);
  });

  it("checks out no commit of the repository in the job ref", () => {
    assert.deepEqual(repositoryCheckouts("ref"), []);
  });

  it("builds only on the decision of the job ref, and deploys only on its decision", () => {
    assert.match(jobText("build"), /\n    needs: ref\n    if: needs\.ref\.outputs\.build == 'true'\n/);
    assert.match(jobText("deploy"), /\n    needs: \[ref, build\]\n    if: inputs\.deploy && needs\.ref\.outputs\.deploy == 'true'\n/);
  });

  it("gives the CI state of the commit of the event to the step ref", () => {
    assert.ok(jobText("ref").includes("\n      - id: green\n        if: "), "The job ref has the step green.");
    assert.ok(jobText("ref").includes("\n          commit: ${{ github.sha }}\n"), "green-main reads the commit of the event.");
    const step = ["      - id: ref", "        uses: ./.shared-actions/.github/actions/build-ref", "        with:", "          state: ${{ steps.green.outputs.state }}", ""];
    assert.ok(jobText("ref").includes(step.join("\n")), "The step ref gets the CI state of green-main.");
  });
});

describe("the step green of the job ref of reusable-pages.yml", () => {
  const condition = stepCondition("      - id: green");
  const asks = (github: unknown): boolean => Boolean(evaluate(condition, github));

  it("gets the shared actions for each event, because the step ref needs them", () => {
    assert.ok(jobText("ref").includes("      - name: Shared actions\n        uses: "), "The step has no if key.");
  });

  it("reads the CI state for each event on the head of the default branch, so that no red head deploys", () => {
    for (const event_name of ["schedule", "workflow_dispatch", "repository_dispatch"]) {
      assert.equal(asks({ event_name, event: {} }), true, event_name);
    }
    assert.equal(asks({ event_name: "workflow_run", event: { workflow_run: { name: "Release" } } }), true);
  });

  it("reads no CI state after CI, on a push or on a pull request, because these do not use it", () => {
    assert.equal(asks({ event_name: "workflow_run", event: { workflow_run: { name: "CI" } } }), false);
    assert.equal(asks({ event_name: "push", event: {} }), false);
    assert.equal(asks({ event_name: "pull_request", event: {} }), false);
  });
});
