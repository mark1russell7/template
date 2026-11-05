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
 * The kinds of a fault of a changelog section. `no-statement`: the section is empty, or it has only
 * dependency lines on a break of the version rule.
 * `version-kind-only`: its first statement names the kind of the version, and nothing more.
 * `break-unmarked`: the version rule makes the release a break, and the section has no break mark.
 * `mark-without-break`: the section has a break mark, and the version rule makes the release no break.
 */
export type ChangelogFaultKind = "no-statement" | "version-kind-only" | "break-unmarked" | "mark-without-break";

/** One fault of one version section of a changelog. */
export interface ChangelogFault {
  version: string;
  kind: ChangelogFaultKind;
  /** The first statement of the section, or an empty text when it has none. */
  statement: string;
}

/** The options of {@link changelogFaults}. */
export interface ChangelogFaultOptions {
  /** The oldest version to examine. Older sections can follow older habits, so a caller can leave them out. */
  from?: string;
  /**
   * This option states that all the packages of a fixed group raise one version together. Then the
   * raise of a section with no change comes from another package, and the section has no fault.
   */
  fixedGroup?: boolean;
}

const KIND_WORDS: ReadonlySet<string> = new Set(["major", "minor", "patch"]);
const FILL_WORDS: ReadonlySet<string> = new Set(["a", "the", "this", "is", "raises", "bumps", "release", "version", "bump"]);
// The two marks: free words do not count, because a reader cannot tell them from a text that names a break for another reason
const BREAK_HEADING = /^### Breaking\b/m;
const BREAK_SENTENCE = /\bhas breaking changes\b/;

/**
 * This function tells if the text of a version section marks a break. The marks are the heading
 * `### Breaking` and the words "has breaking changes", for a text that goes through Changesets.
 *
 * @remarks A page that counts breaks and {@link changelogFaults} use this one test, so they agree.
 */
export function sectionMarksBreak(section: string): boolean {
  return BREAK_HEADING.test(section) || BREAK_SENTENCE.test(section);
}

/** This function tells if a statement has only the kind of the version and words that state no change. */
function namesOnlyKind(statement: string): boolean {
  const words = statement.toLowerCase().match(/[\p{L}\p{N}`]+/gu) ?? [];
  return words.some((word) => KIND_WORDS.has(word)) && words.every((word) => KIND_WORDS.has(word) || FILL_WORDS.has(word));
}

/** This function gives the three numbers of a version without its pre-release text, or null for another text. */
function versionCore(version: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** This function compares two versions without their pre-release texts. */
function compareCores(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);
}

/**
 * This function tells if the version rule makes a release a break. Before 1.0.0, a break raises
 * MINOR. From 1.0.0, a break raises MAJOR.
 */
function ruleGivesBreak([major, minor, patch]: readonly [number, number, number]): boolean {
  if (patch !== 0) return false;
  return major === 0 ? minor > 0 : minor === 0;
}

/** This function gives the version and the body of each version section. Another heading of level 1 or 2 ends a section. */
function versionSections(markdown: string): { version: string; heading: string; body: string[] }[] {
  const sections: { version: string; heading: string; body: string[] }[] = [];
  let section: { version: string; heading: string; body: string[] } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = VERSION_HEADING.exec(line);
    if (heading?.[1] !== undefined) {
      section = { version: heading[1], heading: line, body: [] };
      sections.push(section);
    } else if (/^#{1,2}\s/.test(line)) {
      section = null;
    } else {
      section?.body.push(line);
    }
  }
  return sections;
}

/**
 * This function gives the first statement of a section: the first sentence of its first paragraph,
 * else the first change of its lists. A dependency line is not a change.
 */
function firstStatement(section: { heading: string; body: string[] }): string {
  const blocks = section.body.join("\n").split(/\n[ \t]*\n/).map((block) => block.trim());
  const first = blocks.find((block) => block !== "" && !block.startsWith("#"));
  if (first !== undefined && !/^[-*+]\s/.test(first)) return firstSentence(first);
  const [parsed] = parseChangelog([section.heading, ...section.body].join("\n"));
  return parsed?.entries[0]?.text ?? "";
}

/** This function tells if a section has a line that names a new version of a dependency. */
function hasDependencyLine(section: { body: string[] }): boolean {
  return section.body.some((line) => {
    const item = /^[-*+]\s+(.*)$/.exec(line)?.[1];
    return item !== undefined && DEPENDENCY_ENTRY.test((COMMIT_ENTRY.exec(item)?.[2] ?? item).trim());
  });
}

/**
 * This function gives the faults of the version sections of a changelog, in the order of the file.
 * A section can have two faults: one for its statement and one for its break mark.
 *
 * @remarks The break rule does not read a pre-release or the oldest section of the file, because
 * the oldest section has no earlier release to break. A dependency line does not say why the API
 * broke. Thus a section with only dependency lines has a fault on a break of the version rule. The
 * option `fixedGroup` removes this fault.
 */
export function changelogFaults(markdown: string, options: ChangelogFaultOptions = {}): ChangelogFault[] {
  const from = options.from === undefined ? null : versionCore(options.from);
  if (options.from !== undefined && from === null) throw new RangeError(`"${options.from}" is not a version.`);
  const sections = versionSections(markdown);
  const cores = sections.map((section) => versionCore(section.version)).filter((core) => core !== null);
  const oldest = cores.reduce<(typeof cores)[number] | null>((low, core) => (low === null || compareCores(core, low) < 0 ? core : low), null);
  const faults: ChangelogFault[] = [];
  for (const section of sections) {
    const core = versionCore(section.version);
    if (core === null || (from !== null && compareCores(core, from) < 0)) continue;
    const statement = firstStatement(section);
    const fault = (kind: ChangelogFaultKind): void => {
      faults.push({ version: section.version, kind, statement });
    };
    if (statement === "" && options.fixedGroup === true) continue;
    const ruled = !section.version.includes("-") && oldest !== null && compareCores(core, oldest) !== 0;
    if (statement === "" && (!hasDependencyLine(section) || (ruled && ruleGivesBreak(core)))) fault("no-statement");
    else if (statement !== "" && namesOnlyKind(statement)) fault("version-kind-only");
    if (!ruled) continue;
    const marked = sectionMarksBreak(section.body.join("\n"));
    if (ruleGivesBreak(core) && !marked) fault("break-unmarked");
    else if (!ruleGivesBreak(core) && marked) fault("mark-without-break");
  }
  return faults;
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

/** This function gives the versions of the headings of a changelog, in the order of the file. Another heading is not a version. */
export function changelogVersions(markdown: string): string[] {
  return parseChangelog(markdown).map((section) => section.version);
}
