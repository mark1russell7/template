/**
 * The rule `coverage-provider` on fixture repositories, and the coverage inputs of a caller of the shared CI.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, runFix, type RuleResult } from "./index.ts";
import { coverageInputs } from "./rules/coverage-provider.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-coverage-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let count = 0;

/** A `ci.yml` that calls the shared CI at a pin, with the inputs `with`. */
const ci = (inputs: Record<string, string> = {}): string =>
  [
    "name: CI",
    "on: [push, pull_request]",
    "jobs:",
    "  ci:",
    "    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@0123456789abcdef0123456789abcdef01234567 # main",
    ...(Object.keys(inputs).length > 0 ? ["    with:", ...Object.entries(inputs).map(([key, value]) => `      ${key}: ${value}`)] : []),
    "",
  ].join("\n");

/** The text of a `package.json` as `JSON.stringify` writes it with 2 spaces. */
const manifest = (fields: Record<string, unknown>): string => `${JSON.stringify({ name: "@x/lib", version: "1.0.0", ...fields }, null, 2)}\n`;

const TESTED = { scripts: { test: "vitest run" } };

/** This function writes a repository and gives its root. A value that is not a text is written as JSON. */
function repo(files: Record<string, unknown>): string {
  const root = join(temp, String(count++));
  for (const [file, value] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
  return root;
}

function check(root: string): RuleResult {
  // No event file: the rule does not know if the repository is public, so it takes the coverage on main as on
  const result = runChecks({ root, only: ["coverage-provider"], today: "2026-12-01", env: {} }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

describe("coverageInputs", () => {
  it("reads the inputs of each job that calls the shared CI, and skips the other jobs", () => {
    const text = [
      "jobs:",
      "  ci:",
      "    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@abc",
      "    with:",
      '      coverage: "true"',
      "      coverage-on-main: false # off",
      "  local:",
      "    uses: ./.github/workflows/reusable-ci.yml",
      "  other:",
      "    uses: mark1russell7/template/.github/workflows/reusable-pages.yml@abc",
      "",
    ].join("\n");
    expect(coverageInputs(text)).toEqual([
      { coverage: "true", onMain: "false" },
      { coverage: "", onMain: "" },
    ]);
  });
});

describe("coverage-provider", () => {
  it("breaks on a package with Vitest tests and no provider, and fix adds the provider at the range of vitest", () => {
    const deps = { devDependencies: { typescript: "^6.0.0", vitest: "^5.1.0" } };
    const root = repo({ ".github/workflows/ci.yml": ci(), "package.json": manifest({ ...TESTED, ...deps }) });
    const result = check(root);
    expect(result.status).toBe("break");
    expect(result.breaks.map((item) => [item.file, item.line, item.message])).toEqual([
      ["package.json", 9, "@x/lib starts Vitest in its test script, and no manifest gives it @vitest/coverage-v8. The action coverage of the shared CI skips it."],
    ]);
    runFix({ root, only: ["coverage-provider"] });
    const fixed = { devDependencies: { "@vitest/coverage-v8": "^5.1.0", typescript: "^6.0.0", vitest: "^5.1.0" } };
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(manifest({ ...TESTED, ...fixed }));
    expect(check(root).status).toBe("pass");
  });

  it("breaks on a provider at another range than vitest, and fix sets the range of vitest", () => {
    const root = repo({
      ".github/workflows/ci.yml": ci(),
      "package.json": manifest({ ...TESTED, devDependencies: { "@vitest/coverage-v8": "^4.0.0", vitest: "^5.1.0" } }),
    });
    expect(check(root).breaks.map((item) => item.message)).toEqual(["@vitest/coverage-v8 has the range ^4.0.0 in package.json, and vitest has ^5.1.0. The provider must have the range of Vitest."]);
    runFix({ root, only: ["coverage-provider"] });
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(manifest({ ...TESTED, devDependencies: { "@vitest/coverage-v8": "^5.1.0", vitest: "^5.1.0" } }));
  });

  it("takes vitest and the provider of the root for the packages of a workspace, and gives one break for each manifest", () => {
    const files = {
      ".github/workflows/ci.yml": ci(),
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/a/package.json": manifest({ name: "@x/a", ...TESTED }),
      "packages/b/package.json": manifest({ name: "@x/b", ...TESTED }),
      "packages/c/package.json": manifest({ name: "@x/c", scripts: { test: "node --test" } }),
    };
    const shared = repo({ ...files, "package.json": manifest({ name: "root", private: true, devDependencies: { vitest: "^5.1.0" } }) });
    expect(check(shared).breaks.map((item) => item.file)).toEqual(["package.json"]);
    const both = repo({ ...files, "package.json": manifest({ name: "root", private: true, devDependencies: { "@vitest/coverage-v8": "^5.1.0", vitest: "^5.1.0" } }) });
    expect(check(both).status).toBe("pass");
    // A package with its own vitest gets the provider in its own manifest
    const own = repo({ ...files, "package.json": manifest({ name: "root", private: true }), "packages/a/package.json": manifest({ name: "@x/a", ...TESTED, devDependencies: { vitest: "^5.1.0" } }) });
    expect(check(own).breaks.map((item) => item.file)).toEqual(["packages/a/package.json"]);
  });

  it("gives a text fix and no edit for a catalog range, which needs an entry of the catalog too", () => {
    const root = repo({ ".github/workflows/ci.yml": ci(), "package.json": manifest({ ...TESTED, devDependencies: { vitest: "catalog:" } }) });
    const [item] = check(root).breaks;
    expect(item?.edits).toBeUndefined();
    expect(item?.fix).toBe('Add "@vitest/coverage-v8": "catalog:" to devDependencies of package.json.');
  });

  it("skips a repository whose shared CI does not start the action coverage, or that does not call the shared CI", () => {
    const pkg = manifest({ ...TESTED, devDependencies: { vitest: "^5.1.0" } });
    expect(check(repo({ ".github/workflows/ci.yml": ci({ "coverage-on-main": "false" }), "package.json": pkg })).status).toBe("skipped");
    expect(check(repo({ "package.json": pkg })).status).toBe("skipped");
    expect(check(repo({ ".github/workflows/ci.yml": ci({ coverage: "true", "coverage-on-main": "false" }), "package.json": pkg })).status).toBe("break");
  });

  it("is a warning before its day failsFrom", () => {
    const root = repo({ ".github/workflows/ci.yml": ci(), "package.json": manifest({ ...TESTED, devDependencies: { vitest: "^5.1.0" } }) });
    const result = runChecks({ root, only: ["coverage-provider"], today: "2026-11-20", env: {} }).rules[0];
    expect(result?.status).toBe("warn");
  });
});
