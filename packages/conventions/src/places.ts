/**
 * The places of a repository that name another repository: links, package fields, workflow keys and config values.
 * When a repository moves to another owner, each such place that names the old owner is stale. Some places break at
 * once. npm provenance compares the field `repository` with the repository of the run. A GitHub Pages address of the
 * old owner gives 404. A `uses:` line does not follow the move (the rule `moved-repo-calls` holds that kind). The other
 * places go through a redirect only until a new repository takes the old name.
 *
 * A kind of place is data: its id, the files it reads and a pure function. The function finds each place in a file.
 * The rule `moved-repo-names` and the move plan read the same kinds. This file reads no file and starts no program.
 */
import { movedTo, type RepoMove } from "./moves.ts";
import { keyValue, WORKFLOW } from "./workflow.ts";

/** One place in a file that names a repository: the line (from 1), the column (from 0) and the text of the name. */
export interface NamedRepo {
  readonly line: number;
  readonly column: number;
  /** The text as the file writes it: `owner/name`, or `owner.github.io/name` for a Pages address. */
  readonly text: string;
  /** The repository, `owner/name` in lower case. */
  readonly repo: string;
  /** The form of the text: `repo` for `owner/name`, `pages` for a GitHub Pages address `owner.github.io/name`. */
  readonly form: "repo" | "pages";
}

/** A kind of place: the files it reads, and the function that finds each name of a repository in one file. */
export interface PlaceKind {
  /** A short id in kebab case. */
  readonly id: string;
  /** What the kind finds, in one sentence. */
  readonly title: string;
  /** This function tells if the kind reads the file (a path relative to the root, with `/`). */
  readonly reads: (file: string) => boolean;
  /** This function gives each name of a repository in the text of the file. */
  readonly find: (text: string, file: string) => readonly NamedRepo[];
}

/** A place that names a moved repository by an old name, with the name to write in its place. */
export interface StalePlace extends NamedRepo {
  readonly kind: string;
  readonly file: string;
  /** The new repository, `owner/name` in lower case. */
  readonly to: string;
  /** The text to write in place of `text`. */
  readonly replacement: string;
}

/** An owner or a name of a repository on GitHub. */
const PART = "[A-Za-z0-9_.-]+";

/**
 * A repository in a URL or a specifier: `github.com/owner/name`, `github.com:owner/name` (SSH) and `github:owner/name`.
 * The name stops before `/`, `#`, `?`, a quote, a bracket, a space or the end.
 */
const HOSTED = new RegExp(`(?<![\\w.-])(?:github\\.com[/:]|github:)(${PART})/(${PART})`, "gd");

/** A GitHub Pages address of a project: `owner.github.io/name`. */
const PAGES = new RegExp(`(?<![\\w.-])(${PART})\\.github\\.io/(${PART})`, "gd");

/** The paths of GitHub that are not owners. */
const NOT_OWNERS = new Set(["orgs", "users", "settings", "marketplace", "features", "sponsors", "apps", "topics", "collections", "login", "about", "pricing"]);

/** This function gives the name of a repository without the end `.git` and without dots at the end (the end of a sentence). */
function bareName(name: string): string {
  return name.replace(/\.git$/i, "").replace(/\.+$/, "");
}

/** This function gives each match of `pattern` in the lines of `text`, as a name of a repository. The pattern has the flag d, and the place starts at its group 1 (the owner). */
function matches(text: string, pattern: RegExp, form: NamedRepo["form"], skip: (line: string) => boolean = () => false): NamedRepo[] {
  const found: NamedRepo[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (skip(line)) return;
    for (const match of line.matchAll(pattern)) {
      const owner = match[1] ?? "";
      const name = bareName(match[2] ?? "");
      if (name === "" || NOT_OWNERS.has(owner.toLowerCase())) continue;
      const written = form === "pages" ? `${owner}.github.io/${name}` : `${owner}/${name}`;
      const column = match.indices?.[1]?.[0] ?? 0;
      found.push({ line: index + 1, column, text: written, repo: `${owner}/${name}`.toLowerCase(), form });
    }
  });
  return found;
}

/** This function gives each GitHub address and each Pages address in a text. */
function links(text: string, skip?: (line: string) => boolean): NamedRepo[] {
  return [...matches(text, HOSTED, "repo", skip), ...matches(text, PAGES, "pages", skip)].sort(
    (a, b) => a.line - b.line || a.column - b.column,
  );
}

/** This function gives each value `"owner/name"` of a key in a JSON text, for a key that names a repository with no host. */
function bareValues(text: string, keys: readonly string[]): NamedRepo[] {
  const pattern = new RegExp(`"(?:${keys.join("|")})"\\s*:\\s*"(${PART})/(${PART})"`, "gd");
  return matches(text, pattern, "repo");
}

/** The file of a package. */
const MANIFEST = /(^|\/)package\.json$/;

/** A Markdown file. A change log is a record of the past: its links go through the redirect, so the kinds do not read it. */
const MARKDOWN = /\.mdx?$/i;
const CHANGELOG = /(^|\/)CHANGELOG\.md$/i;

/** A file of a composite action. */
const ACTION = /^\.github\/actions\/.+\/action\.ya?ml$/;

/** The kinds of place of the core, in the order of a report. */
export const PLACE_KINDS: readonly PlaceKind[] = [
  {
    id: "package-fields",
    title: "The fields repository, homepage and bugs and the git dependencies of each package.json. npm provenance compares the field repository with the repository of the run.",
    reads: (file) => MANIFEST.test(file),
    find: (text) => [...links(text), ...bareValues(text, ["repository"])],
  },
  {
    id: "doc-links",
    title: "The links, the badges and the Pages addresses of each Markdown file, except a change log.",
    reads: (file) => MARKDOWN.test(file) && !CHANGELOG.test(file),
    find: (text) => links(text),
  },
  {
    id: "workflow-names",
    title: "The addresses and each key repository of a workflow or a composite action, except uses: (the rule moved-repo-calls).",
    reads: (file) => WORKFLOW.test(file) || ACTION.test(file),
    find: (text) => {
      const skip = (line: string): boolean => line.trimStart().startsWith("#") || keyValue(line, "uses") !== undefined;
      const keys: NamedRepo[] = [];
      text.split(/\r?\n/).forEach((line, index) => {
        if (skip(line)) return;
        const value = keyValue(line, "repository");
        const match = value === undefined ? null : new RegExp(`^(${PART})/(${PART})$`).exec(value);
        if (match === null) return;
        const written = `${match[1] ?? ""}/${match[2] ?? ""}`;
        keys.push({ line: index + 1, column: line.indexOf(written), text: written, repo: written.toLowerCase(), form: "repo" });
      });
      return [...links(text, skip), ...keys].sort((a, b) => a.line - b.line || a.column - b.column);
    },
  },
  {
    id: "config-repos",
    title: "The key repo of the change log of Changesets, and the addresses in the config of Renovate.",
    reads: (file) => file === ".changeset/config.json" || /^(\.github\/)?renovate\.json5?$/.test(file),
    find: (text) => [...links(text), ...bareValues(text, ["repo"])],
  },
];

/**
 * This function gives each place of a file that names a moved repository by an old name. A name that the moves do not
 * know is not stale. The replacement keeps the form of the place: `owner/name` or `owner.github.io/name`.
 */
export function stalePlaces(file: string, text: string, moves: readonly RepoMove[], kinds: readonly PlaceKind[] = PLACE_KINDS): StalePlace[] {
  const found: StalePlace[] = [];
  for (const kind of kinds) {
    if (!kind.reads(file)) continue;
    for (const named of kind.find(text, file)) {
      const to = movedTo(named.repo, moves);
      if (to === undefined) continue;
      const [owner = "", name = ""] = to.split("/");
      const replacement = named.form === "pages" ? `${owner}.github.io/${name}` : to;
      found.push({ ...named, kind: kind.id, file, to, replacement });
    }
  }
  return found;
}

/**
 * This function gives the text with each stale place replaced. A place whose text is not at its line and column (an
 * earlier replacement moved it) stays as it is, and the next check finds it again.
 */
export function replacePlaces(text: string, places: readonly StalePlace[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const order = [...places].sort((a, b) => a.line - b.line || b.column - a.column);
  for (const place of order) {
    const line = lines[place.line - 1];
    if (line === undefined || line.slice(place.column, place.column + place.text.length) !== place.text) continue;
    lines[place.line - 1] = line.slice(0, place.column) + place.replacement + line.slice(place.column + place.text.length);
  }
  return lines.join(eol);
}
