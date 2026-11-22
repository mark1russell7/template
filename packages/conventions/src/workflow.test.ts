// The parser reader parseWorkflow: triggers, permissions, secrets, jobs, steps and faults. A last test reads the
// workflows of the template with both readers, so a field of the line reader can move to the parser one at a time.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkflow, readWorkflow, type ParsedWorkflow } from "./index.ts";

const lines = (...text: string[]): string => `${text.join("\n")}\n`;

/** This function reads a text that must parse, and fails the test on a fault. */
function parsed(text: string): ParsedWorkflow {
  const workflow = parseWorkflow("demo.yml", text);
  expect(workflow.faults).toEqual([]);
  return workflow;
}

describe("parseWorkflow", () => {
  it("reads the triggers in each form of on, also on as a quoted key", () => {
    expect(parsed(lines("on: push", "jobs: {}")).triggers).toEqual(["push"]);
    expect(parsed(lines("on: [pull_request_target, workflow_run]", "jobs: {}")).triggers).toEqual(["pull_request_target", "workflow_run"]);
    expect(parsed(lines('"on":', "  workflow_run:", "    workflows: [CI]", "  pull_request:", "jobs: {}")).triggers).toEqual(["workflow_run", "pull_request"]);
    expect(parsed(lines("on:", "  - push", "  - workflow_dispatch", "jobs: {}")).triggers).toEqual(["push", "workflow_dispatch"]);
    expect(parsed(lines("on: { pull_request_target: { types: [opened] } }", "jobs: {}")).triggers).toEqual(["pull_request_target"]);
  });

  it("reads the permissions of the workflow and of each job", () => {
    const workflow = parsed(
      lines(
        "on: push",
        "permissions: {}",
        "jobs:",
        "  none:",
        "    runs-on: ubuntu-latest",
        "  read:",
        "    permissions: read-all",
        "  scopes:",
        "    permissions:",
        "      contents: read",
        "      pull-requests: write",
        "  empty:",
        "    permissions:",
      ),
    );
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.map((job) => [job.id, job.permissions])).toEqual([
      ["none", null],
      ["read", "read-all"],
      ["scopes", { contents: "read", "pull-requests": "write" }],
      ["empty", "null"],
    ]);
    expect(parsed(lines("on: push", "jobs: {}")).permissions).toBeNull();
  });

  it("finds each reference to a secret in an expression, and no word secrets outside one", () => {
    const workflow = parsed(
      lines(
        "on: push",
        "env:",
        "  TOP: ${{ secrets.TOP_TOKEN }}",
        "jobs:",
        "  build:",
        "    if: secrets.IN_IF != ''",
        "    env:",
        "      A: ${{ Secrets.Mixed_Case }}",
        "      B: ${{ secrets['IN_BRACKETS'] }}",
        "      C: ${{ toJSON(secrets) }}",
        "    steps:",
        "      - run: echo the secrets of the job are not in this text",
        "      - name: Deploy",
        "        with:",
        "          token: ${{ github.token }} and ${{ secrets.DEPLOY }}",
        "          secrets.KEY: a key is not an expression",
        "  call:",
        "    uses: octo/shared/.github/workflows/build.yml@v1",
        "    secrets: inherit",
        "  calm:",
        "    steps:",
        "      - run: echo ${{ github.event.inputs.secrets }} ${{ needs.a.outputs.secrets }}",
      ),
    );
    const [build, call, calm] = workflow.jobs;
    expect(build?.secrets).toEqual(["IN_IF", "Mixed_Case", "IN_BRACKETS", "*", "DEPLOY"]);
    expect(build?.steps.map((step) => step.secrets)).toEqual([[], ["DEPLOY"]]);
    expect(call).toMatchObject({ uses: "octo/shared/.github/workflows/build.yml", secrets: ["inherit"], steps: [] });
    expect(calm?.secrets).toEqual([]);
    expect(workflow.secrets).toEqual(["TOP_TOKEN", "IN_IF", "Mixed_Case", "IN_BRACKETS", "*", "DEPLOY", "inherit"]);
  });

  it("counts a reference in an expression with no end, and in each place of an alias one time", () => {
    const workflow = parsed(
      lines(
        "on: push",
        "jobs:",
        "  a:",
        "    env: &shared",
        "      KEY: ${{ secrets.SHARED }}",
        "    steps:",
        "      - run: echo ${{ secrets.OPEN",
        "        env: *shared",
      ),
    );
    expect(workflow.jobs[0]?.secrets).toEqual(["SHARED", "OPEN"]);
    expect(workflow.jobs[0]?.steps[0]?.secrets).toEqual(["OPEN", "SHARED"]);
  });

  it("reads the jobs and the steps with the labels of the line reader", () => {
    const workflow = parsed(
      lines(
        "name: Demo",
        "on: workflow_dispatch",
        "jobs:",
        "  a:",
        "    steps:",
        "      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567 # v6",
        "        with: { persist-credentials: false }",
        "      - { name: Flow, uses: actions/setup-node@v6, if: always() }",
        "      - run: |",
        "          echo one",
        "          echo two",
        "      - id: last",
        "        shell: bash",
        "  b:",
        "    needs: a",
        "    if: >-",
        "      github.event_name ==",
        "      'workflow_dispatch'",
        "    steps: []",
      ),
    );
    expect(workflow.name).toBe("Demo");
    expect(workflow.jobs.map((job) => [job.id, job.needs, job.if])).toEqual([
      ["a", [], ""],
      ["b", ["a"], "github.event_name == 'workflow_dispatch'"],
    ]);
    expect(workflow.jobs[0]?.steps.map((step) => [step.label, step.if, step.uses])).toEqual([
      ["actions/checkout", "", "actions/checkout"],
      ["Flow", "always()", "actions/setup-node"],
      ["echo one", "", ""],
      ["last", "", ""],
    ]);
    expect(parsed(lines("on: push", "jobs: {}")).name).toBe("demo.yml");
  });

  it("gives faults and no job for a file that does not parse, two documents or YAML 1.1", () => {
    const broken = parseWorkflow("demo.yml", lines("on: push", "jobs:", "  a:", "    steps:", "      - run: |", "echo at column one", "  b: {"));
    expect(broken.faults.length).toBeGreaterThan(0);
    expect(broken).toMatchObject({ triggers: [], jobs: [], secrets: [], permissions: null });

    const twice = parseWorkflow("demo.yml", lines("on: push", "permissions: {}", "permissions: write-all", "jobs: {}"));
    expect(twice.faults.map((fault) => fault.line)).toEqual([3]);
    expect(twice.permissions).toBeNull();

    const two = parseWorkflow("demo.yml", lines("on: push", "jobs: {}", "---", "on: pull_request_target", "jobs: {}"));
    expect(two.faults).toEqual([{ line: 3, column: 1, message: "The file has 2 YAML documents, and a workflow is one document" }]);
    expect(two.triggers).toEqual([]);

    // YAML 1.1 reads the key on as true, so the reader would see no trigger
    const old = parseWorkflow("demo.yml", lines("%YAML 1.1", "---", "on: pull_request_target", "jobs: {}"));
    expect(old.faults).toEqual([{ line: 1, column: 1, message: "The file asks for YAML 1.1, and the reader takes only YAML 1.2" }]);
    expect(old.triggers).toEqual([]);
  });

  it("gives no fact and no fault for an empty file or a file that is not a map", () => {
    expect(parseWorkflow("demo.yml", "")).toEqual({ file: "demo.yml", name: "demo.yml", triggers: [], permissions: null, secrets: [], jobs: [], faults: [] });
    expect(parseWorkflow("demo.yml", "- push\n")).toMatchObject({ triggers: [], jobs: [], faults: [] });
  });

  it("gives a fault, and does not throw, for too many aliases", () => {
    const text = lines("on: push", "a: &a [x, x, x, x, x, x, x, x, x, x]", "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]", "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]", "jobs: {}");
    const workflow = parseWorkflow("demo.yml", text);
    expect(workflow.faults).toHaveLength(1);
    expect(workflow.jobs).toEqual([]);
  });
});

describe("the two readers on the workflows of the template", () => {
  const folder = join(import.meta.dirname, "../../../.github/workflows");
  const files = readdirSync(folder).filter((file) => /\.ya?ml$/.test(file)).sort();

  it("finds the workflows of the template", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)("%s: the jobs, the needs, the conditions and the steps are the same", (file) => {
    const text = readFileSync(join(folder, file), "utf8");
    const parser = parseWorkflow(file, text);
    expect(parser.faults).toEqual([]);
    const line = readWorkflow(file, text);
    // The line reader gives a job that calls a workflow one step `calls <workflow>`
    const asLines = parser.jobs.map((job) => ({
      id: job.id,
      if: job.if,
      needs: job.needs,
      steps: job.steps.length === 0 && job.uses !== "" ? [{ label: `calls ${job.uses}`, if: "", uses: job.uses }] : job.steps.map(({ label, if: condition, uses }) => ({ label, if: condition, uses })),
    }));
    expect(asLines).toEqual(line.jobs);
    expect(parser.name).toBe(line.name);
  });
});
