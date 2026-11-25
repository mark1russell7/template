// The tests of the mode of the release in the workflow files: node --test scripts/release/
//
// The mode (mode.ts) is "publish" in a repository with no .changeset/config.json. These tests hold that the mode
// "publish" starts the same steps and jobs as the release before the mode, and that the mode "version" publishes
// nothing. They read the workflows with a YAML parser.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..", "..");

/** The parts of a step or a job that the tests read. */
interface Item {
  readonly name?: string;
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps?: readonly Item[];
  readonly with?: Readonly<Record<string, unknown>>;
}

/** The parts of a workflow that the tests read. */
interface Workflow {
  readonly on: { readonly push?: { readonly paths?: readonly string[] } };
  readonly jobs: Readonly<Record<string, Item>>;
  readonly outputs?: unknown;
}

/** This function reads a workflow of the template with the YAML parser. */
function workflow(file: string): Workflow {
  return parse(readFileSync(join(root, ".github", "workflows", file), "utf8")) as Workflow;
}

/** The text of a condition without "${{ }}" and with one space between the words. */
function bare(condition: string | undefined): string | undefined {
  if (condition === undefined) return undefined;
  const inner = /^\$\{\{([\s\S]*)\}\}$/u.exec(condition.trim())?.[1] ?? condition;
  return inner.replace(/\s+/gu, " ").trim();
}

/** A condition on the mode, as a part of a condition with "&&". */
const MODE_PART = /^(?:steps\.mode\.outputs\.mode|needs\.build\.outputs\.mode) (==|!=) '(publish|version)'$/u;

/**
 * This function splits a condition at its "&&" into the parts on the mode and the other parts. It gives the value of
 * the parts on the mode for a mode, and the other parts as one condition: the condition before the mode.
 */
function splitMode(condition: string | undefined, mode: "publish" | "version"): { runs: boolean; rest: string | undefined } {
  const text = bare(condition);
  if (text === undefined) return { runs: true, rest: undefined };
  const parts = text.split(" && ");
  let runs = true;
  const rest: string[] = [];
  for (const part of parts) {
    const match = MODE_PART.exec(part);
    if (match) runs &&= match[1] === "==" ? match[2] === mode : match[2] !== mode;
    else {
      assert.ok(!part.includes(".mode"), `The part "${part}" names the mode in a form that the test does not read.`);
      rest.push(part);
    }
  }
  return { runs, rest: rest.length > 0 ? rest.join(" && ") : undefined };
}

/** The key of a step in the log of a test: its name, else its action, else its first line. */
const keyOf = (step: Item): string => step.name ?? step.uses?.replace(/@.*/u, "") ?? step.run?.split("\n")[0] ?? "?";

describe("reusable-release-build.yml in the two modes", () => {
  const job = workflow("reusable-release-build.yml").jobs["pack"];
  const steps = job?.steps ?? [];
  const modeIndex = steps.findIndex((step) => step.id === "mode");

  it("decides the mode before the install, with mode.ts of the template commit", () => {
    assert.ok(modeIndex > 0, "The job has the step with the id mode.");
    assert.match(steps[modeIndex]?.run ?? "", /scripts\/release\/mode\.ts/u);
    const before = steps.slice(0, modeIndex);
    assert.deepEqual(
      before.filter((step) => /pnpm|install/u.test(`${step.uses ?? ""} ${step.run ?? ""}`)).map(keyOf),
      [],
      "No install before the mode.",
    );
    // The steps before the mode start in each mode, with the conditions that they had before the mode.
    assert.deepEqual(before.map((step) => bare(step.if)), ["inputs.require-main", undefined, undefined, undefined, undefined]);
  });

  it("starts each step of the release before the mode in the mode publish, with its condition before the mode", () => {
    const publish = steps.slice(modeIndex + 1).map((step) => ({ key: keyOf(step), ...splitMode(step.if, "publish") }));
    assert.deepEqual(
      publish.filter((step) => !step.runs).map((step) => step.key),
      [],
    );
    // The conditions other than the mode: only the input after-pack, as before the mode.
    assert.deepEqual(
      publish.filter((step) => step.rest !== undefined).map((step) => `${step.key}: ${String(step.rest)}`),
      ["After the pack: inputs.after-pack != ''"],
    );
    // The steps of the release: the install, the build, the pack, the plan of the tags, and the two uploads.
    const text = steps.slice(modeIndex + 1).map((step) => `${step.uses ?? ""} ${step.run ?? ""}`).join("\n");
    for (const part of ["pnpm install --frozen-lockfile", "scripts/release/pack.ts", "scripts/release/tags.ts", "actions/upload-artifact"]) {
      assert.ok(text.includes(part), `The mode publish starts ${part}.`);
    }
  });

  it("starts no step after the mode in the mode version: no install, no pack, no upload", () => {
    const version = steps.slice(modeIndex + 1).filter((step) => splitMode(step.if, "version").runs);
    assert.deepEqual(version.map(keyOf), []);
  });

  it("gives the mode as an output of the workflow", () => {
    const outputs = parse(readFileSync(join(root, ".github", "workflows", "reusable-release-build.yml"), "utf8")) as {
      on: { workflow_call: { outputs: Record<string, { value: string }> } };
    };
    const values = outputs.on.workflow_call.outputs;
    assert.equal(values["mode"]?.value, "${{ jobs.pack.outputs.mode }}");
    assert.deepEqual(job?.permissions, { contents: "read" });
  });
});

describe("release.yml in the two modes", () => {
  const release = workflow("release.yml");
  const before = "!cancelled() && needs.build.result == 'success'";

  it("starts publish and tag in the mode publish, with their conditions before the mode", () => {
    for (const name of ["publish", "tag"]) {
      const result = splitMode(release.jobs[name]?.if, "publish");
      assert.deepEqual(result, { runs: true, rest: before }, `The job ${name}.`);
    }
  });

  it("starts no publish and no tag in the mode version", () => {
    for (const name of ["publish", "tag"]) assert.equal(splitMode(release.jobs[name]?.if, "version").runs, false, `The job ${name}.`);
  });

  it("starts the job version only in the mode version, after the build", () => {
    const version = release.jobs["version"];
    assert.equal(version?.needs, "build");
    assert.deepEqual(splitMode(version?.if, "version"), { runs: true, rest: before });
    assert.equal(splitMode(version?.if, "publish").runs, false);
  });

  it("gives pull-requests: write only to the job version, and id-token only to the job publish", () => {
    const holders = (scope: string, level: string): string[] =>
      Object.entries(release.jobs)
        .filter(([, item]) => item.permissions?.[scope] === level)
        .map(([name]) => name);
    assert.deepEqual(holders("pull-requests", "write"), ["version"]);
    assert.deepEqual(holders("id-token", "write"), ["publish"]);
    assert.deepEqual(release.jobs["version"]?.permissions, { contents: "write", "pull-requests": "write" });
  });

  it("calls reusable-release-version.yml for the job version, as the jobs build and tag", () => {
    assert.equal(release.jobs["version"]?.uses, "./.github/workflows/reusable-release-version.yml");
    assert.equal(release.jobs["version"]?.steps, undefined, "No steps in release.yml: the shared workflow has them.");
  });

  it("starts on the files of a version and on the changesets", () => {
    assert.deepEqual(release.on.push?.paths, ["package.json", "packages/*/package.json", ".changeset/*.md"]);
  });
});

describe("reusable-release-version.yml", () => {
  const shared = workflow("reusable-release-version.yml");
  const steps = shared.jobs["version"]?.steps ?? [];

  it("has one job, with the permissions that the caller job of release.yml gives, and no OIDC token", () => {
    assert.deepEqual(Object.keys(shared.jobs), ["version"]);
    assert.deepEqual(shared.jobs["version"]?.permissions, { contents: "write", "pull-requests": "write" });
    assert.deepEqual(shared.jobs["version"]?.permissions, workflow("release.yml").jobs["version"]?.permissions);
  });

  it("opens the version pull request only on the head of main, and puts the steps for a person in its text", () => {
    const head = steps.findIndex((step) => step.id === "head");
    const action = steps.findIndex((step) => step.uses?.startsWith("changesets/action@") === true);
    assert.ok(head >= 0 && action > head, "The head check comes before the Changesets action.");
    assert.equal(bare(steps[action]?.if), "steps.head.outputs.head == 'true'");
    assert.equal(steps[action]?.with?.["publish-script"], undefined, "The action publishes nothing.");
    assert.equal(steps[action]?.with?.["pr-title"], "Version the packages");
    assert.match(steps.at(-1)?.run ?? "", /version-pr\.ts" note "\$PR"$/u);
  });

  it("gets the release scripts of its own template commit, and keeps no credentials in the checkouts", () => {
    const scripts = steps.find((step) => step.name === "Get the release scripts");
    assert.equal(scripts?.with?.["repository"], "${{ job.workflow_repository }}");
    assert.equal(scripts?.with?.["ref"], "${{ job.workflow_sha }}");
    const checkouts = steps.filter((item) => item.uses?.startsWith("actions/checkout@") === true);
    assert.equal(checkouts.length, 2);
    for (const step of checkouts) assert.equal(step.with?.["persist-credentials"], false);
  });
});
