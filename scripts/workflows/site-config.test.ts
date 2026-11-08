// Tests that the site config and the Pages workflows agree: each key of the site config is an input of
// reusable-pages.yml with the same default, so a caller with no .github/site.json keeps its site. The deploy
// (reusable-pages.yml) and the check of a pull request (reusable-pages-check.yml) build the site with the same two
// actions, so a pull request checks the site that main deploys. Start the tests with "pnpm test:workflows".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveSiteConfig, SITE_CONFIG_KEYS, SITE_CONFIG_PATH } from "../../packages/site-pages/src/config/site-config.ts";

const root = join(import.meta.dirname, "..", "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
const pages = read(".github/workflows/reusable-pages.yml");
const check = read(".github/workflows/reusable-pages-check.yml");
const build = read(".github/actions/pages-build/action.yml");

/** This function gives the default of one input of a workflow file, or undefined when the input has no default. */
function defaultOf(workflow: string, key: string): unknown {
  const block = new RegExp(`\\n      ${key}:\\n((?:        .*\\n)*)`).exec(workflow);
  if (block === null) return undefined;
  const line = /^        default: (.*)$/m.exec(block[1] ?? "");
  if (line === null) return undefined;
  const text = (line[1] ?? "").trim();
  if (text === "true") return true;
  if (text === "false") return false;
  return text.startsWith('"') ? (JSON.parse(text) as string) : text;
}

/** The text of a job of a workflow, from its key to the key of the next job. */
function jobText(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `The workflow has the job ${name}.`);
  const next = /\n  [a-z-]+:\n/g;
  next.lastIndex = start + 1;
  return workflow.slice(start, next.exec(workflow)?.index ?? workflow.length);
}

/** The steps of a job from the checkout of the shared actions to its end, with no comment lines. */
function sharedSteps(job: string): string {
  const start = job.indexOf("      - name: Shared actions (the site config, site-pages and the site check)\n");
  assert.ok(start >= 0, "The job checks out the shared actions.");
  return job
    .slice(start)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .trimEnd();
}

describe("the site config and reusable-pages.yml", () => {
  it("gives each key of the site config the default of the input of the same name", () => {
    for (const [key, spec] of Object.entries(SITE_CONFIG_KEYS)) {
      const value = defaultOf(pages, key);
      assert.notEqual(value, undefined, `reusable-pages.yml has the input ${key} with a default`);
      assert.deepEqual(key === "env" ? (JSON.parse(value as string) as unknown) : value, spec.default, `the default of ${key}`);
    }
  });

  it("reads no site input in the job build, because the action site-config gives each value", () => {
    const job = jobText(pages, "build");
    for (const key of Object.keys(SITE_CONFIG_KEYS)) assert.doesNotMatch(job, new RegExp(`inputs\\.${key}\\b(?!-)`), `the job build reads inputs.${key}`);
    assert.ok(job.includes("          inputs: ${{ toJSON(inputs) }}\n"), "site-config gets the inputs of the workflow");
  });
});

describe("the action pages-build", () => {
  it("reads each key of the site config, so a key cannot be in the file and do nothing", () => {
    for (const key of Object.keys(SITE_CONFIG_KEYS)) {
      const read = build.includes(`fromJSON(inputs.config).${key} `) || build.includes(`fromJSON(inputs.config).${key})`) || build.includes(`fromJSON(inputs.config)['${key}']`);
      assert.ok(read, `pages-build reads the key ${key}`);
    }
  });
});

describe("reusable-pages-check.yml", () => {
  it("builds the site with the same shared checkout and the same two actions as the deploy", () => {
    const deploy = sharedSteps(jobText(pages, "build"));
    const pr = sharedSteps(jobText(check, "site"));
    // The deploy also gives the old inputs to site-config. The check reads only the file.
    assert.equal(pr, deploy.replace("          inputs: ${{ toJSON(inputs) }}\n", ""));
  });

  it("gets only contents: read, because a called workflow cannot get more than the CI job of a pull request", () => {
    assert.doesNotMatch(check, /^permissions:/m, "The workflow has no top-level permissions.");
    const job = jobText(check, "site");
    assert.ok(job.includes("\n    permissions:\n      contents: read\n    steps:\n"), "The job has only contents: read.");
    assert.doesNotMatch(check, /: write\b/);
    assert.doesNotMatch(check, /deploy-pages|environment:/);
  });
});

describe("the site of the template", () => {
  const ci = read(".github/workflows/ci.yml");

  it("has a site config that resolves", () => {
    const result = resolveSiteConfig({ file: read(SITE_CONFIG_PATH), path: SITE_CONFIG_PATH, inputs: undefined, repository: "mark1russell7/template" });
    assert.ok(!("error" in result), "error" in result ? result.error : "");
    assert.equal(result.config.env["SITE_BASE"], "/template");
    assert.equal(result.config["site-check"], true);
  });

  it("deploys from pages.yml with no site input, and checks each pull request in the job site of ci.yml", () => {
    assert.doesNotMatch(read(".github/workflows/pages.yml"), /\n    with:\n/);
    assert.ok(jobText(ci, "site").includes("\n    uses: ./.github/workflows/reusable-pages-check.yml\n"));
    assert.match(jobText(ci, "ci-ok"), /\n    needs: \[[^\]]*\bsite\b[^\]]*\]\n/);
    assert.doesNotMatch(jobText(ci, "ci-ok"), /ALLOW_SKIP: "[^"]*\bsite\b/);
  });
});
