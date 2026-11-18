import { describe, expect, it } from "vitest";
import { startsReport } from "./process-starts.global.ts";
import { commandName, lineCommandName } from "./process-starts.setup.ts";

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
