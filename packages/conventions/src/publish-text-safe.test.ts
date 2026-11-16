/**
 * The rule `publish-text-safe` on fixture repositories. The README of @mark1russell7/text 0.0.7 is the planted case.
 *
 * The corpus of the measure, on 2026-11-16: the README.md and package.json files at D:/git/<repo> and
 * D:/git/<repo>/packages/<p> of the local clones (448 README files, 660 manifests). The shapes of the rule file found
 * 1 true example (the text 0.0.7 README, in 2 old clones) and 0 false hits. A first pattern of quoted words with `or`
 * gave 8 false hits on the text `role="table"` or `role="grid"`. The clean cases below are lines of that corpus.
 * A change of a pattern runs again against the same corpus: the script reads the two levels, no walk.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findSecretShapes } from "@mark1russell7/text/redact";
import { runChecks, type RuleResult } from "./index.ts";
import { ATTACK_SHAPES, attackLines, secretLines } from "./rules/publish-text-safe.ts";

// The sample tokens come from parts at run time, so this file holds no text in the shape of a token. A scan of the
// repository, for example the push protection of GitHub, finds no token here.
const CLASSIC = ["ghp", "_", "a1".repeat(18)].join("");
const NPM = ["npm", "_", "b2".repeat(18)].join("");
const KEY_BLOCK = [["-----BEGIN", "PRIVATE KEY-----"].join(" "), "c3".repeat(30), ["-----END", "PRIVATE KEY-----"].join(" ")].join("\n");

const temp = mkdtempSync(join(tmpdir(), "conventions-publish-text-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let count = 0;

/** This function writes a repository, and gives its root. The function writes a value that is not a text as JSON. */
function repo(files: Record<string, unknown>): string {
  const root = join(temp, String(count++));
  for (const [file, value] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
  return root;
}

function check(root: string, today = "2026-12-01"): RuleResult {
  const result = runChecks({ root, only: ["publish-text-safe"], today }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

/** The README lines of @mark1russell7/text 0.0.7 around the example that stopped each publish (E403). */
const OLD_TEXT_README = [
  "## Parts",
  "",
  "```ts",
  'partsOf("key=[secret] and [secret]", "[secret]");',
  'partsAt("And 11=2 is false", [[4, 8]]);',
  '// [{ text: "And ", hit: false }, { text: "11=2", hit: true }, { text: " is false", hit: false }]',
  "```",
  "",
].join("\n");

/** The README lines of pull request 32 of text, which published 0.0.7. */
const NEW_TEXT_README = [
  "## Parts",
  "",
  "```ts",
  'partsOf("one cat, two cats", "cat");',
  'partsAt("A wide river", [[2, 6]]);',
  "```",
  "",
].join("\n");

const LIB = { name: "@x/text", version: "0.0.7", files: ["dist"] };

describe("publish-text-safe", () => {
  it("breaks on the README of text 0.0.7 at the line of the example, and passes the README of pull request 32", () => {
    const planted = check(repo({ "package.json": LIB, "README.md": OLD_TEXT_README }));
    expect(planted.status).toBe("break");
    expect(planted.breaks).toHaveLength(1);
    expect(planted.breaks[0]).toMatchObject({ file: "README.md", line: 5 });
    expect(planted.breaks[0]?.message).toContain('"And 11=2"');
    expect(planted.breaks[0]?.message).toContain("(sql-boolean)");
    expect(planted.breaks[0]?.message).toContain("@x/text");
    expect(check(repo({ "package.json": LIB, "README.md": NEW_TEXT_README })).status).toBe("pass");
  });

  it("fails from its release day, 2026-11-16, with no wait of RULE_WARN_DAYS", () => {
    const root = repo({ "package.json": LIB, "README.md": OLD_TEXT_README });
    expect(check(root, "2026-11-15").status).toBe("warn");
    expect(check(root, "2026-11-16").status).toBe("break");
  });

  it("examines the README of each public package of a workspace, with each case of the name, and not a private package", () => {
    const root = repo({
      "package.json": { name: "root", private: true },
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/a/package.json": { name: "@x/a", version: "1.0.0" },
      "packages/a/readme.markdown": OLD_TEXT_README,
      "packages/b/package.json": { name: "@x/b", version: "1.0.0", private: true },
      "packages/b/README.md": OLD_TEXT_README,
      "packages/c/package.json": { name: "@x/c" },
      "packages/c/README.md": OLD_TEXT_README,
      "packages/d/package.json": { name: "@x/d", version: "1.0.0" },
      "packages/d/docs/README.md": OLD_TEXT_README,
    });
    const result = check(root);
    expect(result.breaks.map((item) => `${item.file}:${item.line}`)).toEqual(["packages/a/readme.markdown:5"]);
  });

  it("breaks on the field description and on an entry of keywords, at the line of the field", () => {
    const manifest = `${JSON.stringify({ name: "@x/q", version: "1.0.0", description: "Rows where a = a or 1=1", keywords: ["sql", "union select"] }, null, 2)}\n`;
    const result = check(repo({ "package.json": manifest }));
    expect(result.breaks.map((item) => [item.line, /\((sql-[a-z]+)\)/.exec(item.message)?.[1]])).toEqual([
      [4, "sql-boolean"],
      [5, "sql-union"],
    ]);
    expect(result.breaks[0]?.message).toContain('The field "description" of @x/q');
  });

  it("finds each shape in its planted line", () => {
    const planted: Record<string, string> = {
      "sql-boolean": "where id = 5 OR 2=2",
      "sql-tautology": "name = '' or 'x'='x",
      "sql-union": "1 UNION ALL SELECT name FROM users",
      "sql-drop": "x'; DROP TABLE users",
    };
    expect(Object.keys(planted).sort()).toEqual(ATTACK_SHAPES.map((shape) => shape.id).sort());
    for (const shape of ATTACK_SHAPES) {
      expect(attackLines(planted[shape.id] ?? "", [shape]).map((hit) => hit.shape.id)).toEqual([shape.id]);
    }
  });

  it("finds no shape in the clean lines of the measure: quoted words with or, a script tag, JSX handlers and sums", () => {
    const clean = [
      'A table is `table`, `role="table"` or `role="grid"`.',
      "<script>",
      '<script type="module" src="./main.js"></script>',
      "return <LayoutView layout={result} onPick={(id) => console.log(id)} />;",
      "The sum 1 + 2 = 3 is a fact.",
      "Use and or or, 1 + 1 = 2.",
      "A union of two sets, and select one.",
      "drop the table; it is old",
      "andromeda 1=1",
    ];
    for (const line of clean) expect(attackLines(line), line).toEqual([]);
  });

  it("finds no shape and no token in the README and the manifest of this package, so its own publish passes", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(attackLines(readme)).toEqual([]);
    expect(secretLines(readme)).toEqual([]);
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { description?: string; keywords?: string[] };
    const fields = [manifest.description ?? "", ...(manifest.keywords ?? [])].join("\n");
    expect(attackLines(fields)).toEqual([]);
    expect(secretLines(fields)).toEqual([]);
  });

  it("breaks on a token in a README at the line of its start, and the message names the shape, not the token", () => {
    const readme = ["# Use", "", `export GH_TOKEN=${CLASSIC}`, "", "A key:", KEY_BLOCK, "", "The end."].join("\n");
    const result = check(repo({ "package.json": LIB, "README.md": readme }));
    expect(result.status).toBe("break");
    expect(result.breaks.map((item) => [item.file, item.line, /\(([a-z-]+)\)\. npm/.exec(item.message)?.[1]])).toEqual([
      ["README.md", 3, "github-classic"],
      ["README.md", 6, "private-key"],
    ]);
    expect(result.breaks[0]?.message).toContain("The README of @x/text has a classic personal access token of GitHub");
    for (const item of result.breaks) {
      expect(item.message).not.toContain(CLASSIC);
      expect(item.message).not.toContain("a1a1");
      expect(item.message).not.toContain("c3c3");
    }
  });

  it("breaks on a token in the field description and in an entry of keywords, at the line of the field", () => {
    const manifest = `${JSON.stringify({ name: "@x/q", version: "1.0.0", description: `Set ${NPM} first`, keywords: ["cli", NPM] }, null, 2)}\n`;
    const result = check(repo({ "package.json": manifest }));
    expect(result.breaks.map((item) => [item.line, /\(([a-z-]+)\)\. npm/.exec(item.message)?.[1]])).toEqual([
      [4, "npm"],
      [5, "npm"],
    ]);
    expect(result.breaks[0]?.message).toContain('The field "description" of @x/q has an access token of npm');
    for (const item of result.breaks) expect(item.message).not.toContain(NPM);
  });

  it("finds no token in the fake values of a README and in a prefix alone", () => {
    const clean = [
      "export GH_TOKEN=TOKEN-EXAMPLE",
      "Authorization: Bearer TOKEN-EXAMPLE",
      "A classic token of GitHub starts with ghp_, and a token of npm starts with npm_.",
      "Set NPM_TOKEN in the secrets of the repository.",
      "-----BEGIN PUBLIC KEY-----",
    ];
    for (const line of clean) expect(secretLines(line), line).toEqual([]);
  });

  it("gives the same tokens as findSecretShapes of text, with the line of each start", () => {
    const text = `x\n${NPM} and ${CLASSIC}\n\n${KEY_BLOCK}\n`;
    expect(secretLines(text).map((hit) => hit.shape.id)).toEqual(findSecretShapes(text).map((match) => match.shape));
    expect(secretLines(text).map((hit) => hit.line)).toEqual([2, 2, 4]);
  });

  it("gives each shape of a line one time, with the line number from 1", () => {
    expect(attackLines("first\nx or 1=1 and 2=2\n").map((hit) => [hit.line, hit.shape.id, hit.text])).toEqual([[2, "sql-boolean", "or 1=1"]]);
  });
});
