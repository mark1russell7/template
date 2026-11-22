// The process starts of one check. A rule that reads git for each commit or each package starts a process for each
// one, and each process start leaks kernel memory on Windows. The rules version-title and unreleased-change read all the
// commits and all the packages of a change with a fixed count of git starts: the count for 20 commits and for 10
// packages is the count for 1.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { countProcessStarts, startsIn } from "@mark1russell7/rigor-testkit/process-starts";
import { afterAll, describe, expect, it } from "vitest";
import { parseCatFileBatch, runChecks, type RegistryAnswer } from "./index.ts";
import { unreleasedChangeRule } from "./rules/unreleased-change.ts";
import { versionTitle } from "./rules/version-title.ts";

const counts = countProcessStarts();
const temp = mkdtempSync(join(tmpdir(), "conventions-starts-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

/** This function starts git in `root`, and gives its output. */
function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** This function writes each file and commits the change with the title. */
function commit(root: string, title: string, files: Record<string, unknown>): void {
  for (const [file, value] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), `${JSON.stringify(value, null, 2)}\n`);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", title);
}

/** The manifests of `packages` packages, each at `version`. */
function manifests(packages: number, version: string): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: packages }, (_, index) => [`packages/p${String(index)}/package.json`, { name: `@x/p${String(index)}`, version }]));
}

/** A fake registry with no versions: each package is new. */
const lookup = (names: readonly string[]): ReadonlyMap<string, RegistryAnswer> => new Map(names.map((name): [string, RegistryAnswer] => [name, { versions: [] }]));

/**
 * This function makes a workspace with `packages` packages and a change of `commits` commits after its base. Each
 * commit raises the version of each package and names it in its title. It gives the git starts of a check of the
 * change by the two rules.
 */
function startsOfCheck(commits: number, packages: number): number {
  const root = join(temp, String(fixtures++));
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  commit(root, "first", { "package.json": { name: "root", private: true }, ...manifests(packages, "0.1.0") });
  const base = git(root, "rev-parse", "HEAD");
  for (let index = 1; index <= commits; index++) commit(root, `feat: change ${String(index)} (0.1.${String(index)}) (#${String(index)})`, manifests(packages, `0.1.${String(index)}`));
  counts.clear();
  const result = runChecks({ root, base, env: {}, only: ["version-title", "unreleased-change"], rules: [versionTitle, unreleasedChangeRule(lookup)] });
  const starts = startsIn(counts, "git");
  for (const rule of result.rules) expect(rule.status, `${rule.id}: ${JSON.stringify(rule)}`).toBe("pass");
  return starts;
}

describe("the process starts of a check", () => {
  it("are the same for 1 and for 20 commits", () => {
    const one = startsOfCheck(1, 1);
    expect(one).toBeGreaterThan(0);
    expect(startsOfCheck(20, 1)).toBe(one);
  });

  it("are the same for 1 and for 10 packages", () => {
    expect(startsOfCheck(3, 10)).toBe(startsOfCheck(3, 1));
  });
});

describe("parseCatFileBatch", () => {
  const out = (...parts: string[]): Buffer => Buffer.from(parts.join(""), "utf8");

  it("gives the text of each blob, and undefined for a name that git does not have", () => {
    expect(parseCatFileBatch(out("a1b2 blob 5\nhello\n", "HEAD:x y missing\n", "c3d4 blob 2\nhi\n"), 3)).toEqual(["hello", undefined, "hi"]);
  });

  it("skips the content of an object that is not a blob", () => {
    expect(parseCatFileBatch(out("e5f6 tree 4\nabcd\n", "a1b2 blob 3\nend\n"), 2)).toEqual([undefined, "end"]);
  });

  it("counts the size in bytes, not in characters", () => {
    expect(parseCatFileBatch(out("a1b2 blob 3\né!\n", "c3d4 blob 1\nz\n"), 2)).toEqual(["é!", "z"]);
  });

  it("gives fewer entries when the output ends early", () => {
    expect(parseCatFileBatch(out("a1b2 blob 1\nq\n"), 3)).toEqual(["q"]);
  });
});
