// The rule security-overrides on fixture repositories: the versions of a child in the lockfile, the line that the fix
// adds, the line that the fix removes at the end of an override, and the cases that the rule skips.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, runFix, type RuleResult } from "./index.ts";
import { childVersions, isBelow, selectorOf, SHARED_OVERRIDES } from "./rules/security-overrides.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-security-overrides-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

const ID = "security-overrides";
const WORKSPACE = "pnpm-workspace.yaml";
/** A day after the day `failsFrom` of the rule, so a break fails the check. */
const LATER = "2026-12-01";

const COMMENT = "# GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249. The rule security-overrides of conventions removes this line at its end.";
const LINE = '"archiver-utils>glob": "^14.0.3"';

/** This function gives a lockfile of version 9 with a snapshot of archiver-utils for each version of glob. */
const lockfile = (...globs: readonly string[]): string =>
  [
    "lockfileVersion: '9.0'",
    "",
    "packages:",
    "",
    ...globs.flatMap((_, at) => [`  archiver-utils@5.0.${at}:`, "    resolution: {integrity: sha512-a}", ""]),
    "snapshots:",
    "",
    ...globs.flatMap((glob, at) => [`  archiver-utils@5.0.${at}:`, "    dependencies:", `      glob: ${glob}`, "      graceful-fs: 4.2.11", ""]),
  ].join("\n");

/** A lockfile with no archiver-utils. */
const NO_PARENT = ["lockfileVersion: '9.0'", "", "snapshots:", "", "  glob@14.0.6:", "    dependencies:", "      minimatch: 11.0.4", ""].join("\n");

/** This function writes the files of a fixture repository, and gives its root. */
function repository(files: Record<string, string>): string {
  const root = join(temp, String(fixtures++));
  for (const [file, text] of Object.entries({ "package.json": '{ "name": "one" }\n', ...files })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

function check(root: string, today = LATER): RuleResult {
  const result = runChecks({ root, only: [ID], today }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

const read = (root: string): string => readFileSync(join(root, WORKSPACE), "utf8");

describe("the data of the rule security-overrides", () => {
  it("gives each override a fixed version in its range, an advisory and an end", () => {
    expect(new Set(SHARED_OVERRIDES.map(selectorOf)).size).toBe(SHARED_OVERRIDES.length);
    for (const override of SHARED_OVERRIDES) {
      expect(override.range).toBe(`^${override.fixed}`);
      expect(override.advisories.length).toBeGreaterThan(0);
      for (const advisory of override.advisories) expect(advisory).toMatch(/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/u);
      expect(override.end).not.toBe("");
    }
  });

  it("compares release versions, and gives false for other text", () => {
    expect(isBelow("10.4.5", "14.0.3")).toBe(true);
    expect(isBelow("14.0.2", "14.0.3")).toBe(true);
    expect(isBelow("10.4.5(supports-color@8.1.1)", "14.0.3")).toBe(true);
    expect(isBelow("14.0.3", "14.0.3")).toBe(false);
    expect(isBelow("14.1.0", "14.0.3")).toBe(false);
    expect(isBelow("15.0.0", "14.0.3")).toBe(false);
    expect(isBelow("link:../glob", "14.0.3")).toBe(false);
    expect(isBelow("14.0", "14.0.3")).toBe(false);
  });

  it("reads the snapshots of each document, a quoted key and a peer suffix, and not the packages", () => {
    const text = [
      "---",
      "lockfileVersion: '9.0'",
      "",
      "snapshots:",
      "",
      "  archiver-utils@4.0.1:",
      "    dependencies:",
      "      glob: 10.0.0",
      "",
      "---",
      "lockfileVersion: '9.0'",
      "",
      "packages:",
      "",
      "  archiver-utils@5.0.2:",
      "    dependencies:",
      "      glob: 9.0.0",
      "",
      "snapshots:",
      "",
      "  'archiver-utils@5.0.2(supports-color@8.1.1)':",
      "    optionalDependencies:",
      "      glob: '10.4.5(supports-color@8.1.1)'",
      "",
      "  archiver-utils-extra@1.0.0:",
      "    dependencies:",
      "      glob: 8.0.0",
      "",
      "  archiver@7.0.1:",
      "    dependencies:",
      "      archiver-utils: 5.0.2",
      "      glob: 7.0.0",
      "",
    ].join("\n");
    expect(childVersions(text, "archiver-utils", "glob")).toEqual({ parents: 2, versions: ["10.0.0", "10.4.5(supports-color@8.1.1)"] });
    expect(childVersions(NO_PARENT, "archiver-utils", "glob")).toEqual({ parents: 0, versions: [] });
  });
});

describe("the rule security-overrides", () => {
  it("adds the override to a new pnpm-workspace.yaml, and the fix passes on its second run", () => {
    const root = repository({ "pnpm-lock.yaml": lockfile("10.4.5", "10.4.5") });
    const result = check(root);
    expect(result.status).toBe("break");
    expect(result.breaks.map((item) => item.message)).toEqual([expect.stringContaining("pnpm-lock.yaml has glob 10.4.5 under archiver-utils")]);
    expect(runFix({ root, only: [ID], today: LATER }).changed).toEqual([WORKSPACE]);
    expect(read(root)).toBe(["overrides:", `  ${COMMENT}`, `  ${LINE}`, ""].join("\n"));
    // The lockfile changes at the next pnpm install, and the rule reads the override of the workspace until then
    expect(check(root).status).toBe("pass");
    expect(runFix({ root, only: [ID], today: LATER }).changed).toEqual([]);
  });

  it("warns before the day failsFrom", () => {
    const root = repository({ "pnpm-lock.yaml": lockfile("10.4.5") });
    expect(runChecks({ root, only: [ID], today: "2026-11-16" })).toMatchObject({ failed: false, rules: [{ status: "warn" }] });
  });

  it("adds the line after the last entry of overrides, with its indent and the line endings of the file", () => {
    const before = ["packages:", '  - "packages/*"', "", "overrides:", '    "foo": "1.0.0"', "", "trustPolicy: no-downgrade", ""].join("\r\n");
    const root = repository({ "pnpm-lock.yaml": lockfile("10.4.5"), [WORKSPACE]: before });
    expect(check(root).breaks.map((item) => [item.file, item.line])).toEqual([[WORKSPACE, 4]]);
    runFix({ root, only: [ID], today: LATER });
    const after = ["packages:", '  - "packages/*"', "", "overrides:", '    "foo": "1.0.0"', `    ${COMMENT}`, `    ${LINE}`, "", "trustPolicy: no-downgrade", ""];
    expect(read(root)).toBe(after.join("\r\n"));
  });

  it("adds the key overrides at the end of a file that has none", () => {
    const root = repository({ "pnpm-lock.yaml": lockfile("10.4.5"), [WORKSPACE]: "packages:\n  - a\n\n\n" });
    runFix({ root, only: [ID], today: LATER });
    expect(read(root)).toBe(["packages:", "  - a", "", "overrides:", `  ${COMMENT}`, `  ${LINE}`, ""].join("\n"));
  });

  it("does not change an inline value of overrides", () => {
    const root = repository({ "pnpm-lock.yaml": lockfile("10.4.5"), [WORKSPACE]: "overrides: {}\n" });
    const fixed = runFix({ root, only: [ID], today: LATER });
    expect(fixed.changed).toEqual([]);
    expect(fixed.result.rules[0]?.breaks.map((item) => item.message)).toEqual([expect.stringContaining("inline value")]);
  });

  it("passes on a fixed version, and on an override with its own range", () => {
    expect(check(repository({ "pnpm-lock.yaml": lockfile("14.0.6") })).status).toBe("pass");
    const own = repository({ "pnpm-lock.yaml": lockfile("14.1.0"), [WORKSPACE]: "overrides:\n  archiver-utils>glob: ^14.1.0\n" });
    expect(check(own).status).toBe("pass");
  });

  it("removes an override whose parent is not in the lockfile, with its comment and its empty key", () => {
    const before = ["packages:", "  - a", "", "overrides:", `  ${COMMENT}`, `  ${LINE}`, "", "trustPolicy: no-downgrade", ""].join("\n");
    const root = repository({ "pnpm-lock.yaml": NO_PARENT, [WORKSPACE]: before });
    expect(check(root).breaks.map((item) => [item.line, item.message])).toEqual([[6, expect.stringContaining('The override "archiver-utils>glob" ends')]]);
    expect(runFix({ root, only: [ID], today: LATER }).changed).toEqual([WORKSPACE]);
    expect(read(root)).toBe(["packages:", "  - a", "", "trustPolicy: no-downgrade", ""].join("\n"));
    expect(check(root).status).toBe("pass");
  });

  it("keeps the other entries of overrides at the end of an override", () => {
    const before = ["overrides:", "  foo: 1.0.0", `  ${COMMENT}`, `  ${LINE}`, ""].join("\n");
    const root = repository({ "pnpm-lock.yaml": NO_PARENT, [WORKSPACE]: before });
    runFix({ root, only: [ID], today: LATER });
    expect(read(root)).toBe(["overrides:", "  foo: 1.0.0", ""].join("\n"));
  });

  it("skips a repository with no pnpm-lock.yaml, or with a lockfile before version 9", () => {
    expect(check(repository({}))).toMatchObject({ status: "skipped", note: "the repository has no pnpm-lock.yaml" });
    const old = repository({ "pnpm-lock.yaml": "lockfileVersion: '6.0'\n", [WORKSPACE]: `overrides:\n  ${LINE}\n` });
    expect(check(old)).toMatchObject({ status: "skipped", note: "pnpm-lock.yaml is not a lockfile of version 9 or later" });
  });
});
