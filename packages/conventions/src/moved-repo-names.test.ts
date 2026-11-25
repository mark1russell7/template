// The kinds of place (places.ts) and the rule moved-repo-names on fixture repositories: each kind finds an old name and
// no new name, the replacement keeps the form of the place, a change log and uses: are not read, and the fix ends each break.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, runFix, type RuleResult } from "./index.ts";
import { PLACE_KINDS, replacePlaces, stalePlaces } from "./places.ts";
import { movedRepoNames } from "./rules/moved-repo-names.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-names-"));
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

function check(root: string, today: string): RuleResult {
  const result = runChecks({ root, only: ["moved-repo-names"], today }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

const MOVES = [{ from: "old/vex", to: "new/vex" }];

const MANIFEST = JSON.stringify(
  {
    name: "one",
    homepage: "https://old.github.io/vex/",
    bugs: { url: "https://github.com/old/vex/issues" },
    repository: { type: "git", url: "git+https://github.com/old/vex.git" },
    author: "Someone (https://github.com/old)",
    dependencies: { a: "github:old/vex#abc123", b: "github:other/vex#abc123", c: "github:new/vex#abc123" },
  },
  null,
  2,
);

describe("the kinds of place", () => {
  it("each kind finds the old name and no new name, and the replacement keeps the form", () => {
    const cases: [string, string, string][] = [
      ["package.json", MANIFEST, "package-fields"],
      ["package.json", '{ "repository": "old/vex" }', "package-fields"],
      ["README.md", "[![CI](https://github.com/old/vex/actions/workflows/ci.yml/badge.svg)](https://github.com/old/vex) and https://old.github.io/vex.", "doc-links"],
      [".github/workflows/ci.yml", "jobs:\n  a:\n    steps:\n      - with:\n          repository: old/vex\n", "workflow-names"],
      [".changeset/config.json", '{ "changelog": ["@changesets/changelog-github", { "repo": "old/vex" }] }', "config-repos"],
    ];
    for (const [file, text, kind] of cases) {
      const places = stalePlaces(file, text, MOVES);
      expect(places.length, `${kind} in ${file}`).toBeGreaterThan(0);
      expect(places.every((place) => place.kind === kind)).toBe(true);
      const after = replacePlaces(text, places);
      expect(stalePlaces(file, after, MOVES), `${kind} after the fix`).toEqual([]);
      expect(after).not.toMatch(/old[/.]/);
    }
  });

  it("writes new.github.io/vex for a Pages address, keeps .git and the ref, and reads no other owner or profile", () => {
    const after = replacePlaces(MANIFEST, stalePlaces("package.json", MANIFEST, MOVES));
    expect(after).toContain("https://new.github.io/vex/");
    expect(after).toContain("git+https://github.com/new/vex.git");
    expect(after).toContain('"a": "github:new/vex#abc123"');
    expect(after).toContain('"b": "github:other/vex#abc123"');
    expect(after).toContain("https://github.com/old)");
    expect(stalePlaces("package.json", MANIFEST, MOVES).map((place) => place.line)).toEqual([3, 5, 9, 13]);
  });

  it("does not read a change log, uses: (the rule moved-repo-calls), a comment or a file of no kind", () => {
    expect(stalePlaces("CHANGELOG.md", "https://github.com/old/vex/pull/1", MOVES)).toEqual([]);
    expect(stalePlaces("packages/a/CHANGELOG.md", "https://github.com/old/vex/pull/1", MOVES)).toEqual([]);
    expect(stalePlaces(".github/workflows/ci.yml", "      - uses: old/vex/.github/actions/x@abc\n      # https://github.com/old/vex\n", MOVES)).toEqual([]);
    expect(stalePlaces("src/index.ts", "// https://github.com/old/vex", MOVES)).toEqual([]);
    expect(PLACE_KINDS.map((kind) => kind.id)).toEqual(["package-fields", "doc-links", "workflow-names", "config-repos"]);
  });

  it("gives the column of the owner when the owner is also in the host, and ignores case", () => {
    const text = "see github.com/Git/Tool and git.github.io/tool";
    const places = stalePlaces("README.md", text, [{ from: "git/tool", to: "new/tool" }]);
    expect(places.map((place) => [place.column, place.text])).toEqual([
      [15, "Git/Tool"],
      [28, "git.github.io/tool"],
    ]);
    expect(replacePlaces(text, places)).toBe("see github.com/new/tool and new.github.io/tool");
  });
});

describe("the rule moved-repo-names", () => {
  it("reports each place with its line, the fix ends each break, and it is a warning before its day", () => {
    const root = repository({
      "package.json": MANIFEST.replaceAll("old/vex", "mark1russell7/vex").replaceAll("old.github.io", "mark1russell7.github.io"),
      "docs/guide.md": "Docs: https://mark1russell7.github.io/vex/\n",
      "CHANGELOG.md": "- https://github.com/mark1russell7/vex/pull/1\n",
    });
    const result = check(root, movedRepoNames.failsFrom ?? "");
    expect(result.status).toBe("break");
    expect(result.breaks.map((item) => [item.file, item.line])).toEqual([
      ["docs/guide.md", 1],
      ["package.json", 3],
      ["package.json", 5],
      ["package.json", 9],
      ["package.json", 13],
    ]);
    expect(check(root, "2026-11-25").status).toBe("warn");
    runFix({ root, only: ["moved-repo-names"], today: movedRepoNames.failsFrom ?? "" });
    expect(check(root, movedRepoNames.failsFrom ?? "").status).toBe("pass");
    expect(readFileSync(join(root, "docs/guide.md"), "utf8")).toBe("Docs: https://metrograph-labs.github.io/vex/\n");
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain("mark1russell7/vex/pull/1");
  });
});
