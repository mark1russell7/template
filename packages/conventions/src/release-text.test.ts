import { describe, expect, it } from "vitest";
import { MAX_NOTES, changelogSection, npmUrl, releaseNotes, tagName } from "./release-text.ts";

const CHANGESETS = `# @scope/core

## 1.3.0-rc.1

### Minor Changes

- 1111111: A prerelease feature.

## 1.2.0

### Minor Changes

- abc1234: A new option \`timeout\`.

### Patch Changes

- def5678: A fix.

## 1.1.0

- 9999999: An old change.

## 1.0.0
`;

const FENCED = `## 1.0.0

Text.

\`\`\`md
## 0.9.0
\`\`\`

More text.

## 0.9.0

- Old.
`;

describe("tagName", () => {
  it("gives v<version> with one published package, and <name>@<version> with more", () => {
    expect(tagName("@scope/a", "1.2.0", 1)).toBe("v1.2.0");
    expect(tagName("@scope/a", "1.2.0", 2)).toBe("@scope/a@1.2.0");
  });
});

describe("changelogSection", () => {
  it("reads each heading form", () => {
    for (const heading of ["## 1.2.0", "## v1.2.0", "## [1.2.0] - 2026-10-18", "# pkg@1.2.0 (2026-10-18)"]) {
      expect(changelogSection(`${heading}\n\n- Text.\n`, "1.2.0", "pkg")).toBe("- Text.");
    }
  });

  it("keeps the deeper headings of the section, and stops at the next section", () => {
    const section = changelogSection(CHANGESETS, "1.2.0", "@scope/core");
    expect(section).toContain("### Patch Changes");
    expect(section).not.toContain("1.1.0");
  });

  it("does not take a heading in fenced code as the section or as its end", () => {
    expect(changelogSection(FENCED, "1.0.0", "pkg")).toContain("More text.");
    expect(changelogSection(FENCED, "0.9.0", "pkg")).toBe("- Old.");
  });

  it("does not take a version as the start of a longer version", () => {
    expect(changelogSection("## 1.2.0-rc.1\n\n- Text.\n", "1.2.0", "pkg")).toBeUndefined();
  });

  it("treats the characters of a name and a version as plain text", () => {
    expect(changelogSection("## 1x2x0\n\n- Text.\n", "1.2.0", "pkg")).toBeUndefined();
    expect(changelogSection("# a.b@1.0.0\n\n- Text.\n", "1.0.0", "a.b")).toBe("- Text.");
    expect(changelogSection("# axb@1.0.0\n\n- Text.\n", "1.0.0", "a.b")).toBeUndefined();
  });

  it("gives undefined for an empty section or a version with no section", () => {
    expect(changelogSection(CHANGESETS, "1.0.0", "pkg")).toBeUndefined();
    expect(changelogSection(CHANGESETS, "9.9.9", "pkg")).toBeUndefined();
  });

  it("reads a changelog with Windows line ends", () => {
    expect(changelogSection("## 1.0.0\r\n\r\n- Text.\r\n", "1.0.0", "pkg")).toBe("- Text.");
  });
});

describe("releaseNotes", () => {
  it("gives the section of the version", () => {
    expect(releaseNotes("pkg", "1.1.0", CHANGESETS)).toBe("- 9999999: An old change.");
  });

  it("gives one list item with a link to npm when no section exists", () => {
    const fallback = "- Version 2.0.0 of [`pkg`](https://www.npmjs.com/package/pkg/v/2.0.0) on npm.";
    expect(releaseNotes("pkg", "2.0.0", CHANGESETS)).toBe(fallback);
    expect(releaseNotes("pkg", "2.0.0", undefined)).toBe(fallback);
  });

  it("cuts a section that is too long, and keeps a section of the limit", () => {
    const of = (length: number): string => `## 1.0.0\n\n${"x".repeat(length)}\n`;
    expect(releaseNotes("pkg", "1.0.0", of(MAX_NOTES))).toHaveLength(MAX_NOTES);
    const cut = releaseNotes("pkg", "1.0.0", of(MAX_NOTES + 1));
    expect(cut.startsWith("x".repeat(MAX_NOTES))).toBe(true);
    expect(cut.endsWith("(The CHANGELOG.md of `pkg` has the full text.)")).toBe(true);
  });
});

describe("npmUrl", () => {
  it("gives the page of the version", () => {
    expect(npmUrl("@scope/a", "1.2.0")).toBe("https://www.npmjs.com/package/@scope/a/v/1.2.0");
  });
});

// The release workflow runs scripts/release/tags.ts, and that file keeps its own copy of the rule.
describe("the rule of scripts/release/tags.ts", () => {
  interface Rule {
    MAX_NOTES: number;
    changelogSection: typeof changelogSection;
    npmUrl: typeof npmUrl;
    releaseNotes: typeof releaseNotes;
    tagName: typeof tagName;
  }
  const load = async (): Promise<Rule> => (await import(/* @vite-ignore */ new URL("../../../scripts/release/tags.ts", import.meta.url).href)) as Rule;
  const changelogs = [CHANGESETS, FENCED, "", "## 1.0.0\r\n\r\n- Text.\r\n", `## 1.0.0\n\n${"x".repeat(MAX_NOTES + 1)}\n`, undefined];
  const versions = ["1.0.0", "0.9.0", "1.1.0", "1.2.0", "1.3.0-rc.1", "9.9.9"];

  it("gives the same limit, tags and addresses", async () => {
    const script = await load();
    expect(script.MAX_NOTES).toBe(MAX_NOTES);
    for (const count of [0, 1, 2]) expect(script.tagName("@scope/a", "1.2.0", count)).toBe(tagName("@scope/a", "1.2.0", count));
    expect(script.npmUrl("@scope/a", "1.2.0")).toBe(npmUrl("@scope/a", "1.2.0"));
  });

  it("gives the same section and the same text for each changelog and version", async () => {
    const script = await load();
    for (const changelog of changelogs) {
      for (const version of versions) {
        expect(script.releaseNotes("pkg", version, changelog)).toBe(releaseNotes("pkg", version, changelog));
        if (changelog !== undefined) expect(script.changelogSection(changelog, version, "pkg")).toBe(changelogSection(changelog, version, "pkg"));
      }
    }
  });
});
