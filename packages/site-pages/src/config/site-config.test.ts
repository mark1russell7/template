// Tests the site config: the one home of the inputs of a site build. The two Pages workflows read .github/site.json
// with it, and a repository with no file keeps its old inputs.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSiteConfigStep } from "./main.ts";
import { fillRepository, resolveSiteConfig, SITE_CONFIG_KEYS, SITE_CONFIG_PATH, type SiteConfig, type SiteConfigInput, type SiteConfigResult } from "./site-config.ts";

const resolve = (over: Partial<SiteConfigInput>): SiteConfigResult =>
  resolveSiteConfig({ file: undefined, path: SITE_CONFIG_PATH, inputs: undefined, repository: "owner/site", ...over });

const config = (result: SiteConfigResult): SiteConfig => {
  if ("error" in result) throw new Error(result.error);
  return result.config;
};

const errorOf = (result: SiteConfigResult): string => {
  if (!("error" in result)) throw new Error("the result is not an error");
  return result.error;
};

describe("the site config of a repository", () => {
  it("gives each key a kind that agrees with the type of its default", () => {
    for (const [key, spec] of Object.entries(SITE_CONFIG_KEYS)) {
      const type = spec.kind === "env" ? "object" : spec.kind;
      expect(typeof spec.default, key).toBe(type);
    }
  });

  it("takes the values of the file, and gives the default of each key that the file does not give", () => {
    const result = resolve({ file: JSON.stringify({ build: "pnpm build", out: "dist", "site-check": true }) });
    expect("source" in result && result.source).toBe("file");
    const got = config(result);
    expect(got).toMatchObject({ build: "pnpm build", "site-check": true, "site-pages": true, "scroll-cue": true, "node-version": "26", env: {} });
    expect(Object.keys(got).sort()).toEqual(Object.keys(SITE_CONFIG_KEYS).sort());
  });

  it("puts the owner and the name of the repository in for {owner} and {repo}", () => {
    expect(fillRepository("https://{owner}.github.io/{repo}/", "mark/vex")).toBe("https://mark.github.io/vex/");
    const got = config(resolve({ file: JSON.stringify({ build: "b", out: "o", env: { SITE_BASE: "/{repo}" }, base: "/{repo}/" }), repository: "mark/vex" }));
    expect(got.env).toEqual({ SITE_BASE: "/vex" });
    expect(got.base).toBe("/vex/");
  });

  it("refuses a key that it does not know, so a typo does not go away with no error", () => {
    expect(errorOf(resolve({ file: JSON.stringify({ build: "b", out: "o", "site-chek": true }) }))).toMatch(/"site-chek" is not a key/);
  });

  it("accepts $schema and $comment", () => {
    expect(config(resolve({ file: JSON.stringify({ $schema: "x", $comment: "y", build: "b", out: "o" }) })).build).toBe("b");
  });

  it("refuses a value of the wrong type", () => {
    expect(errorOf(resolve({ file: JSON.stringify({ build: "b", out: "o", "site-check": "true" }) }))).toMatch(/must be true or false/);
    expect(errorOf(resolve({ file: JSON.stringify({ build: 1, out: "o" }) }))).toMatch(/"build" must be a string/);
    expect(errorOf(resolve({ file: JSON.stringify({ build: "b", out: "o", env: ["A"] }) }))).toMatch(/object of strings/);
    expect(errorOf(resolve({ file: JSON.stringify({ build: "b", out: "o", env: { "A-B": "x" } }) }))).toMatch(/not a name of an environment variable/);
    expect(errorOf(resolve({ file: JSON.stringify({ build: "b", out: "o", env: { A: 1 } }) }))).toMatch(/must be a string/);
  });

  it("refuses a file that is not a JSON object", () => {
    expect(errorOf(resolve({ file: "{" }))).toMatch(/is not JSON/);
    expect(errorOf(resolve({ file: "[]" }))).toMatch(/must be a JSON object/);
  });

  it("needs build and out", () => {
    expect(errorOf(resolve({ file: JSON.stringify({ out: "o" }) }))).toMatch(/gives no "build"/);
    expect(errorOf(resolve({ file: JSON.stringify({ build: "b" }) }))).toMatch(/gives no "out"/);
    expect(errorOf(resolve({ inputs: { build: "", out: "" } }))).toMatch(/the inputs of the workflow gives no "build"/);
  });

  it("refuses a file and the input build together, because each value has one home", () => {
    expect(errorOf(resolve({ file: JSON.stringify({ build: "b", out: "o" }), inputs: { build: "pnpm build" } }))).toMatch(/Give the site values only in/);
    // The default of the input build is empty, so a caller that gives no input build is not refused.
    expect(config(resolve({ file: JSON.stringify({ build: "b", out: "o" }), inputs: { build: "", deploy: true } })).build).toBe("b");
  });

  it("takes the old inputs when the repository has no file, with the env input as a JSON string", () => {
    const result = resolve({ inputs: { build: "pnpm build", out: "dist", env: '{"SITE_BASE": "/site"}', "site-check": true, deploy: true, pending: "head" } });
    expect("source" in result && result.source).toBe("inputs");
    const got = config(result);
    expect(got.env).toEqual({ SITE_BASE: "/site" });
    expect(got["site-check"]).toBe(true);
    // A value of the run, not of the site, is not in the config.
    expect(Object.hasOwn(got, "deploy")).toBe(false);
    expect(errorOf(resolve({ inputs: { build: "b", out: "o", env: "{" } }))).toMatch(/input env is not JSON/);
    expect(config(resolve({ inputs: { build: "b", out: "o", env: "" } })).env).toEqual({});
  });

  it("needs the file when the workflow has no old inputs", () => {
    expect(errorOf(resolve({}))).toMatch(/has no \.github\/site\.json/);
  });
});

describe("the step site-config", () => {
  const step = (files: Record<string, string>, inputs = "") => {
    const folder = mkdtempSync(join(tmpdir(), "site-config-"));
    try {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(folder, path, ".."), { recursive: true });
        writeFileSync(join(folder, path), text);
      }
      const output = join(folder, "output");
      writeFileSync(output, "");
      const lines: string[] = [];
      const code = runSiteConfigStep({ CONFIG_ROOT: folder, CONFIG_PATH: SITE_CONFIG_PATH, INPUTS: inputs, GITHUB_REPOSITORY: "owner/site", GITHUB_OUTPUT: output }, (line) => lines.push(line));
      return { code, lines, output: readFileSync(output, "utf8") };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  };

  it("writes the config as one line of JSON, and the source", () => {
    const { code, output } = step({ [SITE_CONFIG_PATH]: JSON.stringify({ build: "pnpm build\n# two lines", out: "dist" }) });
    expect(code).toBe(0);
    const lines = output.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("source=file");
    expect((JSON.parse((lines[0] ?? "").slice("config=".length)) as SiteConfig).build).toBe("pnpm build\n# two lines");
  });

  it("takes the inputs when the repository has no file", () => {
    const { code, output } = step({}, JSON.stringify({ build: "b", out: "o", env: "{}" }));
    expect(code).toBe(0);
    expect(output).toContain("source=inputs");
  });

  it("fails with an error annotation and writes no output", () => {
    expect(step({})).toMatchObject({ code: 1, output: "", lines: [expect.stringMatching(/^::error::The repository has no \.github\/site\.json/)] });
    expect(step({}, "{")).toMatchObject({ code: 1, output: "", lines: [expect.stringMatching(/^::error::The inputs are not JSON/)] });
  });
});
