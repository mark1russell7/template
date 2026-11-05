// The rule pipe-fails on fixture repositories: the forms of a pipe, the three places of a shell, the fix and its second run.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, runFix, type RuleResult } from "./index.ts";
import { hasPipe, hidesFailure } from "./rules/pipe-fails.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-pipe-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

const ID = "pipe-fails";
const FILE = ".github/workflows/measure.yml";

/** This function gives a workflow with the lines of one job, and with the lines before the key `jobs`. */
const workflow = (job: readonly string[], top: readonly string[] = []): string => ["on: push", ...top, "jobs:", "  a:", "    runs-on: ubuntu-latest", ...job.map((line) => `    ${line}`), ""].join("\n");

/** This function makes a git repository with the workflow, and gives its root. */
function repository(text: string): string {
  const root = join(temp, String(fixtures++));
  mkdirSync(dirname(join(root, FILE)), { recursive: true });
  writeFileSync(join(root, "package.json"), '{ "name": "one" }\n');
  writeFileSync(join(root, FILE), text);
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "first"]]) {
    const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return root;
}

function check(root: string): RuleResult {
  const result = runChecks({ root, only: [ID] }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

const SCRIPT = ["steps:", "  - name: The measure", "    run: |", "      tests | tee out.txt", "      grep MEASURE out.txt"];

describe("the rule pipe-fails", () => {
  it("finds a pipe, and not the text of quotes, comments and here-documents", () => {
    for (const script of ["tests | tee out.txt", "a |& b", "a 'x' | b", "v=$(a | b)"]) expect(hasPipe(script), script).toBe(true);
    for (const script of ["a || b", "grep -E 'a|b' file", 'echo "a|b"', "echo a # b | c", "cat <<'EOF'\n| a | b |\nEOF\necho done", "echo \\| a"]) expect(hasPipe(script), script).toBe(false);
    expect(hasPipe("cat <<EOF\n| a |\nEOF\na | b")).toBe(true);
  });

  it("knows which shells hide a failure", () => {
    expect([undefined, "sh", "bash -e {0}", "bash {0}"].map(hidesFailure)).toEqual([true, true, true, true]);
    expect(["bash", "bash -eo pipefail {0}", "pwsh", "python"].map(hidesFailure)).toEqual([false, false, false, false]);
  });

  it("fails on a step with a pipe and no shell, and the fix passes on its second run", () => {
    const root = repository(workflow(SCRIPT));
    const before = check(root).breaks;
    expect(before.map((each) => [each.file, each.line])).toEqual([[FILE, 7]]);
    expect(runFix({ root, only: [ID] }).changed).toEqual([FILE]);
    expect(readFileSync(join(root, FILE), "utf8")).toContain("defaults:\n  run:\n    shell: bash\n\njobs:");
    expect(check(root).breaks).toEqual([]);
    expect(runFix({ root, only: [ID] }).changed).toEqual([]);
  });

  it("passes with a shell on the step, on the job or on the workflow, and with pipefail in the script", () => {
    const cases = [
      workflow(["steps:", "  - run: a | b", "    shell: bash"]),
      workflow(["steps:", "  - shell: bash", "    run: a | b"]),
      workflow(["defaults:", "  run:", "    shell: bash", "steps:", "  - run: a | b"]),
      workflow(["steps:", "  - run: a | b"], ["defaults:", "  run:", "    shell: bash"]),
      workflow(["steps:", "  - run: |", "      set -o pipefail", "      a | b"]),
      workflow(["steps:", "  - run: a | b", "    shell: pwsh"]),
      workflow(["steps:", "  - run: a || b", "  - uses: actions/checkout@v4"]),
    ];
    for (const text of cases) expect(check(repository(text)).breaks, text).toEqual([]);
  });

  it("reads each step of each job, and a list at the indent of its key", () => {
    const text = ["on: push", "jobs:", "  a:", "    steps:", "    - run: a | b", "    - run: c", "  b:", "    steps:", "      - run: d", "      - run: e | f", ""].join("\n");
    expect(check(repository(text)).breaks.map((each) => each.line)).toEqual([5, 10]);
  });

  it("does not write a fix over another shell of the workflow", () => {
    const root = repository(workflow(["steps:", "  - run: a | b"], ["defaults:", "  run:", "    shell: sh"]));
    expect(check(root).breaks).toHaveLength(1);
    expect(runFix({ root, only: [ID] }).changed).toEqual([]);
  });
});
