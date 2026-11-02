// Tests match.jq of the action "changes" and summary.jq of the action "gate-summary", with jq. The runners of GitHub
// have jq. A computer with no jq skips these tests, but CI does not.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

const here = import.meta.dirname;
const hasJq = spawnSync("jq", ["--version"]).status === 0;
const skip = !hasJq && process.env["CI"] === undefined ? "jq is not installed" : false;

/** This function starts jq with the arguments `args` and the input `input`, and gives its output. */
function jq(args: readonly string[], input: string): string {
  const result = spawnSync("jq", args, { input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const match = (files: readonly string[], paths: string, ignore = ""): string =>
  jq(["-R", "-s", "-r", "--arg", "paths", paths, "--arg", "ignore", ignore, "-f", join(here, "changes", "match.jq")], files.join("\n"));

const verdict = (needs: Record<string, unknown>, allow = ""): string =>
  jq(["-r", "--arg", "changes", "changes", "--arg", "allow", allow, "-f", join(here, "gate-summary", "summary.jq")], JSON.stringify(needs));

const failed = (out: string): boolean => out.split("\n").some((line) => line.startsWith("FAIL"));

describe("changes: the patterns of on.pull_request.paths", { skip }, () => {
  const cases: [boolean, string[], string, string?][] = [
    [true, ["packages/core/src/a.ts"], "packages/core/src/**"],
    [false, ["packages/core/README.md"], "packages/core/src/**"],
    [true, ["pilots/src/ireko-x.ts"], "pilots/src/ireko-*.ts"],
    [false, ["pilots/src/sub/ireko-x.ts"], "pilots/src/ireko-*.ts"],
    [true, ["a.js"], "*.js"],
    [false, ["lib/a.js"], "*.js"],
    [true, ["lib/deep/a.js"], "**.js"],
    [true, ["src/a.ts"], "**/*.ts"],
    [true, ["a.ts"], "**/*.ts"],
    [true, ["corpus/a(1)+b.json"], "corpus/**"],
    [false, ["x.yml"], ".github/workflows/x.yml"],
    [true, [".github/workflows/x.yml"], "  .github/workflows/x.yml  \n# a comment"],
    [false, ["src/a.test.ts"], "src/**\n!src/**/*.test.ts"],
    [true, ["src/a.test.ts", "src/b.ts"], "src/**\n!src/**/*.test.ts"],
    [true, ["src/a.test.ts"], "src/**\n!src/**/*.test.ts\nsrc/a.test.ts"],
    [false, ["docs/x.md"], "**", "docs/**"],
    [true, ["docs/x.md", "src/y.ts"], "**", "docs/**"],
    [false, ["packagesX/core/src/a.ts"], "packages/core/src/**"],
    [false, [], "**"],
  ];
  for (const [want, files, paths, ignore] of cases) {
    it(`${String(want)}: ${files.join(",")} | ${paths.replaceAll("\n", " ")} | ${ignore ?? ""}`, () => {
      assert.equal(match(files, paths, ignore), String(want));
    });
  }
});

describe("gate-summary: the verdict of the jobs", { skip }, () => {
  const job = (result: string): unknown => ({ result, outputs: {} });
  const changes = (value?: string): unknown => ({ result: "success", outputs: value === undefined ? {} : { match: value } });
  const cases: [boolean, Record<string, unknown>, string?][] = [
    [true, { changes: changes("true"), gate: job("success") }],
    [false, { changes: changes("true"), gate: job("failure") }],
    [false, { changes: changes("true"), gate: job("cancelled") }],
    [false, { changes: changes("true"), gate: job("skipped") }],
    [true, { changes: changes("true"), gate: job("skipped") }, "gate"],
    [true, { changes: changes("false"), gate: job("skipped") }],
    [false, { changes: changes("false"), gate: job("failure") }],
    [false, { changes: job("failure"), gate: job("skipped") }],
    [false, { changes: changes(), gate: job("skipped") }],
    [false, { gate: job("skipped") }],
    [true, { gate: job("success") }],
    [false, {}],
  ];
  for (const [pass, needs, allow] of cases) {
    it(`${pass ? "passes" : "fails"}: ${JSON.stringify(needs)}${allow === undefined ? "" : ` allow ${allow}`}`, () => {
      assert.equal(failed(verdict(needs, allow)), !pass);
    });
  }
});
