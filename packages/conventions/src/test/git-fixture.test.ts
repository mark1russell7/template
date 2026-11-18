import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gitFixtures } from "./git-fixture.ts";
import { startsOf } from "./process-starts.ts";

const repos = gitFixtures("conventions-git-fixture-");
afterAll(() => repos.remove());

/** This function gives the count of the git starts of `run`. */
function gitStarts(run: () => void): number {
  const before = startsOf("git");
  run();
  return startsOf("git") - before;
}

describe("gitFixtures", () => {
  it("makes the empty repository of the file one time, and copies it for each case with no git start", () => {
    const first = repos.folder();
    const second = repos.folder();
    expect(gitStarts(() => repos.init(first))).toBe(1);
    expect(gitStarts(() => repos.init(second))).toBe(0);
    expect(gitStarts(() => repos.init(second))).toBe(0);
    expect(repos.git(second, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/main");
    expect(existsSync(join(second, ".git", "hooks", "pre-commit.sample"))).toBe(false);
  });

  it("stages each file with one git start", () => {
    const root = repos.fixture({ "package.json": { name: "a" }, "src/a.ts": "export const a = 1;\n" });
    expect(gitStarts(() => repos.stageAll(root))).toBe(1);
    expect(repos.git(root, "ls-files").trim().split("\n")).toEqual(["package.json", "src/a.ts"]);
  });

  it("commits each file with two git starts, and copies a repository with its work tree and no git start", () => {
    const root = repos.fixture({ "a.txt": "a\n" });
    expect(gitStarts(() => repos.commitAll(root, "the first"))).toBe(2);
    let copy = "";
    expect(gitStarts(() => (copy = repos.copy(root)))).toBe(0);
    expect(repos.git(copy, "log", "-1", "--format=%s").trim()).toBe("the first");
    repos.write(copy, { "b.txt": "b\n" });
    repos.commitAll(copy, "the second");
    expect(repos.git(root, "log", "-1", "--format=%s").trim()).toBe("the first");
  });

  it("reads the commit of HEAD and of a branch with no git start, also on a detached HEAD", () => {
    const root = repos.fixture({ "a.txt": "a\n" });
    repos.commitAll(root);
    const main = repos.git(root, "rev-parse", "HEAD").trim();
    expect(gitStarts(() => expect(repos.commitOf(root)).toBe(main))).toBe(0);
    expect(repos.commitOf(root, "main")).toBe(main);
    repos.git(root, "switch", "-q", "--detach", "main");
    expect(gitStarts(() => expect(repos.commitOf(root)).toBe(main))).toBe(0);
    repos.git(root, "pack-refs", "--all");
    expect(repos.commitOf(root, "main")).toBe(main);
  });

  it("builds a shared repository one time for each key, and gives each call its own copy", () => {
    let builds = 0;
    const build = (): string => {
      builds++;
      const root = repos.fixture({ "a.txt": "a\n" });
      repos.commitAll(root);
      return root;
    };
    const first = repos.shared("one", build);
    let second = "";
    expect(gitStarts(() => (second = repos.shared("one", build)))).toBe(0);
    expect(builds).toBe(1);
    expect(second).not.toBe(first);
    repos.write(first, { "b.txt": "b\n" });
    expect(existsSync(join(second, "b.txt"))).toBe(false);
    repos.shared("two", build);
    expect(builds).toBe(2);
  });
});
