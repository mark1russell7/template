import { describe, expect, it } from "vitest";
import { readWorkflows } from "./node/data.ts";
import { readWorkflow } from "@mark1russell7/conventions";

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
    expect(pages?.jobs.map((j) => j.id)).toEqual(["build", "deploy", "indexnow"]);
    expect(pages?.jobs[1]).toMatchObject({ if: "inputs.deploy", needs: ["build"] });
    expect(pages?.jobs[2]).toMatchObject({ if: "inputs.deploy && inputs.indexnow-key != '' && github.event_name != 'schedule'", needs: ["deploy"] });
    const steps = pages?.jobs[0]?.steps ?? [];
    expect(steps.find((s) => s.label === "Site check")?.if).toBe("inputs.site-check");
    expect(steps.find((s) => s.label === "actions/checkout")).toBeDefined();
    expect(pages?.summary).toMatch(/^The shared GitHub Pages deployment/);
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
});
