// The rule job-fails on fixture repositories: continue-on-error on a job and on a test step, "|| true" after a test,
// a later read of the outcome, and the entries of the option advisory with their day and their reason.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, type RuleResult } from "./index.ts";
import { hiddenFailures, jobFails, parseAdvisory, startsTests, swallowsTests } from "./rules/job-fails.ts";
import { shellCode } from "./workflow.ts";
import { gitFixtures } from "@mark1russell7/rigor-testkit/git-fixture";

const repos = gitFixtures("conventions-job-fails-");
afterAll(() => repos.remove());

const ID = "job-fails";

/** This function makes a git repository with the files and the option advisory, and gives its root. */
function repository(files: Record<string, string>, advisory?: readonly string[]): string {
  const root = repos.folder();
  const conventions = advisory === undefined ? {} : { conventions: { rules: { [ID]: { advisory, reason: "Two browser jobs are advisory for a time." } } } };
  const manifest = `${JSON.stringify({ name: "one", ...conventions }, null, 2)}\n`;
  for (const [file, text] of Object.entries({ "package.json": manifest, ...files })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  repos.stageAll(root);
  return root;
}

/** The check on the day that the rule fails from, so a break is a break and not a warning. */
function check(root: string, today = jobFails.failsFrom ?? ""): RuleResult {
  const result = runChecks({ root, only: [ID], today }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

/** A workflow with the jobs. Each job is a list of lines under its id. */
const workflow = (jobs: Record<string, readonly string[]>): string =>
  ["on: push", "jobs:", ...Object.entries(jobs).flatMap(([id, lines]) => [`  ${id}:`, "    runs-on: ubuntu-latest", ...lines]), ""].join("\n");

describe("the rule job-fails", () => {
  it("knows the commands that start tests, and not a word in a quote, a comment or an install", () => {
    for (const line of ["pnpm test", "pnpm -r --if-present run test", "npm run check:types", "pnpm --filter @lag/site exec playwright test", "npx vitest run", "node --experimental-strip-types --test", "yarn e2e"]) {
      expect(startsTests(line), line).toBe(true);
    }
    for (const line of ["pnpm install --frozen-lockfile", 'echo "pnpm test"', "pnpm build # then pnpm test", "npm run check-types", "pnpm run testing"]) {
      expect(startsTests(line), line).toBe(false);
    }
  });

  it("reads a line with each quote as an empty quote and with no comment, in one pass", () => {
    expect(shellCode('echo "pnpm test" && pnpm build # then pnpm test')).toBe('echo "" && pnpm build');
    expect(shellCode(`echo 'a b' "c \\" d" e`)).toBe('echo "" "" e');
    expect(shellCode("echo \"it's\" 'x'")).toBe('echo "" ""');
    expect(shellCode("a#b c")).toBe("a#b c");
    // A quote that does not close stays as it is, and a later quote of the other kind still closes.
    expect(shellCode(`echo "abc 'x'`)).toBe('echo "abc ""');
    expect(shellCode("echo 'abc \"x\"")).toBe("echo 'abc \"\"");
    expect(shellCode('echo "a\\')).toBe('echo "a\\');
    // CodeQL js/polynomial-redos: many \" with no closing quote. The old regular expression read this line again from each ".
    const long = `"${'\\"'.repeat(200_000)}`;
    const started = performance.now();
    expect(shellCode(long)).toBe(long);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("finds a || after a test that does not fail, and not one that fails or one before the test", () => {
    for (const line of ["pnpm test || true", "pnpm test || :", "npx vitest run || echo failed", "pnpm check || exit 0"]) expect(swallowsTests(line), line).toBe(true);
    for (const line of ["pnpm test || exit 1", "pnpm test || (cat log.txt; false)", "test -f a || pnpm test", "pnpm test || true # no, see below", "pnpm install || true"]) {
      expect(swallowsTests(line), line).toBe(line.startsWith("pnpm test || true"));
    }
  });

  it("finds continue-on-error on a job and on a test step, and || true after a test, with the lines", () => {
    const text = workflow({
      safari: ["    continue-on-error: true", "    steps:", "      - run: pnpm build"],
      matrix: ["    continue-on-error: ${{ matrix.experimental }}", "    steps:", "      - run: pnpm build"],
      strict: ["    continue-on-error: false", "    steps:", "      - name: Tests", "        continue-on-error: true", "        run: |", "          pnpm build", "          pnpm test"],
      swallow: ["    steps:", "      - run: pnpm test || true"],
    });
    expect(hiddenFailures(text)).toEqual([
      { job: "safari", line: 5, kind: "job", value: "true" },
      { job: "matrix", line: 10, kind: "job", value: "${{ matrix.experimental }}" },
      { job: "strict", line: 18, kind: "step", value: "true" },
      { job: "swallow", line: 25, kind: "or", value: "pnpm test || true" },
    ]);
  });

  it("passes a best-effort step that starts no tests, a test step whose outcome a later step reads, and a comment", () => {
    const text = workflow({
      pages: [
        "    steps:",
        "      - name: IndexNow",
        "        continue-on-error: true",
        "        run: node ping.ts",
        "      - id: tests",
        "        continue-on-error: true",
        "        run: pnpm test",
        "      - if: steps.tests.outcome == 'failure'",
        "        run: echo '::warning::The tests failed.'",
        "    # continue-on-error: true",
      ],
    });
    expect(hiddenFailures(text)).toEqual([]);
  });

  it("fails on a hidden failure in a workflow, and warns before its day failsFrom", () => {
    const root = repository({ ".github/workflows/ci.yml": workflow({ safari: ["    continue-on-error: true", "    steps:", "      - run: pnpm test"] }) });
    const result = check(root);
    expect(result.status).toBe("break");
    expect(result.breaks.map((each) => [each.file, each.line])).toEqual([[".github/workflows/ci.yml", 5]]);
    expect(result.breaks[0]?.message).toContain("needs.safari.result is success");
    expect(check(root, "2026-12-06").status).toBe("warn");
  });

  it("reads each entry of the option advisory: it covers its job until its day, and then fails", () => {
    expect(parseAdvisory("ci.yml#safari until 2027-01-31: Safari on the runners fails at random.")).toEqual({
      file: "ci.yml",
      job: "safari",
      until: "2027-01-31",
      reason: "Safari on the runners fails at random.",
    });
    expect(parseAdvisory("ci.yml#safari: no day")).toBeUndefined();
    expect(parseAdvisory("ci.yml#safari until 2027-01-31:")).toBeUndefined();
    const files = { ".github/workflows/ci.yml": workflow({ safari: ["    continue-on-error: true", "    steps:", "      - run: pnpm test"], ios: ["    steps:", "      - run: pnpm test"] }) };
    const entry = "ci.yml#safari until 2027-01-31: Safari on the runners fails at random.";
    const covered = repository(files, [entry]);
    expect(check(covered).status).toBe("pass");
    const ended = check(covered, "2027-02-01");
    expect(ended.breaks.map((each) => [each.file, each.line])).toEqual([
      ["package.json", 7],
      [".github/workflows/ci.yml", 5],
    ]);
    expect(ended.breaks[0]?.message).toContain("ended on 2027-01-31");
  });

  it("fails on an entry of another form, and on an entry with no hidden failure", () => {
    const files = { ".github/workflows/ci.yml": workflow({ ios: ["    steps:", "      - run: pnpm test"] }) };
    const result = check(repository(files, ["ci.yml#safari: no day", "ci.yml#ios until 2027-01-31: The simulator fails at random."]));
    expect(result.breaks.map((each) => each.message.slice(0, 40))).toEqual(['The entry "ci.yml#safari: no day" of the', "The exception ci.yml#ios of the option a"]);
  });
});
