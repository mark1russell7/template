import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startsReport } from "./process-starts.global.ts";
import { commandName, gitBudgetBreak, gitStartsIn, lineCommandName, parseGitBudgets, startKey } from "./process-starts.ts";

describe("the count of process starts", () => {
  it("names a command file by its name, with no folder and no extension", () => {
    expect(commandName("git")).toBe("git");
    expect(commandName("C:\\Program Files\\Git\\cmd\\git.exe")).toBe("git");
    expect(commandName("/usr/bin/git")).toBe("git");
    expect(commandName("pnpm.CMD")).toBe("pnpm");
    expect(commandName(process.execPath)).toBe("node");
    expect(commandName(undefined)).toBe("unknown");
  });

  it("names the command of a command line by its first word, or its first part in quotes", () => {
    expect(lineCommandName("pnpm install --frozen-lockfile")).toBe("pnpm");
    expect(lineCommandName('"C:\\Program Files\\GitHub CLI\\gh.exe" pr view')).toBe("gh");
    expect(lineCommandName("  git status")).toBe("git");
    expect(lineCommandName(42)).toBe("unknown");
  });

  it("counts a git start under its command, and sums each key of git", () => {
    expect(startKey("git", ["-c", "user.name=test", "-C", "a", "ls-files", "-z"])).toBe("git-ls-files");
    expect(startKey("git", "ls-files")).toBe("git");
    expect(startKey("git", ["--version"])).toBe("git");
    expect(startKey("node", ["-e", "1"])).toBe("node");
    expect(gitStartsIn(new Map([["git", 2], ["git-commit", 3], ["gh", 4]]))).toBe(5);
  });

  it("reports the files with the most starts first, and a line of the sums", () => {
    const lines = startsReport([
      { file: "src/a.test.ts", counts: { git: 3 } },
      { file: "src/b.test.ts", counts: { git: 10, node: 2 } },
      { file: "src/c.test.ts", counts: {} },
    ]);
    expect(lines).toEqual([
      "process-starts 12 src/b.test.ts git=10 node=2",
      "process-starts 3 src/a.test.ts git=3",
      "process-starts 0 src/c.test.ts ",
      "process-starts 15 (all 3 files) git=13 node=2",
    ]);
  });
});

describe("the git-start budgets", () => {
  const budgets = parseGitBudgets(JSON.stringify({ default: 2, files: { "src/a.test.ts": 4 } }));

  it("holds a file under its own budget, and each other file under the default", () => {
    expect(gitBudgetBreak("src/a.test.ts", new Map([["git-add", 2], ["git-commit", 2]]), budgets)).toBeUndefined();
    expect(gitBudgetBreak("src/a.test.ts", new Map([["git-add", 5], ["node", 9]]), budgets)).toContain("src/a.test.ts started git 5 times, over its budget of 4 ");
    expect(gitBudgetBreak("src/b.test.ts", new Map([["git", 2], ["node", 9]]), budgets)).toBeUndefined();
    expect(gitBudgetBreak("src/b.test.ts", new Map([["git", 3]]), budgets)).toMatch(/over its budget of 2 /);
  });

  it("refuses a budget that is not a count", () => {
    expect(() => parseGitBudgets("[]")).toThrow("not an object");
    expect(() => parseGitBudgets(JSON.stringify({ default: -1, files: {} }))).toThrow("default is not a count");
    expect(() => parseGitBudgets(JSON.stringify({ default: 1 }))).toThrow("files is not an object");
    expect(() => parseGitBudgets(JSON.stringify({ default: 1, files: { "src/a.test.ts": 1.5 } }))).toThrow("the budget of src/a.test.ts");
  });

  it("reads the budget file of this package", () => {
    const file = readFileSync(join(import.meta.dirname, "git-starts.json"), "utf8");
    expect(parseGitBudgets(file).default).toBeGreaterThan(0);
  });

  it("runs with no variable of the CI runner", () => {
    expect(Object.keys(process.env).filter((name) => name === "CI" || name.startsWith("GITHUB_") || name.startsWith("RUNNER_"))).toEqual([]);
  });
});
