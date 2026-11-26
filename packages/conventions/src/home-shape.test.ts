// The rule home-shape on fixture repositories: a copy of the body of a home function is found with another name and inside a
// bigger function; a short body, another body, a copy that exists at the base and the repository of the home do not break.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { functionsOf, MIN_SHAPE_TOKENS } from "@mark1russell7/code-shape";
import { afterAll, describe, expect, it } from "vitest";
import { HOMES, runChecks, type Home, type RuleResult } from "./index.ts";
import { HOME_SHAPES } from "./home-shapes.ts";
import { containedHome, homeShape, homeShapesOf, shapeMessage, spansOf, type HomeShape } from "./rules/home-shape.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-shape-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** A repository of `repo` with a first commit of src/a.ts (`first`), and a second commit that adds `added` to it. */
function changed(added: string, repo = "mark1russell7/other", first = "export const one = 1;\n", manifest: Record<string, unknown> = { name: "one" }): string {
  const root = join(temp, String(fixtures++));
  for (const [file, text] of Object.entries({ "package.json": `${JSON.stringify(manifest)}\n`, "src/a.ts": first })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first");
  git(root, "remote", "add", "origin", `https://github.com/${repo}.git`);
  git(root, "tag", "base");
  writeFileSync(join(root, "src/a.ts"), `${first}${added}`);
  git(root, "commit", "-q", "-am", "change");
  return root;
}

function check(root: string, options: { base?: string; today?: string } = { base: "base" }): RuleResult {
  const result = runChecks({ root, only: ["home-shape"], env: {}, ...options }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

/** A local copy of isRecord of @mark1russell7/optional/read with another name (system-stack#172, 2026-11-26). */
const RENAMED = 'export function looksLikeRecord(input: unknown): input is Record<string, unknown> {\n  return typeof input === "object" && input !== null && !Array.isArray(input);\n}\n';
/** A bigger function that puts the body of isRecord in its own body: recordOf of the tenets audit of 2026-11-26. */
const INLINED = 'export function recordOf(input: unknown): Record<string, unknown> | undefined {\n  if (typeof input === "object" && input !== null && !Array.isArray(input)) return input as Record<string, unknown>;\n  return undefined;\n}\n';

describe("home-shape", () => {
  it("has the body of isRecord of @mark1russell7/optional in its index, with 16 tokens", () => {
    const isRecord = HOME_SHAPES["@mark1russell7/optional"]?.functions.find((item) => item.name === "isRecord");
    expect(isRecord?.tokens).toHaveLength(MIN_SHAPE_TOKENS);
    expect(homeShapesOf(HOMES).some((shape) => shape.name === "isRecord" && shape.home.area === "optional")).toBe(true);
  });

  it("(a) finds a renamed copy of the body of a home function", () => {
    const result = check(changed(RENAMED));
    expect(result.status).toBe("warn");
    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]).toMatchObject({ file: "src/a.ts", line: 2 });
    expect(result.breaks[0]?.message).toMatch(/^looksLikeRecord at src\/a\.ts:2 contains the body of isRecord of @mark1russell7\/optional[/\w]*\. Import isRecord from @mark1russell7\/optional[/\w]*\.$/u);
  });

  it("(b) finds a copy of the body of a home function inside a bigger function", () => {
    const result = check(changed(INLINED));
    expect(result.breaks.map((item) => item.message.split(" ")[0])).toEqual(["recordOf"]);
    expect(result.breaks[0]?.message).toContain("contains the body of isRecord of @mark1russell7/optional");
  });

  it("(c) never finds a body of 15 tokens", () => {
    const [short] = functionsOf("function short(a) {\n  return a.b.c + a.d.e - a.f;\n}\n");
    expect(short?.tokens.slice(5, -1)).toHaveLength(MIN_SHAPE_TOKENS - 1);
    const home = HOMES.find((item) => item.area === "optional") as Home;
    const needle: HomeShape = { name: "short", pkg: "@mark1russell7/optional", home, tokens: short?.tokens.slice(5, -1) ?? [] };
    // The haystack has the 15 tokens as a contiguous run, and the rule does not find it
    expect(containedHome(short?.tokens ?? [], [needle])).toBeUndefined();
    for (const entry of Object.values(HOME_SHAPES)) for (const item of entry.functions) expect(item.tokens.length).toBeGreaterThanOrEqual(MIN_SHAPE_TOKENS);
    expect(check(changed("export const tiny = (value: unknown): boolean => typeof value === \"object\";\n")).breaks).toEqual([]);
  });

  it("(d) does not find another body", () => {
    const other = 'export function looksLikeList(input: unknown): boolean {\n  return typeof input === "object" && input !== null && Array.isArray(input) && input.length > 0;\n}\n';
    expect(check(changed(other)).status).toBe("pass");
  });

  it("(e) skips the repository of the home, also after a move to the other owner", () => {
    expect(check(changed(RENAMED, "mark1russell7/optional")).status).toBe("pass");
    expect(check(changed(RENAMED, "metrograph-labs/optional")).status).toBe("pass");
    expect(check(changed(RENAMED, "someone/optional")).breaks).toHaveLength(1);
  });

  it("does not break on a copy that exists at the base, and breaks on a function that the change makes a copy", () => {
    const first = INLINED;
    // A change of a line of the old copy: the copy exists at the base, so it does not break
    expect(check(changed("export const two = 2;\n", "mark1russell7/other", first)).breaks).toEqual([]);
    const root = changed("export const two = 2;\n", "mark1russell7/other", "export function recordOf(input: unknown): unknown {\n  return input;\n}\n");
    writeFileSync(join(root, "src/a.ts"), INLINED);
    git(root, "commit", "-q", "-am", "the copy");
    expect(check(root).breaks.map((item) => item.line)).toEqual([1]);
  });

  it("skips with no change, examines each function with the option scope all, and fails with the option level fail", () => {
    const root = changed(RENAMED);
    expect(check(root, {}).status).toBe("skipped");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "one", conventions: { rules: { "home-shape": { scope: "all", level: "fail", reason: "a sweep of the copies" } } } }));
    expect(check(root, {}).status).toBe("warn");
    // From the day failsFrom, the option level fail makes a break fail the check
    const result = check(root, { today: homeShape.failsFrom ?? "" });
    expect(result.status).toBe("break");
    expect(result.breaks.map((item) => item.line)).toEqual([2]);
  });

  it("warns by default, and gives the day failsFrom that each new rule gives", () => {
    expect(homeShape.warnOnly?.({ level: "warn", scope: "change" })).toMatch(/warns until a measure/u);
    expect(homeShape.warnOnly?.({ level: "fail", scope: "change" })).toBeUndefined();
    expect(homeShape.failsFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it("gives the lines of each function up to the next function", () => {
    const functions = functionsOf("function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n");
    expect(spansOf(functions, 8)).toEqual([
      [1, 4],
      [5, 8],
    ]);
    const home = HOMES.find((item) => item.area === "optional") as Home;
    expect(shapeMessage("f", "src/x.ts", 3, { name: "isRecord", pkg: "@mark1russell7/optional/read", home, tokens: [] })).toBe("f at src/x.ts:3 contains the body of isRecord of @mark1russell7/optional/read. Import isRecord from @mark1russell7/optional/read.");
  });
});
