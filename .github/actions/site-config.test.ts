// Tests config.ts of the action site-config: the one home of the inputs of a site build. The two Pages workflows read
// .github/site.json with it, and a repository with no file keeps its old inputs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fill, resolveConfig, SITE_KEYS, type ConfigInput, type ConfigResult } from "./site-config/config.ts";

const script = join(import.meta.dirname, "site-config", "config.ts");
const PATH = ".github/site.json";

const resolve = (over: Partial<ConfigInput>): ConfigResult =>
  resolveConfig({ file: undefined, path: PATH, inputs: undefined, repository: "owner/site", ...over });

const config = (result: ConfigResult) => {
  if ("error" in result) throw new Error(result.error);
  return result.config;
};

const errorOf = (result: ConfigResult): string => {
  assert.ok("error" in result, "the result is an error");
  return result.error;
};

describe("the site config of a repository", () => {
  it("takes the values of the file, and gives the default of each key that the file does not give", () => {
    const result = resolve({ file: JSON.stringify({ build: "pnpm build", out: "dist", "site-check": true }) });
    assert.equal("source" in result && result.source, "file");
    const got = config(result);
    assert.equal(got.build, "pnpm build");
    assert.equal(got["site-check"], true);
    assert.equal(got["site-pages"], true);
    assert.equal(got["scroll-cue"], true);
    assert.equal(got["node-version"], "26");
    assert.deepEqual(got.env, {});
    assert.deepEqual(Object.keys(got).sort(), Object.keys(SITE_KEYS).sort());
  });

  it("puts the owner and the name of the repository in for {owner} and {repo}", () => {
    assert.equal(fill("https://{owner}.github.io/{repo}/", "mark/vex"), "https://mark.github.io/vex/");
    const got = config(resolve({ file: JSON.stringify({ build: "b", out: "o", env: { SITE_BASE: "/{repo}" }, base: "/{repo}/" }), repository: "mark/vex" }));
    assert.deepEqual(got.env, { SITE_BASE: "/vex" });
    assert.equal(got.base, "/vex/");
  });

  it("refuses a key that it does not know, so a typo does not go away with no error", () => {
    assert.match(errorOf(resolve({ file: JSON.stringify({ build: "b", out: "o", "site-chek": true }) })), /"site-chek" is not a key/);
  });

  it("accepts $schema and $comment", () => {
    config(resolve({ file: JSON.stringify({ $schema: "x", $comment: "y", build: "b", out: "o" }) }));
  });

  it("refuses a value of the wrong type", () => {
    assert.match(errorOf(resolve({ file: JSON.stringify({ build: "b", out: "o", "site-check": "true" }) })), /must be true or false/);
    assert.match(errorOf(resolve({ file: JSON.stringify({ build: 1, out: "o" }) })), /"build" must be a string/);
    assert.match(errorOf(resolve({ file: JSON.stringify({ build: "b", out: "o", env: ["A"] }) })), /object of strings/);
    assert.match(errorOf(resolve({ file: JSON.stringify({ build: "b", out: "o", env: { "A-B": "x" } }) })), /not a name of an environment variable/);
    assert.match(errorOf(resolve({ file: JSON.stringify({ build: "b", out: "o", env: { A: 1 } }) })), /must be a string/);
  });

  it("refuses a file that is not a JSON object", () => {
    assert.match(errorOf(resolve({ file: "{" })), /is not JSON/);
    assert.match(errorOf(resolve({ file: "[]" })), /must be a JSON object/);
  });

  it("needs build and out", () => {
    assert.match(errorOf(resolve({ file: JSON.stringify({ out: "o" }) })), /gives no "build"/);
    assert.match(errorOf(resolve({ file: JSON.stringify({ build: "b" }) })), /gives no "out"/);
  });

  it("refuses a file and the input build together, because each value has one home", () => {
    assert.match(errorOf(resolve({ file: JSON.stringify({ build: "b", out: "o" }), inputs: { build: "pnpm build" } })), /Give the site values only in/);
    // The default of the input build is empty, so a caller that gives no input build is not refused.
    config(resolve({ file: JSON.stringify({ build: "b", out: "o" }), inputs: { build: "", deploy: true } }));
  });

  it("takes the old inputs when the repository has no file, with the env input as a JSON string", () => {
    const result = resolve({
      inputs: { build: "pnpm build", out: "dist", env: '{"SITE_BASE": "/site"}', "site-check": true, deploy: true, pending: "head" },
    });
    assert.equal("source" in result && result.source, "inputs");
    const got = config(result);
    assert.deepEqual(got.env, { SITE_BASE: "/site" });
    assert.equal(got["site-check"], true);
    assert.equal(Object.hasOwn(got, "deploy"), false, "a value of the run, not of the site, is not in the config");
    assert.match(errorOf(resolve({ inputs: { build: "b", out: "o", env: "{" } })), /input env is not JSON/);
  });

  it("needs the file when the workflow has no old inputs", () => {
    assert.match(errorOf(resolve({})), /has no \.github\/site\.json/);
  });

  it("gives the default of each key as the default of the input of reusable-pages.yml", () => {
    const workflow = readFileSync(join(import.meta.dirname, "..", "workflows", "reusable-pages.yml"), "utf8");
    for (const [key, spec] of Object.entries(SITE_KEYS)) {
      const block = new RegExp(`\\n      ${key}:\\n(?:        .*\\n)*?        default: (.*)\\n`).exec(workflow);
      assert.ok(block, `reusable-pages.yml has the input ${key} with a default`);
      const text = (block[1] ?? "").trim();
      const value = text.startsWith('"') ? (JSON.parse(text) as string) : text === "true" ? true : text === "false" ? false : text;
      assert.deepEqual(key === "env" ? JSON.parse(value as string) : value, spec.default, `the default of ${key}`);
    }
  });
});

describe("the step site-config", () => {
  it("writes the config as one line of JSON to GITHUB_OUTPUT", () => {
    const folder = mkdtempSync(join(tmpdir(), "site-config-"));
    try {
      mkdirSync(join(folder, ".github"));
      writeFileSync(join(folder, PATH), JSON.stringify({ build: "pnpm build\n# two lines", out: "dist" }));
      const output = join(folder, "output");
      writeFileSync(output, "");
      const run = spawnSync(process.execPath, [script], {
        env: { ...process.env, CONFIG_ROOT: folder, CONFIG_PATH: PATH, INPUTS: "", GITHUB_REPOSITORY: "owner/site", GITHUB_OUTPUT: output },
        encoding: "utf8",
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const lines = readFileSync(output, "utf8").trimEnd().split("\n");
      assert.equal(lines.length, 2);
      assert.equal(lines[1], "source=file");
      const got = JSON.parse((lines[0] ?? "").slice("config=".length)) as { build: string };
      assert.equal(got.build, "pnpm build\n# two lines");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("fails with an error annotation and writes no output", () => {
    const folder = mkdtempSync(join(tmpdir(), "site-config-"));
    try {
      const output = join(folder, "output");
      writeFileSync(output, "");
      const run = spawnSync(process.execPath, [script], {
        env: { ...process.env, CONFIG_ROOT: folder, CONFIG_PATH: PATH, INPUTS: "", GITHUB_REPOSITORY: "owner/site", GITHUB_OUTPUT: output },
        encoding: "utf8",
      });
      assert.equal(run.status, 1);
      assert.match(run.stdout, /::error::The repository has no \.github\/site\.json/);
      assert.equal(readFileSync(output, "utf8"), "");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
