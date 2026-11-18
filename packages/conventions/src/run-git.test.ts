// runGit starts no git in a folder that no repository holds: each process start costs time, and on Windows kernel memory.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { inRepository, runGit } from "./rule.ts";
import { startsOf } from "./test/process-starts.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-run-git-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllEnvs();
});

/** This function makes the folder `name` in the temporary folder, and gives its path. */
function folder(...names: string[]): string {
  const dir = join(temp, ...names);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("inRepository", () => {
  it("finds a .git folder or a .git file in the folder or in a parent folder", () => {
    const plain = folder("plain");
    expect(inRepository(plain, {})).toBe(false);
    mkdirSync(join(folder("work"), ".git"));
    expect(inRepository(folder("work"), {})).toBe(true);
    expect(inRepository(folder("work", "packages", "a"), {})).toBe(true);
    writeFileSync(join(folder("linked"), ".git"), "gitdir: ../work/.git\n");
    expect(inRepository(folder("linked"), {})).toBe(true);
  });

  it("finds a repository from the variable GIT_DIR, but not from an empty value", () => {
    expect(inRepository(folder("plain"), { GIT_DIR: join(temp, "work", ".git") })).toBe(true);
    expect(inRepository(folder("plain"), { GIT_DIR: "" })).toBe(false);
  });
});

describe("runGit", () => {
  it("starts no git in a folder that no repository holds", () => {
    vi.stubEnv("GIT_DIR", undefined);
    const plain = folder("no-repository");
    const before = startsOf("git");
    expect(runGit(plain, ["rev-parse", "--git-dir"])).toBeUndefined();
    expect(startsOf("git")).toBe(before);
  });

  it("starts git in a repository, and gives its output", () => {
    vi.stubEnv("GIT_DIR", undefined);
    const root = folder("repository");
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    const before = startsOf("git");
    expect(runGit(root, ["rev-parse", "--git-dir"])?.trim()).toBe(".git");
    expect(startsOf("git")).toBe(before + 1);
  });
});
