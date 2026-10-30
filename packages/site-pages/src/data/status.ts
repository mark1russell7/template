/**
 * The status data: the open work of a roadmap file, and the open pull requests and issues of a
 * GitHub repository. The build reads both, so the page shows the state at the time of the build.
 *
 * @remarks The roadmap parser reads two forms. The first form is each Markdown table with an `ID`
 * column and a `Status` column. The second form is each heading "### `id`: Title" under a "##" heading
 * that gives the status. The parser is strict: a row whose cells do not match the header stops the
 * build with the file and the line.
 */

import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { githubOpenWork } from "./github.ts";
import type { BoardItem, GitHubOpenWork, Link, StatusBoardData, StatusClass } from "./types.ts";

/** The classes of a status, in the sequence of the board. The open work comes first. */
export const STATUS_CLASSES: readonly StatusClass[] = ["waiting", "blocked", "progress", "open", "later", "done"];

/** The open classes, in the sequence of the board. */
export const OPEN_CLASSES: readonly StatusClass[] = ["waiting", "blocked", "progress", "open", "later"];

/** An error in the roadmap file, with the file and the line. */
export class RoadmapParseError extends Error {}

// The keywords of each class. In a status text, the first keyword wins: "done, needs a release" is
// done, and "blocked, waits for X" is blocked. A negation ("not started") comes first, so that the
// word after it does not count.
const STATUS_KEYWORDS: ReadonlyArray<[StatusClass, RegExp]> = [
  ["open", /\bnot\s+(?:yet\s+)?(?:started|done|fixed|merged|shipped|released)\b|\bto[ -]?do\b/],
  // A closed item that did not ship ("never", "dropped") is not open work either
  ["done", /\b(?:done|shipped|merged|fixed|released|complete|completed|closed|never|dropped|cancell?ed|wontfix)\b|\bwon't do\b/],
  ["progress", /\bin[ -]progress\b|\b(?:active|ongoing|started|wip)\b/],
  ["waiting", /\b(?:waiting|waits|awaiting|needs)\b/],
  ["blocked", /\bblocked\b/],
  ["later", /\b(?:later|deferred|postponed|someday)\b/],
];

/**
 * This function gives the class of a free-text status: done, progress, waiting, blocked, later or
 * open. The first keyword of the text decides. A text without a keyword ("next", "open") is open.
 */
export function statusClassOf(text: string | null | undefined): StatusClass {
  const lower = String(text ?? "").toLowerCase();
  let best: { index: number; value: StatusClass } = { index: Infinity, value: "open" };
  for (const [value, pattern] of STATUS_KEYWORDS) {
    const match = pattern.exec(lower);
    if (match && match.index < best.index) best = { index: match.index, value };
  }
  return best.value;
}

/** This function gives the cells of a table row. A "|" in a code span or after "\" is text. */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let code = false;
  const text = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\" && text[index + 1] === "|") {
      cell += "|";
      index++;
    } else if (char === "`") {
      code = !code;
      cell += char;
    } else if (char === "|" && !code) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** A whitespace character, as `\s` of a regular expression and `String.prototype.trim` read it. */
const SPACE = /\s/;
/** A character that `.` of a regular expression does not match. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
/** The first whitespace character at or after `lastIndex`. */
const NEXT_SPACE = /\s/g;

/**
 * This function replaces each Markdown link `[label](target)` of a text with the result of
 * `replace`. The label ends at the first `]`, and the target ends at the first `)`. In `strict`
 * mode, the label and the target are not empty, and the target has no whitespace.
 *
 * @remarks The function reads the text one time. A regular expression for these links can
 * backtrack (CodeQL `js/polynomial-redos`). For a long text with many `[` characters, its time
 * grows with the square of the length.
 */
function replaceLinks(text: string, strict: boolean, replace: (label: string, target: string) => string): string {
  let result = "";
  let copied = 0;
  // The first "]" after the current "[", the first ")" after its "](", and the first whitespace
  // after its "](". The values only increase, so each search starts where the last one stopped.
  let close = -1;
  let end = -1;
  let space = -1;
  for (let open = text.indexOf("["); open !== -1; open = text.indexOf("[", open + 1)) {
    if (close <= open) close = text.indexOf("]", open + 1);
    if (close === -1) break;
    if (text[close + 1] !== "(" || (strict && close === open + 1)) continue;
    const start = close + 2;
    if (end < start) end = text.indexOf(")", start);
    if (end === -1) break;
    if (strict) {
      if (space !== Infinity && space < start) {
        NEXT_SPACE.lastIndex = start;
        space = NEXT_SPACE.exec(text)?.index ?? Infinity;
      }
      if (end === start || space < end) continue;
    }
    result += text.slice(copied, open) + replace(text.slice(open + 1, close), text.slice(start, end));
    copied = end + 1;
    open = end;
  }
  return result + text.slice(copied);
}

/**
 * This function gives the text of an ATX heading without its closing sequence: the whitespace,
 * then the `#` characters, then the whitespace at the end. It gives null when the rest has a line
 * terminator, as the regular expression `(.*?)\s*#*\s*$` does.
 */
function closeHeading(text: string): string | null {
  let end = text.length;
  while (end > 0 && SPACE.test(text[end - 1] ?? "")) end--;
  while (end > 0 && text[end - 1] === "#") end--;
  while (end > 0 && SPACE.test(text[end - 1] ?? "")) end--;
  const rest = text.slice(0, end);
  return LINE_TERMINATOR.test(rest) ? null : rest;
}

/** The start of an ATX heading. The text after the whitespace goes to `closeHeading`. */
const HEADING = /^(#{1,6})\s+(\S[\s\S]*)?$/;

/** This function gives the level and the text of an ATX heading line, or null for another line. */
function headingOf(line: string): { level: number; text: string } | null {
  const match = HEADING.exec(line);
  const text = match ? closeHeading(match[2] ?? "") : null;
  return match && text !== null ? { level: match[1]?.length ?? 0, text } : null;
}

/** This function gives the plain text of inline Markdown: no code marks, no emphasis, the text of each link. */
export function plainText(markdown: string | null | undefined): string {
  return replaceLinks(String(markdown ?? ""), false, (label) => label)
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A cell with no value: empty, or a dash. */
function isEmpty(cell: string | undefined): boolean {
  return cell === undefined || /^(?:[-–—]|n\/a)?$/i.test(cell.trim());
}

/** A table of a Markdown file. */
export interface MarkdownTable {
  /** The nearest heading above the table, as plain text. */
  section: string;
  /** The line of the header. */
  line: number;
  /** The header names, in lowercase plain text. */
  header: string[];
  rows: Array<{ line: number; cells: string[] }>;
}

/**
 * This function gives the tables of a Markdown file. Each table has its header names in lowercase
 * plain text, the nearest heading above it, the line of its header and its rows. Fenced code is not read.
 */
export function markdownTables(markdown: string): MarkdownTable[] {
  const lines = String(markdown).split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  let section = "";
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceMark !== undefined) {
      if (fence === null) fence = fenceMark[0] ?? null;
      else if (fenceMark[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = headingOf(line);
    if (heading) {
      section = plainText(heading.text);
      continue;
    }
    if (!line.trim().startsWith("|")) continue;
    const separator = lines[index + 1] ?? "";
    if (!/^\s*(?:\|\s*)?:?-{3,}/.test(separator)) continue;
    const header = splitRow(line).map((name) => plainText(name).toLowerCase());
    const rows: MarkdownTable["rows"] = [];
    let next = index + 2;
    for (; next < lines.length && (lines[next] ?? "").trim().startsWith("|"); next++) {
      rows.push({ line: next + 1, cells: splitRow(lines[next] ?? "") });
    }
    tables.push({ section, line: index + 1, header, rows });
    index = next - 1;
  }
  return tables;
}

/** The options of the link functions. */
export interface LinkOptions {
  /** The path of the roadmap file in the repository. */
  file?: string;
  /** "owner/name" of the repository. */
  repository?: string;
  /** The branch or the commit of the relative links. The default is "HEAD". */
  ref?: string;
}

/** The columns whose cells hold the links of an item. */
const LINK_COLUMNS = ["where", "commit", "commits", "link", "links", "pr", "prs"];
/** Words before a reference that do not name a repository. */
const NOT_REPOSITORIES = new Set(
  "a an and also at by commit commits done fixed for from in into issue issues merged of on or plus pr prs run see the then to via with".split(" "),
);

/** The URL of a link target of the roadmap file: an absolute URL stays, and a relative one goes to GitHub. */
function linkUrl(target: string, { file = "", repository = "", ref = "HEAD" }: LinkOptions): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
  if (!repository) return null;
  const [path = "", anchor = ""] = target.split("#", 2);
  const resolved = path === "" ? file : posix.normalize(posix.join(posix.dirname(file), path));
  if (resolved.startsWith("..")) return null;
  return `https://github.com/${repository}/blob/${ref}/${resolved}${anchor ? `#${anchor}` : ""}`;
}

/**
 * This function gives the word right before the whitespace that ends `text.slice(0, end)`, as the
 * regular expression `([A-Za-z][\w.-]*)\s+$` does. The word starts with a letter. The function
 * reads only the characters of the word and of the whitespace.
 */
function wordBefore(text: string, end: number): string | undefined {
  let stop = end;
  while (stop > 0 && SPACE.test(text[stop - 1] ?? "")) stop--;
  if (stop === end) return undefined;
  let start = stop;
  while (start > 0 && /[\w.-]/.test(text[start - 1] ?? "")) start--;
  while (start < stop && !/[A-Za-z]/.test(text[start] ?? "")) start++;
  return start < stop ? text.slice(start, stop) : undefined;
}

/**
 * This function gives the links of a cell: each Markdown link, then each bare reference in the rest
 * of the text. A reference is a pull request ("PR #12", "#12") or a commit hash in a code span.
 *
 * @remarks A repository name right before a reference ("systems PR #16") applies to it and to the
 * next references of the cell. Without a name, a reference belongs to `repository`.
 */
export function linksOf(cell: string | null | undefined, options: LinkOptions = {}): Link[] {
  const { repository = "" } = options;
  const links: Link[] = [];
  const seen = new Set<string>();
  const add = (label: string, url: string | null): void => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    links.push({ label, url });
  };
  const rest = replaceLinks(String(cell ?? ""), true, (label, target) => {
    add(plainText(label), linkUrl(target, options));
    return " ";
  });
  if (!repository) return links;
  const [owner, defaultRepo] = repository.split("/");
  let current = defaultRepo;
  // After "PR", the next numbers of the cell are pull requests too: "PRs #28, #29 and #30"
  let pulls = false;
  const reference = /\bPRs?\s*#(\d+)|(?<![\w/&])#(\d+)\b|`([0-9a-f]{7,40})`/g;
  for (let match = reference.exec(rest); match; match = reference.exec(rest)) {
    const word = wordBefore(rest, match.index);
    if (word && !NOT_REPOSITORIES.has(word.toLowerCase())) current = word;
    const prefix = current === defaultRepo ? "" : `${current} `;
    if (match[1] !== undefined) pulls = true;
    const number = match[1] ?? match[2];
    if (number !== undefined) add(`${prefix}#${number}`, `https://github.com/${owner}/${current}/${pulls ? "pull" : "issues"}/${number}`);
    else if (match[3] !== undefined) add(`${prefix}${match[3].slice(0, 7)}`, `https://github.com/${owner}/${current}/commit/${match[3]}`);
  }
  return links;
}

/**
 * The heading of an item: "### `id`: Title". A dash can take the place of the colon. The title goes
 * to `closeHeading`.
 */
const ITEM_HEADING = /^###\s+`([^`]+)`\s*[:–—-]\s*(\S[\s\S]*)?$/;
/** The other heading of an item: "### S1 · Title". The ID is one word before the middle dot. */
const ITEM_HEADING_DOT = /^###\s+([A-Za-z0-9][\w.-]*)\s+·\s+(\S[\s\S]*)?$/;

/** This function gives the ID and the title of an item heading, or null for another line. */
function itemHeadingOf(line: string): { id: string; title: string } | null {
  for (const pattern of [ITEM_HEADING, ITEM_HEADING_DOT]) {
    const match = pattern.exec(line);
    const title = match ? closeHeading(match[2] ?? "") : null;
    if (match && title !== null) return { id: match[1] ?? "", title };
  }
  return null;
}

/**
 * A field of an item heading: "- Area: Docs", "- **Area:** Docs" or "- **Area**: Docs". The label
 * matches without case.
 */
const ITEM_FIELD = /^\s*[-*]\s+(\*\*|__)?([A-Za-z][A-Za-z ]*?)(?::\1|\1:)\s*(\S.*)?$/;
/** The fields of an item heading that give the optional fields of an item. */
const ITEM_FIELDS: Readonly<Record<string, "area" | "owner" | "needs">> = {
  area: "area",
  owner: "owner",
  "waits for": "needs",
  needs: "needs",
  "depends on": "needs",
};

/**
 * This function gives the items of the second form of a roadmap: each heading "### `id`: Title" or
 * "### id · Title". The list item "Status:" gives the status. Without it, the "##" heading above
 * the item gives the status, for example "Waiting on Mark", "Later" or "Shipped". A heading without
 * a status is not an item.
 *
 * The list items "Area:", "Owner:" and "Waits for:" give the optional fields. The list item
 * "Links:" and the other list items give the links. Fenced code is not read.
 */
function headingItems(markdown: string, options: LinkOptions & { file: string }): BoardItem[] {
  const lines = String(markdown).split(/\r?\n/);
  const items: BoardItem[] = [];
  let section = "";
  let current: BoardItem | undefined;
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceMark !== undefined) {
      if (fence === null) fence = fenceMark[0] ?? null;
      else if (fenceMark[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = headingOf(line);
    if (heading) {
      const { level } = heading;
      if (level > 3) continue;
      current = undefined;
      if (level === 2) section = plainText(heading.text);
      if (level === 1) section = "";
      if (level !== 3) continue;
      const item = itemHeadingOf(line);
      const id = plainText(item?.id);
      if (!item || isEmpty(id)) continue;
      current = { id, title: item.title, status: section, statusClass: statusClassOf(section), section, line: index + 1, links: [] };
      items.push(current);
      continue;
    }
    if (!current) continue;
    const field = ITEM_FIELD.exec(line);
    const label = (field?.[2] ?? "").trim().toLowerCase();
    const value = (field?.[3] ?? "").trim();
    const key = field ? ITEM_FIELDS[label] : undefined;
    if (field && label === "status") {
      // The field of the item wins over the section
      if (!isEmpty(value)) {
        current.status = value;
        current.statusClass = statusClassOf(plainText(value));
      }
    } else if (field && key !== undefined) {
      if (!isEmpty(value)) current[key] = value;
    } else if (/^\s*[-*]\s+/.test(line)) {
      const seen = new Set(current.links.map((link) => link.url));
      for (const link of linksOf(line, options)) if (!seen.has(link.url)) current.links.push(link);
    }
  }
  // A heading without a section and without a "Status:" field has no status: it is not an item
  return items.filter((item) => item.status !== "");
}

/**
 * This function gives the items of a roadmap file in the order of the file. It reads two forms:
 *
 * - Each row of each table with an `ID` column and a `Status` column. The header names match without
 *   case. The title comes from `Item`, else from `Title`. `Owner`, `Area` and `Needs` are optional.
 *   `Where`, `Commit` and `Links` give the links.
 * - Each heading "### `id`: Title" or "### id · Title". The list item "Status:", else the "##"
 *   heading above it, gives the status. The list items "Area:", "Owner:" and "Waits for:" give the
 *   optional fields, and "Links:" and the other list items give the links.
 *
 * @throws RoadmapParseError when the cells of a row do not match the header
 */
export function roadmapItems(markdown: string, options: LinkOptions = {}): BoardItem[] {
  const { file = "ROADMAP.md" } = options;
  const items: BoardItem[] = [];
  for (const table of markdownTables(markdown)) {
    const column = (...names: string[]): number => names.map((name) => table.header.indexOf(name)).find((index) => index >= 0) ?? -1;
    const id = column("id");
    const status = column("status");
    if (id < 0 || status < 0) continue;
    const title = column("item", "title");
    const owner = column("owner");
    const area = column("area");
    const needs = column("needs");
    const linkColumns = LINK_COLUMNS.map((name) => table.header.indexOf(name)).filter((index) => index >= 0);
    for (const row of table.rows) {
      if (row.cells.length !== table.header.length) {
        throw new RoadmapParseError(`${file}:${row.line}: the row has ${row.cells.length} cells, and the header has ${table.header.length}`);
      }
      const idText = plainText(row.cells[id]);
      if (isEmpty(idText)) continue;
      const statusText = row.cells[status] ?? "";
      const item: BoardItem = {
        id: idText,
        title: title >= 0 ? (row.cells[title] ?? "") : "",
        status: statusText,
        statusClass: statusClassOf(plainText(statusText)),
        section: table.section,
        line: row.line,
        links: linkColumns.flatMap((index) => linksOf(row.cells[index], { ...options, file })),
      };
      const optional = (index: number): string | undefined => (index >= 0 && !isEmpty(row.cells[index]) ? row.cells[index] : undefined);
      const ownerText = optional(owner);
      const areaText = optional(area);
      const needsText = optional(needs);
      if (ownerText !== undefined) item.owner = ownerText;
      if (areaText !== undefined) item.area = areaText;
      if (needsText !== undefined) item.needs = needsText;
      items.push(item);
    }
  }
  const headings = headingItems(markdown, { ...options, file });
  return headings.length === 0 ? items : [...items, ...headings].sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/** The input of `buildStatusBoard`. */
export interface StatusBoardInput {
  items: BoardItem[];
  /** The result of `githubOpenWork`. */
  github: GitHubOpenWork;
  /** The roadmap file in the repository, or null without a roadmap. */
  roadmap: string | null;
  /** "owner/name" of the repository. */
  repository: string;
  commit?: string | null;
  generatedAt?: string;
}

/**
 * This function gives the items of a roadmap file, as the Status page reads them. It fails when the file has no item.
 *
 * @throws RoadmapParseError when the cells of a row do not match the header
 * @throws RoadmapParseError when the roadmap has no item: no table with an ID and a Status column, and no item heading
 */
export function parseRoadmap(markdown: string, options: LinkOptions = {}): BoardItem[] {
  const { file = "ROADMAP.md" } = options;
  const items = roadmapItems(markdown, options);
  if (items.length === 0) throw new RoadmapParseError(`${file}: no table with an ID column and a Status column, and no heading "### \`id\`: Title"`);
  return items;
}

/** This function puts the roadmap items and the GitHub part into the shape of `status.json`. */
export function buildStatusBoard(input: StatusBoardInput): StatusBoardData {
  const { items, github, roadmap, repository, commit = null, generatedAt = new Date().toISOString() } = input;
  return {
    generatedAt,
    commit,
    source: { roadmap, github: repository },
    items,
    pullRequests: github.available ? github.pullRequests : [],
    issues: github.available ? github.issues : [],
    github: github.available ? { available: true, totals: github.totals } : { available: false, reason: github.reason },
  };
}

/** The options of `readStatusBoard`. */
export interface ReadStatusBoardOptions {
  repoDir: string;
  /** The path of the roadmap file from `repoDir`, with `/`. Without it, the board has only the GitHub part. */
  roadmap?: string | null | undefined;
  owner: string;
  repo: string;
  token: string | undefined;
  /** The commit of the build. The relative links of the roadmap go to it. */
  commit?: string | null | undefined;
  fetch?: typeof fetch | undefined;
  generatedAt?: string | undefined;
}

/**
 * This function reads the board of a repository on disk: the roadmap file, and the open work on GitHub.
 *
 * @throws RoadmapParseError when the roadmap has an incorrect row, or no item: no table with an ID
 * and a Status column, and no item heading
 */
export async function readStatusBoard(options: ReadStatusBoardOptions): Promise<StatusBoardData> {
  const { repoDir, roadmap = null, owner, repo, token, commit = null } = options;
  const repository = `${owner}/${repo}`;
  let items: BoardItem[] = [];
  if (roadmap) {
    const markdown = readFileSync(join(repoDir, ...roadmap.split("/")), "utf8");
    items = parseRoadmap(markdown, { file: roadmap, repository, ref: commit ?? "HEAD" });
  }
  const github = await githubOpenWork({ owner, repo, token, ...(options.fetch ? { fetch: options.fetch } : {}) });
  return buildStatusBoard({
    items,
    github,
    roadmap: roadmap || null,
    repository,
    commit,
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
  });
}
