import { describe, expect, it } from "vitest";
import { changelogFaults, changelogGateProblem, changelogReading, sectionMarksBreak } from "./changelog.js";

const FIRST = "## 0.1.0\n\nThe first release.\n";

describe("changelogFaults", () => {
  it("finds no fault when each section states its change and its break", () => {
    const text = ["# Changelog", "", "## 1.0.0", "", "A stable API.", "", "### Breaking", "", "- `pack` has a new name.", "", "## 0.2.1", "", "- A fix of the shelf.", "", "## 0.2.0", "", "A new option. This release has breaking changes.", "", FIRST].join("\n");
    expect(changelogFaults(text)).toEqual([]);
  });

  it("finds a first statement that names only the version kind", () => {
    const text = `## 0.1.1\n\nThis release raises the PATCH version. It has more text.\n\n- A new export.\n\n${FIRST}`;
    expect(changelogFaults(text)).toEqual([{ version: "0.1.1", kind: "version-kind-only", statement: "This release raises the PATCH version." }]);
    for (const statement of ["A patch release.", "PATCH.", "Minor version bump."]) {
      expect(changelogFaults(`## 0.1.1\n\n${statement}\n\n${FIRST}`).map((f) => f.kind)).toEqual(["version-kind-only"]);
    }
  });

  it("reads a statement that names the kind and what changed as a change", () => {
    expect(changelogFaults(`## 0.1.1\n\nPATCH: the \`cue\` feature gives a current range.\n\n${FIRST}`)).toEqual([]);
    expect(changelogFaults(`## 0.1.1\n\nThis release raises the PATCH version: it adds exports.\n\n${FIRST}`)).toEqual([]);
  });

  it("reads the words of a change as a change", () => {
    expect(changelogFaults(`## 0.1.1\n\n- Patch the minor axis of the shelf.\n\n${FIRST}`)).toEqual([]);
  });

  it("finds an empty section", () => {
    expect(changelogFaults(`## 0.1.1\n\n${FIRST}`)).toEqual([{ version: "0.1.1", kind: "no-statement", statement: "" }]);
  });

  it("passes a section with only dependency lines when the version rule gives no break", () => {
    expect(changelogFaults(`## 0.1.2\n\n### Patch Changes\n\n- Updated dependencies [abc1234]\n  - @a/b@1.2.3\n\n${FIRST}`)).toEqual([]);
    expect(changelogFaults(`## 0.1.2\n\n### Patch Changes\n\n- abc1234: Updated dependencies\n\n${FIRST}`)).toEqual([]);
  });

  it("finds a section with only dependency lines on a break of the version rule", () => {
    expect(changelogFaults(`## 0.2.0\n\n### Minor Changes\n\n- Updated dependencies [abc1234]\n\n${FIRST}`)).toEqual([
      { version: "0.2.0", kind: "no-statement", statement: "" },
      { version: "0.2.0", kind: "break-unmarked", statement: "" },
    ]);
    expect(changelogFaults(`## 1.0.0\n\n- @a/b@1.2.3\n\n${FIRST}`).map((f) => f.kind)).toEqual(["no-statement", "break-unmarked"]);
  });

  it("does not read a dependency line in a pre-release or in the oldest section as a break", () => {
    expect(changelogFaults(`## 0.2.0-rc.1\n\n- Updated dependencies [abc1234]\n\n${FIRST}`)).toEqual([]);
    expect(changelogFaults("## 0.2.0\n\n- Updated dependencies [abc1234]\n")).toEqual([]);
  });

  it("passes a section with no change in a fixed group, and it still reads a section with a change", () => {
    const text = `## 0.3.0\n\nA new name.\n\n## 0.2.1\n\n## 0.2.0\n\n### Minor Changes\n\n- Updated dependencies [abc1234]\n\n${FIRST}`;
    expect(changelogFaults(text, { fixedGroup: true })).toEqual([{ version: "0.3.0", kind: "break-unmarked", statement: "A new name." }]);
    expect(changelogFaults(text).map((f) => [f.version, f.kind])).toEqual([
      ["0.3.0", "break-unmarked"],
      ["0.2.1", "no-statement"],
      ["0.2.0", "no-statement"],
      ["0.2.0", "break-unmarked"],
    ]);
  });

  it("reads the first change of a Changesets section, without its commit", () => {
    const text = `## 0.1.1\n\n### Patch Changes\n\n- abc1234: Fix the shelf. It keeps the order.\n\n${FIRST}`;
    expect(changelogFaults(text)).toEqual([]);
  });

  it("finds a break of the version rule with no mark, before and from 1.0.0", () => {
    const faults = changelogFaults(`## 2.0.0\n\nA new API.\n\n## 1.1.0\n\nA new option.\n\n## 1.0.0\n\nA stable API.\n\n## 0.2.0\n\nA new option.\n\n${FIRST}`);
    expect(faults.map((f) => [f.version, f.kind])).toEqual([
      ["2.0.0", "break-unmarked"],
      ["1.0.0", "break-unmarked"],
      ["0.2.0", "break-unmarked"],
    ]);
  });

  it("passes a raise of a fixed group, and it still finds a MINOR change of the same group", () => {
    const text = `## 0.5.0\n\n### Minor Changes\n\n- abc1234: A new option.\n\n## 0.4.0\n\n### Patch Changes\n\n- abc1234: A fix.\n\n## 0.3.0\n\nNo changes in this release.\n\n## 0.2.0\n\n### Minor Changes\n\n- abc1234: A new option.\n\n### Patch Changes\n\n- abc1234: A fix.\n\n${FIRST}`;
    expect(changelogFaults(text, { fixedGroup: true }).map((f) => [f.version, f.kind])).toEqual([
      ["0.5.0", "break-unmarked"],
      ["0.2.0", "break-unmarked"],
    ]);
    expect(changelogFaults(text).map((f) => f.version)).toEqual(["0.5.0", "0.4.0", "0.3.0", "0.2.0"]);
  });

  it("keeps the other faults of a section in a fixed group", () => {
    expect(changelogFaults(`## 0.2.0\n\nA free text with no heading.\n\n${FIRST}`, { fixedGroup: true }).map((f) => f.kind)).toEqual(["break-unmarked"]);
    expect(changelogFaults(`## 0.2.0\n\n### Patch Changes\n\n- PATCH.\n\n${FIRST}`, { fixedGroup: true }).map((f) => f.kind)).toEqual(["version-kind-only"]);
    expect(changelogFaults(`## 0.1.1\n\n### Patch Changes\n\n- A fix.\n\n### Breaking\n\n- A new name.\n\n${FIRST}`, { fixedGroup: true }).map((f) => f.kind)).toEqual(["mark-without-break"]);
  });

  it("counts only the two marks of a break", () => {
    expect(sectionMarksBreak("A new name.\n\n### Breaking\n\n- A new name.")).toBe(true);
    expect(sectionMarksBreak("### Breaking changes\n\n- A new name.")).toBe(true);
    expect(sectionMarksBreak("- abc1234: `pack` has breaking changes.")).toBe(true);
    for (const text of ["### Minor Changes", "### Major Changes", "MINOR before 1.0.0, a break.", "**Breaking:** a new name.", "- Breaking: a new name.", "Breaking changes: N/A", "### Breakingly fast", "A fix with no breaking changes.", "It has no breaking changes."]) {
      expect(sectionMarksBreak(text), text).toBe(false);
    }
  });

  it("finds a break with a heading or a first sentence that is not a mark", () => {
    for (const body of ["### Minor Changes\n\n- abc1234: A new option.", "MINOR before 1.0.0, a break: a new name."]) {
      expect(changelogFaults(`## 0.2.0\n\n${body}\n\n${FIRST}`).map((f) => f.kind)).toEqual(["break-unmarked"]);
    }
    expect(changelogFaults(`## 1.0.0\n\n### Major Changes\n\n- abc1234: A new API.\n\n${FIRST}`).map((f) => f.kind)).toEqual(["break-unmarked"]);
  });

  it("finds a break mark that the version rule does not give", () => {
    const text = `## 1.1.0\n\nA new option.\n\n### Breaking\n\n- A new name.\n\n## 0.1.1\n\nA fix. This release has breaking changes.\n\n${FIRST}`;
    expect(changelogFaults(text).map((f) => [f.version, f.kind])).toEqual([
      ["1.1.0", "mark-without-break"],
      ["0.1.1", "mark-without-break"],
    ]);
  });

  it("does not read a statement of no break as a mark", () => {
    expect(changelogFaults(`## 0.1.1\n\nA fix with no breaking changes.\n\n${FIRST}`)).toEqual([]);
    expect(changelogFaults(`## 0.1.1\n\nA fix.\n\nBreaking changes: N/A\n\n${FIRST}`)).toEqual([]);
  });

  it("gives a section two faults when it has both", () => {
    expect(changelogFaults(`## 0.2.0\n\nThis release raises the MINOR version.\n\n${FIRST}`).map((f) => f.kind)).toEqual(["version-kind-only", "break-unmarked"]);
  });

  it("does not apply the break rule to the oldest section or to a pre-release", () => {
    expect(changelogFaults("## 0.3.0\n\nThe first release here.\n")).toEqual([]);
    expect(changelogFaults(`## 0.2.0-rc.1\n\nA new option.\n\n${FIRST}`)).toEqual([]);
    expect(changelogFaults(`## 0.2.0-rc.1\n\nThis release raises the MINOR version.\n\n${FIRST}`).map((f) => f.kind)).toEqual(["version-kind-only"]);
  });

  it("reads each section from the version `from`, and the oldest section stays the oldest of the file", () => {
    const text = `## 0.3.0\n\nA new option.\n\n## 0.2.0\n\nA new option.\n\n${FIRST}`;
    expect(changelogFaults(text).map((f) => f.version)).toEqual(["0.3.0", "0.2.0"]);
    expect(changelogFaults(text, { from: "0.3.0" }).map((f) => f.version)).toEqual(["0.3.0"]);
    expect(changelogFaults(text, { from: "0.4.0" })).toEqual([]);
    expect(() => changelogFaults(text, { from: "latest" })).toThrow(RangeError);
  });

  it("ends a section at another heading of level 1 or 2", () => {
    const text = `## 0.2.0\n\nA new option.\n\n### Breaking\n\n- A new name.\n\n## render-pack 0.9.0\n\nThis release raises the MINOR version.\n\n${FIRST}`;
    expect(changelogFaults(text)).toEqual([]);
  });

  it("reads a file with no section", () => {
    expect(changelogFaults("# Changelog\n")).toEqual([]);
  });
});

describe("changelogReading and changelogGateProblem", () => {
  const TEXT = ["## 0.2.0", "", "### Minor Changes", "", "- abc1234: A new option.", "", "## 0.1.1", "", "### Patch Changes", "", "- abc1235: A fix.", "", FIRST].join("\n");
  const FILES = [{ file: "packages/a/CHANGELOG.md", markdown: TEXT }];

  it("reads all the sections with no from version, and only reports", () => {
    const reading = changelogReading(FILES, null);
    expect(reading).toEqual({ from: null, sections: 3, faults: [{ file: "packages/a/CHANGELOG.md", version: "0.2.0", kind: "break-unmarked", statement: "A new option." }] });
    expect(changelogGateProblem(reading)).toBeNull();
  });

  it("reads the sections from the from version, and gives the problem of a fault", () => {
    const reading = changelogReading(FILES, "0.1.1");
    expect(reading.sections).toBe(2);
    expect(changelogGateProblem(reading)).toBe('1 of 2 version sections from 0.1.1 break the rules of a changelog section:\n  packages/a/CHANGELOG.md 0.2.0: break-unmarked ("A new option.")');
    expect(changelogReading(FILES, "0.2.1")).toEqual({ from: "0.2.1", sections: 0, faults: [] });
    expect(changelogGateProblem(changelogReading(FILES, "0.2.1"))).toBeNull();
  });

  it("counts the faults past the limit of the problem", () => {
    const many = Array.from({ length: 3 }, (_, index) => ({ file: `p${index}/CHANGELOG.md`, markdown: TEXT }));
    expect(changelogGateProblem(changelogReading(many, "0.1.0"), 2)?.split("\n")).toEqual([
      "3 of 9 version sections from 0.1.0 break the rules of a changelog section:",
      '  p0/CHANGELOG.md 0.2.0: break-unmarked ("A new option.")',
      '  p1/CHANGELOG.md 0.2.0: break-unmarked ("A new option.")',
      "  and 1 more",
    ]);
  });

  it("refuses a from version that is not a version", () => {
    expect(() => changelogReading(FILES, "next")).toThrow(RangeError);
  });
});
