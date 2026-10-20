/**
 * The status data: the open work of a roadmap file, and the open pull requests and issues of a
 * GitHub repository. The build reads both, so the page shows the state at the time of the build.
 *
 * @remarks The roadmap parser reads each Markdown table with an `ID` column and a `Status` column.
 * It is strict: a row whose cells do not match the header stops the build with the file and the line.
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
  ["done", /\b(?:done|shipped|merged|fixed|released|complete|completed|closed)\b/],
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

/** This function gives the plain text of inline Markdown: no code marks, no emphasis, the text of each link. */
export function plainText(markdown: string | null | undefined): string {
  return String(markdown ?? "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A cell with no value: empty, or a dash. */
function isEmpty(cell: string | undefined): boolean {
  return cell === undefined || /^\s*(?:[-–—]|n\/a)?\s*$/i.test(cell);
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
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      section = plainText(heading[1]);
      continue;
    }
    if (!line.trim().startsWith("|")) continue;
    const separator = lines[index + 1] ?? "";
    if (!/^\s*\|?\s*:?-{3,}/.test(separator)) continue;
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
  const rest = String(cell ?? "").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, target: string) => {
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
    const word = /([A-Za-z][\w.-]*)\s+$/.exec(rest.slice(0, match.index))?.[1];
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
 * This function gives the items of a roadmap file: one item for each row of each table with an `ID`
 * column and a `Status` column. The header names match without case.
 *
 * @remarks The title comes from `Item`, else from `Title`. `Owner`, `Area` and `Needs` are optional.
 * `Where`, `Commit` and `Links` give the links.
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
  return items;
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
 * @throws RoadmapParseError when the roadmap has an incorrect row, or no table with an ID and a Status column
 */
export async function readStatusBoard(options: ReadStatusBoardOptions): Promise<StatusBoardData> {
  const { repoDir, roadmap = null, owner, repo, token, commit = null } = options;
  const repository = `${owner}/${repo}`;
  let items: BoardItem[] = [];
  if (roadmap) {
    const markdown = readFileSync(join(repoDir, ...roadmap.split("/")), "utf8");
    items = roadmapItems(markdown, { file: roadmap, repository, ref: commit ?? "HEAD" });
    if (items.length === 0) throw new RoadmapParseError(`${roadmap}: no table with an ID column and a Status column`);
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
