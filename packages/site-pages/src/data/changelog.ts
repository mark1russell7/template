/**
 * The changelog parser. Changesets writes a section for each version in the `CHANGELOG.md` of each
 * package. The section has a `## 0.13.2` heading and a `###` heading for each kind of change. Each
 * change is one `- <short sha>: <text>` entry. The next lines of an entry have an indent.
 */

/** One entry of a changelog section or of a release text. */
export interface ChangelogEntry {
  /** The short SHA of the commit, or null for an entry without a commit. */
  commit: string | null;
  /** The first sentence of the entry, with its code spans. */
  text: string;
}

/** The entries of one version of a changelog. */
export interface ChangelogSection {
  version: string;
  /** The text of the version heading, without the `##` marks. */
  heading: string;
  entries: ChangelogEntry[];
}

// "## 1.2.3", "## v1.2.3", "## [1.2.3] - 2026-10-18" or "## 1.2.3-rc.1"
const VERSION_HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?(?:\s.*)?$/;
const COMMIT_ENTRY = /^([0-9a-f]{7,40}):\s+([\s\S]*)$/;
// The lines of Changesets for a new version of a dependency: no change of the package itself
const DEPENDENCY_ENTRY = /^(?:Updated dependencies\b|@?[\w.-]+(?:\/[\w.-]+)?@\S+\s*$)/;
// The generated release notes of GitHub: "Fix it by @ann in https://github.com/o/r/pull/12". The
// pattern starts with one whitespace character, not "\s+": with "\s+", each space of a long run is
// a start, and the time grows with the square of the length. entryOf removes the rest of the run.
const GENERATED_NOTE = /\sby\s+@[\w-]+(?:\[bot\])?\s+in\s+(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+))\s*$/;
const FIRST_CONTRIBUTION = /\bmade their first contribution\b/;

/**
 * This function gives the first sentence of a text. A full stop, a question mark or an exclamation
 * mark ends the sentence when a space and no lowercase letter follow it.
 *
 * @remarks A mark in a code span does not end the sentence. A text that ends with a colon (a list
 * follows) ends with a full stop.
 */
export function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  let code = false;
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index];
    if (char === "`") {
      code = !code;
      continue;
    }
    if (code || (char !== "." && char !== "?" && char !== "!")) continue;
    const next = clean[index + 1];
    if (next === undefined) break;
    if (next === " " && !/^[a-z]/.test(clean.slice(index + 2))) return clean.slice(0, index + 1);
  }
  return clean.replace(/:$/, ".");
}

/**
 * This function makes one entry from the lines of a list item. The text is the first paragraph: the
 * lines before an empty line or a nested list. It gives null for an entry that is not a change.
 */
function entryOf(lines: readonly string[]): ChangelogEntry | null {
  const paragraph: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (index > 0 && (line.trim() === "" || /^\s+[-*+]\s/.test(line))) break;
    paragraph.push(line.trim());
  }
  const text = paragraph.join(" ");
  const commit = COMMIT_ENTRY.exec(text);
  let body = (commit ? commit[2] : text) ?? "";
  if (body.trim() === "" || DEPENDENCY_ENTRY.test(body.trim()) || FIRST_CONTRIBUTION.test(body)) return null;
  const note = GENERATED_NOTE.exec(body);
  if (note) body = `${body.slice(0, note.index).trimEnd()} ([#${note[2] ?? ""}](${note[1] ?? ""}))`;
  return { commit: commit?.[1] ?? null, text: firstSentence(body) };
}

/**
 * This function gives the entries of each version of a changelog, in the sequence of the file.
 *
 * @remarks An entry is a line that starts with "- " and the indented lines under it. An entry for a
 * new dependency version is not a change.
 */
export function parseChangelog(markdown: string): ChangelogSection[] {
  const sections: Array<{ version: string; heading: string; raw: string[][] }> = [];
  let section: { version: string; heading: string; raw: string[][] } | null = null;
  let entry: string[] | null = null;
  const close = (): void => {
    if (entry && section) section.raw.push(entry);
    entry = null;
  };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = VERSION_HEADING.exec(line);
    if (heading?.[1] !== undefined) {
      close();
      section = { version: heading[1], heading: line.replace(/^##\s+/, "").trim(), raw: [] };
      sections.push(section);
      continue;
    }
    if (section === null) continue;
    if (line.startsWith("- ")) {
      close();
      entry = [line.slice(2)];
    } else if (entry && (line.trim() === "" || /^\s/.test(line))) {
      (entry as string[]).push(line);
    } else {
      // A heading ("### Patch Changes") or a paragraph of the section ends the entry
      close();
      if (/^#{1,2}\s/.test(line)) section = null;
    }
  }
  close();
  return sections.map(({ version, heading, raw }) => ({
    version,
    heading,
    entries: raw.map(entryOf).filter((change): change is ChangelogEntry => change !== null),
  }));
}

/**
 * This function gives the changes of the text of a GitHub release: one change for each top-level
 * list item. Fenced code is not read.
 */
export function releaseBodyEntries(body: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let entry: string[] | null = null;
  let fence: string | null = null;
  const close = (): void => {
    const change = entry ? entryOf(entry) : null;
    if (change) entries.push(change);
    entry = null;
  };
  for (const line of body.split(/\r?\n/)) {
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceMark !== undefined) {
      close();
      if (fence === null) fence = fenceMark[0] ?? null;
      else if (fenceMark[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    // "\s+(\S.*)?" and not "\s+(.*)": the two parts cannot share a space, so a failed match does not backtrack
    const item = /^[-*+]\s+(\S.*)?$/.exec(line);
    if (item) {
      close();
      entry = [item[1] ?? ""];
    } else if (entry && (line.trim() === "" || /^\s/.test(line))) {
      (entry as string[]).push(line);
    } else {
      close();
    }
  }
  close();
  return entries;
}

/**
 * This function gives the anchor of a heading on GitHub: lowercase, no punctuation, and a hyphen
 * for each space. The anchor of "0.13.2" is "0132".
 */
export function headingAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
