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
});
