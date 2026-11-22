// The selector of precise CI: the workspace read, the closure of the dependents, the global files, the jobs, the summary,
// and the read of a change from git on a fixture repository.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  affectedPackages,
  packageOf,
  readWorkspace,
  runSelect,
  select,
  selectFromGit,
  selectionSummary,
  type ChangedFile,
  type Selection,
  type SelectionRecord,
  type WorkspacePackage,
} from "./select.ts";

const BASE = "0".repeat(40);
const HEAD = "1".repeat(40);

/** A workspace: app depends on core, cli depends on app, and site is private and alone. */
const PACKAGES: WorkspacePackage[] = [
  { id: ".", name: "root", private: true, deps: [] },
  { id: "packages/app", name: "@x/app", private: false, deps: ["packages/core"] },
  { id: "packages/cli", name: "@x/cli", private: false, deps: ["packages/app"] },
  { id: "packages/core", name: "@x/core", private: false, deps: [] },
  { id: "site", name: "site", private: true, deps: [] },
];

const run = (paths: readonly string[], over: Partial<Parameters<typeof select>[0]> = {}): Selection =>
  select({ base: BASE, head: HEAD, files: paths.map((path): ChangedFile => ({ path, status: "M" })), root: "", packages: PACKAGES, ...over });

const job = (selection: Selection, name: string) => {
  const found = selection.jobs.find((choice) => choice.job === name);
  if (found === undefined) throw new Error(`The selection has no job ${name}`);
  return found;
};

describe("readWorkspace", () => {
  const manifests = new Map([
    ["package.json", JSON.stringify({ name: "root", private: true, devDependencies: { "@x/core": "workspace:*", vitest: "^4.0.0" } })],
    ["packages/core/package.json", JSON.stringify({ name: "@x/core", version: "1.0.0" })],
    ["packages/app/package.json", JSON.stringify({ name: "@x/app", version: "1.0.0", peerDependencies: { "@x/core": "^1.0.0" } })],
    ["packages/app/test/fixture/package.json", JSON.stringify({ name: "fixture" })],
    ["tools/package.json", JSON.stringify({ name: "tools" })],
  ]);
  it("gives the root and each package of the globs, with the dependencies of each field", () => {
    expect(readWorkspace("packages:\n  - packages/*\n", manifests)).toEqual([
      { id: ".", name: "root", private: true, deps: ["packages/core"] },
      { id: "packages/app", name: "@x/app", private: false, deps: ["packages/core"] },
      { id: "packages/core", name: "@x/core", private: false, deps: [] },
    ]);
  });
  it("leaves out a folder of the default ignore of pnpm, also when a glob names it", () => {
    expect(readWorkspace("packages: ['packages/**']\n", manifests).map((pkg) => pkg.id)).toEqual([".", "packages/app", "packages/core"]);
  });
  it("gives only the root in a repository with no pnpm-workspace.yaml", () => {
    expect(readWorkspace(undefined, manifests).map((pkg) => pkg.id)).toEqual(["."]);
  });
  it("throws on a package.json that is not valid JSON, and on a list that it cannot read", () => {
    expect(() => readWorkspace("packages: [packages/*]", new Map([["packages/a/package.json", "{"]]))).toThrow(/packages\/a\/package.json is not valid JSON/);
    expect(() => readWorkspace("packages: packages/*\n", manifests)).toThrow(/not a list/);
  });
});

describe("packageOf and affectedPackages", () => {
  const ids = PACKAGES.map((pkg) => pkg.id);
  it("gives the deepest package folder of a path, else the root", () => {
    expect(packageOf("packages/core/src/index.ts", ids)).toBe("packages/core");
    expect(packageOf("packages/coreutils/x.ts", ids)).toBe(".");
    expect(packageOf("README.md", ids)).toBe(".");
  });
  it("gives each dependent of a changed package, with the changed package that it depends on", () => {
    expect(affectedPackages(["packages/core"], PACKAGES)).toEqual([
      { id: "packages/app", via: "packages/core" },
      { id: "packages/cli", via: "packages/core" },
      { id: "packages/core", via: "changed" },
    ]);
    expect(affectedPackages(["site"], PACKAGES)).toEqual([{ id: "site", via: "changed" }]);
  });
  it("ends on a cycle of dependencies", () => {
    const cycle: WorkspacePackage[] = [
      { id: "a", name: "a", private: false, deps: ["b"] },
      { id: "b", name: "b", private: false, deps: ["a"] },
    ];
    expect(affectedPackages(["a"], cycle)).toEqual([
      { id: "a", via: "changed" },
      { id: "b", via: "a" },
    ]);
  });
});

describe("select", () => {
  it("selects a changed package and its dependents, and skips a job that reads none of them", () => {
    const selection = run(["packages/core/src/index.ts"]);
    expect(selection.everything).toBe(false);
    expect(selection.packages.changed).toEqual(["packages/core"]);
    expect(job(selection, "checks")).toEqual({
      workflow: "reusable-ci.yml",
      job: "checks",
      packages: ["packages/app", "packages/cli", "packages/core"],
      run: true,
      because: { kind: "packages", packages: ["packages/app", "packages/cli", "packages/core"] },
    });
    expect(job(selection, "changesets").run).toBe(true);
    expect(job(selection, "release-window")).toEqual({ workflow: "reusable-ci.yml", job: "release-window", packages: [], run: false, because: { kind: "none" } });
  });
  it("gives a change of a private package only to the jobs of each package", () => {
    const selection = run(["site/src/page.ts"]);
    expect(job(selection, "checks").packages).toEqual(["site"]);
    expect(job(selection, "changesets").run).toBe(false);
    expect(job(selection, "release-check").run).toBe(false);
  });
  it("selects a job by its paths when it reads no affected package", () => {
    const selection = run([".changeset/brave-fox.md"]);
    expect(selection.packages.changed).toEqual(["."]);
    expect(job(selection, "changesets").because).toEqual({ kind: "paths", files: [".changeset/brave-fox.md"] });
    expect(job(selection, "release-check").run).toBe(false);
  });
  it.each(["pnpm-lock.yaml", "package.json", "tsconfig.base.json", "vitest.config.ts", ".github/workflows/ci.yml", ".github/actions/x/action.yml"])(
    "selects everything on the global file %s",
    (path) => {
      const selection = run(["packages/core/src/index.ts", path]);
      expect(selection.everything).toBe(true);
      expect(selection.global.map((item) => item.path)).toEqual([path]);
      expect(selection.jobs.every((choice) => choice.run && choice.because.kind === "global")).toBe(true);
      expect(selection.packages.affected).toHaveLength(PACKAGES.length);
    },
  );
  it("does not take a config of a package as a global file", () => {
    expect(run(["packages/core/tsconfig.json", "packages/core/package.json"]).everything).toBe(false);
  });
  it("selects everything when a package comes or goes", () => {
    const added = select({ base: BASE, head: HEAD, files: [{ path: "packages/new/package.json", status: "A" }], root: "", packages: PACKAGES });
    expect(added.everything).toBe(true);
    expect(added.global[0]?.reason).toMatch(/comes into/);
    const removed = select({ base: BASE, head: HEAD, files: [{ path: "packages/old/package.json", status: "D" }], root: "", packages: PACKAGES });
    expect(removed.global[0]?.reason).toMatch(/goes out of/);
  });
  it("selects everything on a file outside the workspace root", () => {
    const selection = run(["web/src/x.ts", "notes.md"], { root: "web", packages: [{ id: ".", name: "web", private: true, deps: [] }] });
    expect(selection.everything).toBe(true);
    expect(selection.unplaced.map((item) => item.path)).toEqual(["notes.md"]);
    expect(selection.jobs.every((choice) => choice.run && choice.because.kind === "unplaced")).toBe(true);
  });
  it("reads the global globs relative to the workspace root", () => {
    const selection = run(["web/fixtures/data.json"], {
      root: "web",
      packages: [{ id: ".", name: "web", private: true, deps: [] }],
      global: [{ glob: "fixtures/**", reason: "shared fixtures" }],
    });
    expect(selection.global).toEqual([{ path: "web/fixtures/data.json", reason: "shared fixtures" }]);
  });
});

describe("selectionSummary", () => {
  it("tells that each job still runs, and gives the choice of each job", () => {
    const lines = selectionSummary(run(["packages/core/src/index.ts"]));
    expect(lines[0]).toMatch(/shadow mode/);
    expect(lines).toContain("| release-window | skips | no file that the job reads |");
    expect(lines.some((line) => line.includes("affects 3 of 5 packages"))).toBe(true);
  });
  it("gives the reason of a no read", () => {
    expect(selectionSummary({ format: "selection/1", noRead: "git cannot read the change" }).at(-1)).toBe("No read: git cannot read the change");
  });
});

describe("selectFromGit and runSelect on a fixture repository", () => {
  const temp = mkdtempSync(join(tmpdir(), "conventions-select-"));
  afterAll(() => rmSync(temp, { recursive: true, force: true }));
  const gitIn = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
  const write = (root: string, files: Record<string, string>): void => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  };
  // main gets a commit after the start of the branch, and the pull request checkout is a merge commit of the two
  const repo = join(temp, "repo");
  mkdirSync(repo);
  gitIn(repo, "init", "-q", "-b", "main");
  write(repo, {
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "package.json": JSON.stringify({ name: "root", private: true }),
    "packages/core/package.json": JSON.stringify({ name: "@x/core", version: "1.0.0" }),
    "packages/core/src/index.ts": "export const a = 1;\n",
    "packages/app/package.json": JSON.stringify({ name: "@x/app", version: "1.0.0", dependencies: { "@x/core": "workspace:*" } }),
    "packages/other/package.json": JSON.stringify({ name: "@x/other", version: "1.0.0" }),
  });
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  gitIn(repo, "switch", "-q", "-c", "change");
  write(repo, { "packages/core/src/index.ts": "export const a = 3;\n" });
  gitIn(repo, "commit", "-q", "-am", "change core");
  const head = gitIn(repo, "rev-parse", "HEAD");
  gitIn(repo, "switch", "-q", "main");
  write(repo, { "packages/other/README.md": "other\n" });
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "main moves");
  const mainTip = gitIn(repo, "rev-parse", "HEAD");
  gitIn(repo, "merge", "-q", "--no-ff", "-m", "merge", "change");

  it("reads the change from the merge base, with the parents of the merge commit as the default", () => {
    const selection = selectFromGit({ cwd: join(repo, "packages"), base: "", head: "", root: "." });
    expect(selection.base).toBe(mainTip);
    expect(selection.head).toBe(head);
    expect(selection.files).toEqual([{ path: "packages/core/src/index.ts", status: "M", package: "packages/core" }]);
    expect(selection.packages.all).toEqual([".", "packages/app", "packages/core", "packages/other"]);
    expect(selection.packages.affected).toEqual([
      { id: "packages/app", via: "packages/core" },
      { id: "packages/core", via: "changed" },
    ]);
  });

  it("writes the record and the summary, with the ref and the time", () => {
    const out = join(temp, "out", "selection.json");
    const summary = join(temp, "summary.md");
    expect(runSelect({ BASE_SHA: mainTip, HEAD_SHA: head, OUT: out, GITHUB_STEP_SUMMARY: summary, SELECTOR_REF: "abc" }, repo, () => 12.6)).toBe(0);
    const record = JSON.parse(readFileSync(out, "utf8")) as SelectionRecord;
    expect(record).toMatchObject({ format: "selection/1", ref: "abc", durationMs: 13, base: mainTip, head });
    expect(readFileSync(summary, "utf8")).toMatch(/affects 2 of 4 packages/);
  });

  it("writes a no read and gives 0 when it cannot read the change", () => {
    const out = join(temp, "out", "no-read.json");
    expect(runSelect({ BASE_SHA: BASE, HEAD_SHA: head, OUT: out }, repo, () => 1)).toBe(0);
    const record = JSON.parse(readFileSync(out, "utf8")) as SelectionRecord;
    expect("noRead" in record).toBe(true);
  });
});
