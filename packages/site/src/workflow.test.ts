import { describe, expect, it } from "vitest";
import { readWorkflows } from "./node/data.ts";
import { readAction, readWorkflow } from "@mark1russell7/conventions";
import { explore } from "./model.ts";

describe("the reader of the shared workflows", () => {
  const workflows = readWorkflows();

  it("reads each shared workflow of the repository", () => {
    expect(workflows.map((w) => w.file)).toContain("reusable-pages.yml");
    expect(workflows.map((w) => w.file)).toContain("reusable-ci.yml");
    for (const workflow of workflows) expect(workflow.jobs.length, workflow.file).toBeGreaterThan(0);
  });

  it("reads the inputs, the jobs and the conditions of reusable-pages.yml", () => {
    const pages = workflows.find((w) => w.file === "reusable-pages.yml");
    expect(pages?.inputs.find((i) => i.name === "site-check")).toMatchObject({ type: "boolean", default: "false" });
    expect(pages?.inputs.find((i) => i.name === "deploy")).toMatchObject({ type: "boolean", default: "true" });
    expect(pages?.jobs.map((j) => j.id)).toEqual(["ref", "build", "deploy", "indexnow"]);
    expect(pages?.jobs[1]).toMatchObject({ if: "needs.ref.outputs.build == 'true'", needs: ["ref"] });
    expect(pages?.jobs[2]).toMatchObject({ if: "inputs.deploy && needs.ref.outputs.deploy == 'true'", needs: ["ref", "build"] });
    expect(pages?.jobs[3]).toMatchObject({ if: "inputs.deploy && needs.build.outputs.indexnow-key != '' && github.event_name != 'schedule'", needs: ["build", "deploy"] });
    const steps = pages?.jobs[1]?.steps ?? [];
    expect(steps.find((s) => s.label === "actions/checkout")).toBeDefined();
    expect(steps.map((s) => s.uses)).toEqual(expect.arrayContaining(["./.shared-actions/.github/actions/site-config", "./.shared-actions/.github/actions/pages-build"]));
    expect(pages?.inputs.find((i) => i.name === "scroll-cue")).toMatchObject({ type: "boolean", default: "true" });
    expect(pages?.summary).toMatch(/^The shared GitHub Pages deployment/);
  });

  it("reads the conditions of the site check and the scroll cue in the action pages-build", () => {
    const build = workflows.find((w) => w.file === "actions/pages-build/action.yml");
    const steps = build?.jobs[0]?.steps ?? [];
    expect(steps.find((s) => s.label === "Site check")?.if).toBe("fromJSON(inputs.config)['site-check'] || fromJSON(inputs.config)['site-bar']");
    expect(steps.find((s) => s.label === "Scroll cue")?.if).toBe("fromJSON(inputs.config)['scroll-cue']");
  });

  it("reads block scalars, inline lists and quoted keys", () => {
    const text = [
      "name: Demo",
      '"on":',
      "  workflow_call:",
      "    inputs:",
      "      flag:",
      "        type: boolean",
      "        default: true",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo one",
      "  b:",
      "    needs: [a, c]",
      "    if: >-",
      "      inputs.flag &&",
      "      github.event_name == 'push'",
      "    steps:",
      "      - name: Two",
      "        if: inputs.flag # a comment",
      "        run: |",
      "          echo two",
      "  c:",
      "    needs:",
      "      - a",
      "    uses: ./.github/workflows/other.yml",
    ].join("\n");
    const workflow = readWorkflow("demo.yml", text);
    expect(workflow.inputs).toEqual([{ name: "flag", type: "boolean", description: "", default: "true", required: false }]);
    expect(workflow.jobs.map((j) => [j.id, j.needs, j.if])).toEqual([
      ["a", [], ""],
      ["b", ["a", "c"], "inputs.flag && github.event_name == 'push'"],
      ["c", ["a"], ""],
    ]);
    expect(workflow.jobs[0]?.steps[0]?.label).toBe("echo one");
    expect(workflow.jobs[1]?.steps[0]).toEqual({ label: "Two", if: "inputs.flag", uses: "" });
    expect(workflow.jobs[2]?.steps[0]?.label).toBe("calls ./.github/workflows/other.yml");
  });

  it("reads each composite action of the repository after the workflows, as a workflow with one job steps", () => {
    const files = workflows.map((w) => w.file);
    expect(files.indexOf("actions/site-check/action.yml")).toBeGreaterThan(files.indexOf("reusable-pages.yml"));
    const check = workflows.find((w) => w.file === "actions/site-check/action.yml");
    expect(check).toMatchObject({ kind: "action", name: "site-check" });
    expect(check?.inputs.find((i) => i.name === "visual")).toMatchObject({ type: "boolean", default: "true" });
    expect(check?.jobs.map((j) => j.id)).toEqual(["steps"]);
    expect(check?.jobs[0]?.steps.find((step) => step.label === "Site check")).toMatchObject({ if: "inputs.visual == 'true'" });
  });

  it("judges a step of a composite action with its input as a string, as the runner gives it", () => {
    const check = workflows.find((w) => w.file === "actions/site-check/action.yml");
    if (check === undefined) throw new Error("the reader gives no actions/site-check/action.yml");
    const stateOf = (visual: boolean) => explore(check, "push", new Map([["visual", visual]]))[0]?.steps.find((step) => step.label === "Site check")?.state;
    expect(stateOf(true)).toBe("runs");
    expect(stateOf(false)).toBe("skipped");
  });

  it("reads a composite action: its inputs, its steps and its description", () => {
    const text = [
      "name: demo",
      "description: >-",
      "  Does one thing,",
      "  in two lines.",
      "inputs:",
      "  flag:",
      "    description: A flag.",
      '    default: "false"',
      "  path:",
      "    required: true",
      "runs:",
      "  using: composite",
      "  steps:",
      "    - name: One",
      "      if: inputs.flag == 'true' # a comment",
      "      shell: bash",
      "      run: echo one",
      "    - uses: ./.shared-actions/.github/actions/other",
    ].join("\n");
    const action = readAction("actions/demo/action.yml", text);
    expect(action).toMatchObject({ file: "actions/demo/action.yml", kind: "action", name: "demo", summary: "Does one thing, in two lines." });
    expect(action.inputs).toEqual([
      { name: "flag", type: "boolean", description: "A flag.", default: "false", required: false },
      { name: "path", type: "string", description: "", default: "", required: true },
    ]);
    expect(action.jobs).toEqual([
      {
        id: "steps",
        if: "",
        needs: [],
        steps: [
          { label: "One", if: "inputs.flag == 'true'", uses: "" },
          { label: "./.shared-actions/.github/actions/other", if: "", uses: "./.shared-actions/.github/actions/other" },
        ],
      },
    ]);
    // An action that is not composite has no steps to show.
    expect(readAction("actions/js/action.yml", "name: js\nruns:\n  using: node24\n  main: index.js\n").jobs).toEqual([]);
  });
});
