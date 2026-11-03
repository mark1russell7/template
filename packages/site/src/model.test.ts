import { describe, expect, it } from "vitest";
import { compareFiles, conditionInputs, explore, lineMarks, personalize, treeRows } from "./model.ts";
import type { ScaffoldData, Workflow } from "./types.ts";

const data: ScaffoldData = {
  cliVersion: "0.0.0",
  cliSource: "packages/cli",
  nameMark: "zqxname",
  scopeMark: "zqxscope",
  namePattern: "^[a-z0-9][a-z0-9-]*$",
  presets: [
    {
      name: "node",
      label: "node",
      install: [],
      files: [
        { path: "package.json", text: '{\n  "name": "@zqxscope/zqxname"\n}\n' },
        { path: "src/index.ts", text: "export {};\n" },
      ],
    },
    {
      name: "react",
      label: "react",
      install: ["pnpm add --filter=@zqxscope/zqxname react"],
      files: [
        { path: "package.json", text: '{\n  "name": "@zqxscope/zqxname",\n  "x": 1\n}\n' },
        { path: "src/app.ts", text: "a\n" },
      ],
    },
  ],
};

describe("the package preview", () => {
  it("puts the name and the scope of the visitor in the files and the commands", () => {
    const react = data.presets[1];
    if (react === undefined) throw new Error("no preset");
    const own = personalize(data, react, "web", "acme");
    expect(own.files[0]?.text).toContain('"name": "@acme/web"');
    expect(own.install).toEqual(["pnpm add --filter=@acme/web react"]);
  });

  it("marks the new files, the changed files and the files of the second preset only", () => {
    const [node, react] = data.presets;
    const { marks, removed } = compareFiles(react?.files ?? [], node?.files);
    expect([...marks]).toEqual([
      ["package.json", "changed"],
      ["src/app.ts", "added"],
    ]);
    expect(removed).toEqual(["src/index.ts"]);
    expect([...compareFiles(react?.files ?? [], undefined).marks.values()]).toEqual(["same", "same"]);
  });

  it("marks the lines that the second text does not have", () => {
    expect(lineMarks("a\nb\nb\nc\n", "a\nb\n")).toEqual([false, false, true, true]);
    expect(lineMarks("a\n", undefined)).toEqual([false]);
  });

  it("gives the rows of the file tree, each folder before its files", () => {
    expect(treeRows(["package.json", "src/main.ts", "src/a/b.ts", "src/index.ts"]).map((r) => `${r.depth}:${r.label}`)).toEqual([
      "0:src",
      "1:a",
      "2:b.ts",
      "1:index.ts",
      "1:main.ts",
      "0:package.json",
    ]);
  });
});

const pages: Workflow = {
  file: "p.yml",
  name: "P",
  summary: "",
  inputs: [
    { name: "deploy", type: "boolean", description: "", default: "true", required: false },
    { name: "check", type: "boolean", description: "", default: "false", required: false },
    { name: "unused", type: "string", description: "", default: "", required: false },
  ],
  jobs: [
    {
      id: "build",
      if: "github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'",
      needs: [],
      steps: [
        { label: "always", if: "", uses: "" },
        { label: "check", if: "inputs.check", uses: "" },
        { label: "gate", if: "steps.gate.outputs.run == 'true'", uses: "" },
        { label: "schedule", if: "github.event_name == 'schedule'", uses: "" },
      ],
    },
    { id: "deploy", if: "inputs.deploy", needs: ["build"], steps: [{ label: "deploy", if: "", uses: "" }] },
    { id: "after", if: "", needs: ["deploy"], steps: [] },
  ],
};

describe("the workflow explorer", () => {
  it("gives the state of each job and step for the event and the inputs", () => {
    const jobs = explore(pages, "pull_request", new Map());
    expect(jobs.map((j) => j.state)).toEqual(["runs", "runs", "runs"]);
    expect(jobs[0]?.steps.map((s) => s.state)).toEqual(["runs", "skipped", "unknown", "skipped"]);
    const off = explore(
      pages,
      "schedule",
      new Map([
        ["deploy", false],
        ["check", true],
      ]),
    );
    expect(off.map((j) => j.state)).toEqual(["runs", "skipped", "skipped"]);
    expect(off[2]?.blockedBy).toBe("It needs deploy, which does not run.");
    expect(off[0]?.steps.map((s) => s.state)).toEqual(["runs", "runs", "unknown", "runs"]);
    expect(off[1]?.steps.map((s) => s.state)).toEqual(["skipped"]);
  });

  it("knows the guard of a workflow_run: a CI run of a push to main that passed", () => {
    expect(explore(pages, "workflow_run", new Map())[0]?.state).toBe("runs");
  });

  it("gives only the inputs that a condition reads", () => {
    expect(conditionInputs(pages).map((i) => i.name)).toEqual(["deploy", "check"]);
  });
});
