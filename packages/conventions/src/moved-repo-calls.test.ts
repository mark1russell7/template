// The rules moved-repo-calls and schedule-literals on fixture repositories: a call of a moved repository (by the table
// of the package and by the option), the fix, a chain of moves, the crons that a workflow compares with
// github.event.schedule, and the warning before the day failsFrom.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, runFix, type RuleResult } from "./index.ts";
import { MOVES, movedTo, parseMove } from "./moves.ts";
import { movedLine, movedRepoCalls, remoteCalls } from "./rules/moved-repo-calls.ts";
import { isCron, scheduleLiterals, workflowCrons } from "./rules/schedule-literals.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-moved-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

/** This function makes a git repository with the files, and gives its root. */
function repository(files: Record<string, string>, manifest = '{ "name": "one" }\n'): string {
  const root = join(temp, String(fixtures++));
  for (const [file, text] of Object.entries({ "package.json": manifest, ...files })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "first"]]) {
    const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return root;
}

function check(root: string, id: string, today: string): RuleResult {
  const result = runChecks({ root, only: [id], today }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

const SHA = "ead65a70bde9f31b9fef4a8cc35cb69289167298";
const CI = [
  "on: push",
  "jobs:",
  "  bytes:",
  `    uses: mark1russell7/vex/.github/workflows/module-bytes.yml@${SHA} # main`,
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - uses: ./.github/actions/local",
  "      - uses: docker://alpine:3",
  `      - uses: Mark1Russell7/Packing/.github/actions/x@${SHA}`,
  "      # - uses: mark1russell7/vex/.github/actions/y@main",
  "",
].join("\n");

describe("the table of moves", () => {
  it("has each name in lower case, one row for each old name, and no row to itself", () => {
    for (const move of MOVES) {
      expect(move.from).toBe(move.from.toLowerCase());
      expect(move.to).toBe(move.to.toLowerCase());
      expect(move.from).not.toBe(move.to);
    }
    expect(new Set(MOVES.map((move) => move.from)).size).toBe(MOVES.length);
  });

  it("reads the option form, follows a chain, stops at a loop, and ignores case", () => {
    expect(parseMove("a/b = c/d")).toEqual({ from: "a/b", to: "c/d" });
    expect(parseMove("a/b")).toBeUndefined();
    const chain = [{ from: "a/x", to: "b/x" }, { from: "b/x", to: "c/x" }];
    expect(movedTo("A/X", chain)).toBe("c/x");
    expect(movedTo("z/x", chain)).toBeUndefined();
    expect(movedTo("a/x", [{ from: "a/x", to: "b/x" }, { from: "b/x", to: "a/x" }])).toBeUndefined();
    expect(movedTo("mark1russell7/vex", MOVES)).toBe("metrograph-labs/vex");
  });
});

describe("the rule moved-repo-calls", () => {
  it("finds each call of another repository, and not a local path, a Docker image or a comment", () => {
    expect(remoteCalls(CI).map((call) => [call.line, call.repo])).toEqual([
      [4, "mark1russell7/vex"],
      [8, "actions/checkout"],
      [11, "Mark1Russell7/Packing"],
    ]);
    expect(movedLine("      - uses: Mark1Russell7/Packing/x@main", "Mark1Russell7/Packing", "metrograph-labs/packing")).toBe("      - uses: metrograph-labs/packing/x@main");
  });

  it("reports each call of a moved repository with the new owner, and the fix writes it with the same ref", () => {
    const root = repository({ ".github/workflows/ci.yml": CI });
    const result = check(root, "moved-repo-calls", movedRepoCalls.failsFrom ?? "");
    expect(result.status).toBe("break");
    expect(result.breaks.map((item) => [item.line, item.message.includes("metrograph-labs/")])).toEqual([
      [4, true],
      [11, true],
    ]);
    runFix({ root, only: ["moved-repo-calls"], today: movedRepoCalls.failsFrom ?? "" });
    const text = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(text).toContain(`uses: metrograph-labs/vex/.github/workflows/module-bytes.yml@${SHA} # main`);
    expect(text).toContain(`uses: metrograph-labs/packing/.github/actions/x@${SHA}`);
    expect(text).toContain("# - uses: mark1russell7/vex/.github/actions/y@main");
    expect(check(root, "moved-repo-calls", movedRepoCalls.failsFrom ?? "").status).toBe("pass");
  });

  it("reads a composite action, takes more moves from the option, and is a warning before its day", () => {
    const action = ["runs:", "  using: composite", "  steps:", "    - uses: someone/tool@v1", ""].join("\n");
    const manifest = JSON.stringify({ name: "one", conventions: { rules: { "moved-repo-calls": { moves: ["someone/tool=else/tool"], reason: "the tool moved" } } } });
    const root = repository({ ".github/actions/a/action.yml": action }, manifest);
    const result = check(root, "moved-repo-calls", movedRepoCalls.failsFrom ?? "");
    expect(result.breaks.map((item) => [item.file, item.line])).toEqual([[".github/actions/a/action.yml", 4]]);
    expect(check(root, "moved-repo-calls", "2026-11-25").status).toBe("warn");
  });
});

describe("the rule schedule-literals", () => {
  const workflow = (crons: string[], body: string[]): string =>
    ["on:", "  schedule:", ...crons.map((cron) => `    - cron: '${cron}'`), "  workflow_dispatch:", "jobs:", "  cells:", "    runs-on: ubuntu-latest", ...body, ""].join("\n");

  it("knows a cron, and reads the schedule, the copies and the read of github.event.schedule", () => {
    expect(isCron("17 3 * * *")).toBe(true);
    expect(isCron("*/15 * * * 1-5")).toBe(true);
    expect(isCron("hello world a b c")).toBe(false);
    expect(isCron("17 3 * *")).toBe(false);
    const crons = workflowCrons(workflow(["17 3 * * *"], ["    if: github.event.schedule == '17  3 * * *'"]));
    expect(crons).toEqual({ schedule: ["17 3 * * *"], literals: [{ line: 8, text: "17  3 * * *" }], readsSchedule: true });
  });

  it("reports an old copy in a case and in if:, and the fix writes the cron of the schedule", () => {
    const body = [
      "    if: github.event.schedule == '7 3 * * *'",
      "    steps:",
      "      - run: |",
      '          case "${{ github.event.schedule }}" in',
      '            "7 3 * * *") echo nightly ;;',
      "          esac",
    ];
    const root = repository({ ".github/workflows/cells.yml": workflow(["23 3 * * *"], body) });
    const result = check(root, "schedule-literals", scheduleLiterals.failsFrom ?? "");
    expect(result.breaks.map((item) => item.line)).toEqual([8, 12]);
    expect(result.breaks[0]?.message).toContain('The cron is "23 3 * * *"');
    runFix({ root, only: ["schedule-literals"], today: scheduleLiterals.failsFrom ?? "" });
    const text = readFileSync(join(root, ".github/workflows/cells.yml"), "utf8");
    expect(text).toContain("if: github.event.schedule == '23 3 * * *'");
    expect(text).toContain('"23 3 * * *") echo nightly');
    expect(check(root, "schedule-literals", scheduleLiterals.failsFrom ?? "").status).toBe("pass");
  });

  it("passes a match and a file that does not read the schedule, and gives no fix when two crons are possible", () => {
    const ok = repository({ ".github/workflows/a.yml": workflow(["17 3 * * *"], ["    if: github.event.schedule == '17 3 * * *'"]) });
    expect(check(ok, "schedule-literals", scheduleLiterals.failsFrom ?? "").status).toBe("pass");
    const other = repository({ ".github/workflows/b.yml": workflow(["17 3 * * *"], ["    env:", "      X: '5 4 * * *'"]) });
    expect(check(other, "schedule-literals", scheduleLiterals.failsFrom ?? "").status).toBe("pass");
    const two = repository({ ".github/workflows/c.yml": workflow(["17 3 * * *", "17 15 * * *"], ["    if: github.event.schedule == '5 3 * * *'"]) });
    const result = check(two, "schedule-literals", scheduleLiterals.failsFrom ?? "");
    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]?.edits ?? []).toHaveLength(0);
  });
});
