import { describe, expect, it } from "vitest";
import { changelogFaults } from "./changelog.js";

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

  it("finds a section with no statement, and a dependency line is not a statement", () => {
    const text = `## 0.1.2\n\n### Patch Changes\n\n- Updated dependencies [abc1234]\n\n## 0.1.1\n\n${FIRST}`;
    expect(changelogFaults(text)).toEqual([
      { version: "0.1.2", kind: "no-statement", statement: "" },
      { version: "0.1.1", kind: "no-statement", statement: "" },
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

  it("does not count a Changesets MINOR heading as a break mark, and it counts a Major heading", () => {
    expect(changelogFaults(`## 0.2.0\n\n### Minor Changes\n\n- abc1234: A new option.\n\n${FIRST}`).map((f) => f.kind)).toEqual(["break-unmarked"]);
    expect(changelogFaults(`## 1.0.0\n\n### Major Changes\n\n- abc1234: A new API.\n\n${FIRST}`)).toEqual([]);
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
    expect(changelogFaults(`## 0.1.1\n\nA fix.\n\n**Breaking:** none\n\n${FIRST}`)).toEqual([]);
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
