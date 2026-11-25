// The plan of a move (move-plan.ts) and the commands `conventions move plan` and `conventions move apply` on fixture
// repositories: each kind of place and each uses: line is in the plan, the steps follow the places, and apply ends the plan.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyMoves, movePlan } from "./move-plan.ts";
import { runCli } from "./run.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-move-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

/** This function makes a git repository with the files, and gives its root. */
function repository(files: Record<string, string>): string {
  const root = join(temp, String(fixtures++));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "first"]]) {
    const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return root;
}

/** This function starts the CLI in `root`, and gives its exit code and its output. */
function cli(root: string, args: readonly string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = runCli(args, { cwd: root, env: {}, stdout: (text) => (out += text), stderr: (text) => (err += text) });
  return { code, out, err };
}

const MOVES = [{ from: "old/vex", to: "new/vex" }];

const FILES = {
  "package.json": JSON.stringify({ name: "one", repository: { type: "git", url: "git+https://github.com/old/vex.git" }, homepage: "https://old.github.io/vex/" }, null, 2),
  "README.md": "See https://github.com/old/vex and https://github.com/other/vex.\n",
  ".github/workflows/ci.yml": "jobs:\n  a:\n    uses: old/vex/.github/workflows/ci.yml@abc123\n  b:\n    steps:\n      - with:\n          repository: old/vex\n",
  "CHANGELOG.md": "- https://github.com/old/vex/pull/1\n",
};

describe("the plan of a move", () => {
  it("has each kind of place and each uses: line, in the order of the files and the lines", () => {
    const files = Object.entries(FILES).map(([path, text]) => ({ path, text }));
    const plan = movePlan(files, MOVES);
    expect(plan.places.map((place) => [place.file, place.line, place.kind, place.replacement])).toEqual([
      [".github/workflows/ci.yml", 3, "workflow-calls", "new/vex"],
      [".github/workflows/ci.yml", 7, "workflow-names", "new/vex"],
      ["README.md", 1, "doc-links", "new/vex"],
      ["package.json", 5, "package-fields", "new/vex"],
      ["package.json", 7, "package-fields", "new.github.io/vex"],
    ]);
    expect(plan.steps.map((step) => step.id)).toEqual(["npm-trust", "pages-address", "workflow-calls", "clone-remotes"]);
  });

  it("needs no npm or Pages step when no package field and no Pages address names the old name", () => {
    const plan = movePlan([{ path: "README.md", text: "https://github.com/old/vex\n" }], MOVES);
    expect(plan.steps.map((step) => step.id)).toEqual(["workflow-calls", "clone-remotes"]);
  });

  it("applies each place, keeps the change log and the other owner, and the plan is then empty", () => {
    const files = Object.entries(FILES).map(([path, text]) => ({ path, text }));
    const changed = applyMoves(files, MOVES);
    expect(changed.map((file) => file.path).sort()).toEqual([".github/workflows/ci.yml", "README.md", "package.json"]);
    const after = files.map((file) => changed.find((each) => each.path === file.path) ?? file);
    expect(movePlan(after, MOVES).places).toEqual([]);
    expect(after.find((file) => file.path === "README.md")?.text).toBe("See https://github.com/new/vex and https://github.com/other/vex.\n");
    expect(after.find((file) => file.path === ".github/workflows/ci.yml")?.text).toContain("uses: new/vex/.github/workflows/ci.yml@abc123");
  });
});

describe("the commands move plan and move apply", () => {
  it("plan shows the places and the steps and writes no file, apply writes each one", () => {
    const root = repository(FILES);
    const plan = cli(root, ["move", "plan", "old/vex=new/vex"]);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("5 places.");
    expect(plan.out).toContain("README.md:1  doc-links  old/vex -> new/vex");
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("github.com/old/vex");
    const json = JSON.parse(cli(root, ["move", "plan", "old/vex=new/vex", "--json"]).out) as { places: unknown[]; steps: { id: string }[] };
    expect(json.places).toHaveLength(5);
    expect(json.steps[0]?.id).toBe("npm-trust");
    const apply = cli(root, ["move", "apply", "old/vex=new/vex"]);
    expect(apply.code).toBe(0);
    expect(apply.out).toContain("Wrote 3 files.");
    expect(apply.out).toContain("No file names an old name.");
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain("github.com/old/vex/pull/1");
  });

  it("refuses a move of another form, and no move", () => {
    const root = repository({ "README.md": "x\n" });
    expect(cli(root, ["move", "plan", "old/vex"]).code).toBe(2);
    expect(cli(root, ["move", "plan"]).code).toBe(2);
    expect(cli(root, ["move", "go", "a/b=c/d"]).code).toBe(2);
  });
});
