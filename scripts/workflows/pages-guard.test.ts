// The tests of the guard of the job build of reusable-pages.yml. Start them with "pnpm test:workflows".
// A workflow_run builds and deploys only after a CI run of a push to the default branch passed.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(resolve(root, ".github/workflows/reusable-pages.yml"), "utf-8");

/** The expression of the "if" key of the job build. */
function buildGuard(): string {
  const job = workflow.slice(workflow.indexOf("\n  build:\n"));
  const match = /\n    if: (.+)\n/.exec(job);
  assert.ok(match, "The job build has an if key.");
  return match[1] ?? "";
}

/** The value of the key `ref` of each checkout of the repository in the job build: the checkouts with no `repository` key. */
function buildRefs(): string[] {
  const job = workflow.slice(workflow.indexOf("\n  build:\n"), workflow.indexOf("\n  deploy:\n"));
  return job
    .split("\n      - ")
    .filter((step) => step.includes("uses: actions/checkout@") && !step.includes("repository:"))
    .map((step) => /\n {10}ref: (.+)\n/.exec(step)?.[1] ?? "");
}

/** The expression of the "if" key of a step of the job build, from the line before that key. */
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

describe("the guard of the job build of reusable-pages.yml", () => {
  const guard = buildGuard();

  it("builds for the events push, schedule and workflow_dispatch", () => {
    for (const event_name of ["push", "schedule", "workflow_dispatch"]) {
      assert.equal(evaluate(guard, { event_name, event: {} }), true, event_name);
    }
  });

  it("builds after a CI run of a push to the default branch passed", () => {
    assert.equal(evaluate(guard, workflowRun({})), true);
  });

  it("builds nothing after a CI run of a push to a different branch", () => {
    assert.equal(evaluate(guard, workflowRun({ head_branch: "feature" })), false);
  });

  it("builds nothing after a failed CI run or a CI run of a pull request", () => {
    assert.equal(evaluate(guard, workflowRun({ conclusion: "failure" })), false);
    assert.equal(evaluate(guard, workflowRun({ event: "pull_request" })), false);
  });

  it("builds after a release of a push and after a release that a person starts", () => {
    assert.equal(evaluate(guard, workflowRun({ name: "Release" })), true);
    assert.equal(evaluate(guard, workflowRun({ name: "Release", event: "workflow_dispatch" })), true);
  });

  it("builds nothing after a failed release, or a release that a person starts on a different branch", () => {
    assert.equal(evaluate(guard, workflowRun({ name: "Release", conclusion: "failure" })), false);
    assert.equal(evaluate(guard, workflowRun({ name: "Release", event: "workflow_dispatch", head_branch: "feature" })), false);
  });
});

describe("the commit of the job build of reusable-pages.yml", () => {
  it("checks out only the commit of the step ref, so no field of the event reaches the checkout", () => {
    assert.deepEqual(buildRefs(), ["${{ steps.ref.outputs.sha }}"]);
  });

  it("gives the commit of green-main to the step ref", () => {
    const step = ["      - id: ref", "        uses: ./.shared-actions/.github/actions/build-ref", "        with:", "          green: ${{ steps.green.outputs.sha }}", ""];
    assert.ok(workflow.includes(step.join("\n")), "The step ref gets the commit of green-main.");
  });
});

describe("the step green of the job build of reusable-pages.yml", () => {
  const condition = stepCondition("      - id: green");
  const asks = (github: unknown): boolean => Boolean(evaluate(condition, github));

  it("gets the shared actions for each event, because the step ref needs them", () => {
    assert.ok(workflow.includes("      - name: Shared actions (the commit to build)\n        uses: "), "The step has no if key.");
  });

  it("gives the commit on a schedule and after a release, so that the site does not go back and no red commit deploys", () => {
    assert.equal(asks({ event_name: "schedule", event: {} }), true);
    assert.equal(asks({ event_name: "workflow_run", event: { workflow_run: { name: "Release" } } }), true);
  });

  it("gives no commit after CI, on a push or by hand, so these keep their own commit", () => {
    assert.equal(asks({ event_name: "workflow_run", event: { workflow_run: { name: "CI" } } }), false);
    assert.equal(asks({ event_name: "push", event: {} }), false);
    assert.equal(asks({ event_name: "workflow_dispatch", event: {} }), false);
  });
});
