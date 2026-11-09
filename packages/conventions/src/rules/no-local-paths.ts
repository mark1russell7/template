/**
 * The rule `no-local-paths`: no tracked file names the home folder of a user of a computer. The commit messages of a
 * change and the title and the body of its pull request do not name one either. The same is true for each private
 * pattern of the environment variable `CONVENTIONS_PRIVATE_PATTERNS`. A break of a private pattern does not show the
 * text or the pattern, because a public log must not name them.
 *
 * The module also has the core of the command `conventions pre-push`. The core has the setting of the private name list,
 * the private patterns and the breaks of one text.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { rangeOf } from "../change.ts";
import { lineNameHit, pathNameHit, PRIVATE_NAME_LIST, type PrivateNameList } from "../private-names.ts";
import type { Break, Rule, RuleContext } from "../rule.ts";

/** The extensions of files that are not text. The rule does not read them. */
const BINARY = new Set(
  ".png .jpg .jpeg .gif .webp .avif .ico .bmp .tiff .pdf .zip .gz .tgz .bz2 .xz .7z .tar .woff .woff2 .ttf .otf .eot .mp3 .mp4 .webm .mov .wav .ogg .wasm .node .exe .dll .so .dylib .bin .db .sqlite .duckdb".split(
    " ",
  ),
);

/** The largest file that the rule reads, in bytes. */
const MAX_BYTES = 2 * 1024 * 1024;

/** The names in a home path that do not identify a person: CI users, container users and placeholders. */
export const DEFAULT_ALLOWED: readonly string[] = ["runner", "runneradmin", "user", "username", "you", "me", "name", "yourname", "your-name", "example", "node", "ubuntu", "vscode", "codespace", "public", "default", "shared", "all users"];

/** The forms of a home folder: Windows, macOS and Linux. The group `user` is the name of the user. */
export const HOME_PATTERNS: readonly RegExp[] = [
  // A Windows path does not depend on case, so `c:/users/<name>` is the same folder
  /\b[A-Za-z]:(?:\\{1,2}|\/)[Uu][Ss][Ee][Rr][Ss](?:\\{1,2}|\/)(?<user>[^\\/\s"'`<>|:*?%$(){}[\],;]+)/g,
  /(?<![\w.~-])\/Users\/(?<user>[^/\s"'`<>|:*?%$(){}[\],;]+)/g,
  /(?<![\w.~-])\/home\/(?<user>[^/\s"'`<>|:*?%$(){}[\],;]+)/g,
];

/** The name of the environment variable of the private patterns. */
export const PRIVATE_PATTERNS_VARIABLE = "CONVENTIONS_PRIVATE_PATTERNS";

/** The name of the environment variable of the path of the private name list. */
export const PRIVATE_NAMES_FILE_VARIABLE = "CONVENTIONS_PRIVATE_NAMES_FILE";

/** The key of the git configuration of the path of the private name list. */
export const PRIVATE_NAMES_FILE_CONFIG = "conventions.privateNamesFile";

/** A private pattern: one line of the environment variable `CONVENTIONS_PRIVATE_PATTERNS`. */
export interface PrivatePattern {
  /** The regular expression, as text. The check uses it with the flag `g`, and case is significant. */
  readonly source: string;
  /** The line of the pattern in its source, from 1. */
  readonly line: number;
  /** The name of the source in a break: `CONVENTIONS_PRIVATE_PATTERNS`. */
  readonly label: string;
}

/** The private sources of a check. A break of a private source does not show the text or the source. */
export interface PrivateSources {
  /** The private name list, from `parsePrivateNames`. */
  readonly names?: PrivateNameList;
  /** The private patterns, from `privatePatterns`. */
  readonly patterns?: readonly PrivatePattern[];
}

/** The options of `privateTextBreaks`. */
export interface TextBreakOptions {
  /** More user names that do not identify a person, after `DEFAULT_ALLOWED`. */
  readonly allow?: readonly string[];
  /** Public regular expressions, from the option `patterns`. A break of a public pattern shows the text. */
  readonly patterns?: readonly string[];
  /**
   * The value `true` tells that the text is the root `package.json`. Then the reason of an exception can quote a home
   * folder, and the line that names a public pattern is no break. A private pattern still counts there.
   */
  readonly rootPackage?: boolean;
  /** The value `false` turns off the breaks of home folders. The default is `true`. */
  readonly homes?: boolean;
  /** The line of the first line of the text, from 1. The default is 1. */
  readonly firstLine?: number;
  /** The repository of the text, `owner/name`. The list `allow` of the private name list uses it. */
  readonly repo?: string;
  /** The path of the file of the text, from the root of the repository. The list `allow` of the private name list uses it. */
  readonly path?: string;
  /** The value `true` tells that the text is a path of a file. Then only the patterns of the private name list apply. */
  readonly isPath?: boolean;
}

/** A pattern of text that no file has: from the option `patterns`, which is public, or a private pattern. */
interface Matcher {
  readonly regex: RegExp;
  /** The private pattern of the matcher. A public pattern has none. */
  readonly secret?: PrivatePattern;
}

/** The compiled patterns of a check. */
interface Matchers {
  readonly names?: PrivateNameList;
  readonly extra: readonly Matcher[];
  readonly allowed: ReadonlySet<string>;
  readonly homes: boolean;
}

/** This function gives the regular expression of a pattern, or undefined when the pattern is not valid. */
function compilePattern(source: string): RegExp | undefined {
  try {
    return new RegExp(source, "g");
  } catch {
    return undefined;
  }
}

/** This function compiles the patterns of a check. A private pattern that is not valid has no matcher. */
function compile(privates: PrivateSources, options: TextBreakOptions): Matchers {
  const extra: Matcher[] = (options.patterns ?? []).map((source) => ({ regex: new RegExp(source, "g") }));
  for (const pattern of privates.patterns ?? []) {
    const regex = compilePattern(pattern.source);
    if (regex !== undefined) extra.push({ regex, secret: pattern });
  }
  return {
    ...(privates.names === undefined ? {} : { names: privates.names }),
    extra,
    allowed: new Set([...DEFAULT_ALLOWED, ...(options.allow ?? [])].map((name) => name.toLowerCase())),
    homes: options.homes !== false,
  };
}

/** This function gives the breaks of one text with compiled patterns. */
function textBreaks(name: string, text: string, matchers: Matchers, options: TextBreakOptions): Break[] {
  const breaks: Break[] = [];
  const first = options.firstLine ?? 1;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const at = first + index;
    // The reason of an exception in the root package.json tells why a text is no home folder, so it can quote one
    const isReason = options.rootPackage === true && /^\s*"(?:reason|off)"\s*:/.test(line);
    if (matchers.homes && !isReason) {
      for (const pattern of HOME_PATTERNS) {
        for (const match of line.matchAll(pattern)) {
          const user = match.groups?.["user"] ?? "";
          // A name of one character is a placeholder of a test, not a person
          if (user.length < 2 || matchers.allowed.has(user.toLowerCase())) continue;
          breaks.push({ file: name, line: at, message: `The text "${match[0]}" is the home folder of a user.` });
        }
      }
    }
    if (matchers.names !== undefined) {
      const place = { ...(options.repo === undefined ? {} : { repo: options.repo }), ...(options.path === undefined ? {} : { path: options.path }) };
      const hit = options.isPath === true ? pathNameHit(matchers.names, line) : lineNameHit(matchers.names, line, place);
      if (hit !== undefined)
        breaks.push({
          file: name,
          line: at,
          message: `A text names name ${String(hit.name)} of ${PRIVATE_NAME_LIST}.`,
          fix: "Remove the text. The check does not show the text, because the name is private.",
        });
    }
    for (const matcher of matchers.extra) {
      // The option patterns of the root package.json names the pattern itself
      if (options.rootPackage === true && matcher.secret === undefined && line.trim().replace(/,$/, "") === JSON.stringify(matcher.regex.source)) continue;
      for (const match of line.matchAll(matcher.regex)) {
        breaks.push(
          matcher.secret === undefined
            ? { file: name, line: at, message: `The text "${match[0]}" matches the pattern ${matcher.regex.source}.`, fix: "Remove the text." }
            : {
                file: name,
                line: at,
                message: `A text matches the private pattern on line ${String(matcher.secret.line)} of ${matcher.secret.label}.`,
                fix: "Remove the text. The check does not show the text, because the pattern is private.",
              },
        );
      }
    }
  }
  return breaks;
}

/** This function gives the patterns of the lines of `text`, with the line of each (from 1). It skips empty lines. */
function patternLines(text: string, label: string): PrivatePattern[] {
  return text
    .split("\n")
    .map((source, index) => ({ source: source.trim(), line: index + 1, label }))
    .filter((pattern) => pattern.source !== "");
}

/** This function gives the private patterns of the environment variable, with the line of each (from 1). */
export function privatePatterns(env: Readonly<Record<string, string | undefined>>): PrivatePattern[] {
  return patternLines(env[PRIVATE_PATTERNS_VARIABLE] ?? "", PRIVATE_PATTERNS_VARIABLE);
}

/**
 * This function gives the path of the private name list: the environment variable `CONVENTIONS_PRIVATE_NAMES_FILE`,
 * else the git configuration `conventions.privateNamesFile`. It gives undefined when neither has a value.
 */
export function privateNamesFile(env: Readonly<Record<string, string | undefined>>, git: (args: readonly string[]) => string | undefined): string | undefined {
  const fromEnv = env[PRIVATE_NAMES_FILE_VARIABLE]?.trim() ?? "";
  if (fromEnv !== "") return fromEnv;
  // The type `path` expands `~` at the start of the value
  const fromGit = git(["config", "--type=path", "--get", PRIVATE_NAMES_FILE_CONFIG])?.trim() ?? "";
  return fromGit === "" ? undefined : fromGit;
}

/** This function gives a break for each private pattern that is not a valid regular expression. A break does not show the pattern. */
export function invalidPatternBreaks(patterns: readonly PrivatePattern[]): Break[] {
  return patterns
    .filter((pattern) => compilePattern(pattern.source) === undefined)
    .map((pattern) => ({
      file: pattern.label,
      line: pattern.line,
      message: `Line ${String(pattern.line)} of ${pattern.label} is not a valid regular expression.`,
      fix: "Correct the regular expression. The check does not show the pattern, because it is private.",
    }));
}

/**
 * This function gives the breaks of one text: a file, a commit message or the body of a pull request. Each break has the
 * file `name`. A break of a private source does not show the text, the name or the pattern. A line has one break or no
 * break of the private name list. The breaks of home folders use `HOME_PATTERNS` and the permitted names. A private pattern
 * that is not valid gives no break here: refer to `invalidPatternBreaks`.
 */
export function privateTextBreaks(name: string, text: string, privates: PrivateSources, options: TextBreakOptions = {}): Break[] {
  return textBreaks(name, text, compile(privates, options), options);
}

/** A text that the rule examines, other than a file: a commit message, or the title or the body of the pull request. */
export interface ChangeText {
  /** The name of the text in a break: `commit <sha>`, `pull request title` or `pull request body`. */
  readonly name: string;
  readonly text: string;
}

/**
 * This function gives the texts of the change that are not files. They are each commit message of a pull request (or of the
 * range of `--base`). They are also the title and the body of the pull request, from the event file of GitHub Actions.
 */
export function changeTexts(context: RuleContext): ChangeText[] {
  const texts: ChangeText[] = [];
  const range = rangeOf(context);
  if (!("skipped" in range)) {
    const log = context.git(["log", "--no-merges", "--format=%H%x00%B%x1e", ...range.log]) ?? "";
    for (const entry of log.split("\x1e")) {
      const [sha, message] = entry.replace(/^\s+/, "").split("\0");
      if (sha !== undefined && sha !== "" && message !== undefined) texts.push({ name: `commit ${sha.slice(0, 12)}`, text: message });
    }
  }
  const file = context.env["GITHUB_EVENT_PATH"];
  if (file !== undefined && file !== "" && existsSync(file)) {
    try {
      const event = JSON.parse(readFileSync(file, "utf8")) as { pull_request?: { title?: unknown; body?: unknown } };
      const title = event.pull_request?.title;
      const body = event.pull_request?.body;
      if (typeof title === "string") texts.push({ name: "pull request title", text: title });
      if (typeof body === "string") texts.push({ name: "pull request body", text: body });
    } catch {
      // An event file that does not parse has no pull request to examine
    }
  }
  return texts;
}

export const noLocalPaths: Rule = {
  id: "no-local-paths",
  title: "No tracked file, commit message of the change or text of its pull request has a private pattern or the home folder of a user (`C:\\Users\\<name>`, `/Users/<name>`, `/home/<name>`).",
  reason: "A public file must not name a computer, a user or a path of a computer. A local path also works only on one computer.",
  fix: "Use a path relative to the repository, `~`, an environment variable, or a placeholder such as `<you>`.",
  sources: [
    { repo: "client", rule: "I12", doc: "packages/documentation/ARCHITECTURE.md:201" },
    { repo: "systems", rule: "no-identifying-names", doc: "CLAUDE.md:12" },
    { repo: "systems", rule: "no-private-identifiers", doc: "CLAUDE.md:12" },
    { repo: "systems", rule: "no-private-names", doc: "CLAUDE.md:12" },
    { repo: "coeval", rule: "no-private-names", doc: "CLAUDE.md:22" },
  ],
  options: {
    allow: { type: "strings", default: [], description: "More user names that do not identify a person." },
    patterns: {
      type: "strings",
      default: [],
      description: "More regular expressions of text that no file has. The environment variable CONVENTIONS_PRIVATE_PATTERNS adds one on each line, so a private name stays out of package.json.",
    },
  },
  check(context, options) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const settings: TextBreakOptions = {
      allow: Array.isArray(options["allow"]) ? [...options["allow"]] : [],
      patterns: Array.isArray(options["patterns"]) ? [...options["patterns"]] : [],
    };
    // A repository keeps private names out of its public files with the environment variable, for example from a secret of CI
    const privates = privatePatterns(context.env);
    const matchers = compile({ patterns: privates }, settings);
    const rootFile = context.rootPackage.file;
    // A private pattern that is not valid is a break of its own, not an error of the rule: an error message shows the pattern
    const breaks: Break[] = invalidPatternBreaks(privates);
    const add = (items: readonly Break[]): void => {
      for (const item of items) breaks.push(item);
    };
    for (const file of files) {
      if (BINARY.has(extname(file).toLowerCase())) continue;
      const path = join(context.root, file);
      let text: string;
      try {
        if (statSync(path).size > MAX_BYTES) continue;
        text = readFileSync(path, "utf8");
      } catch {
        // A file of the index that is not in the working tree
        continue;
      }
      if (text.includes("\0")) continue;
      add(textBreaks(file, text, matchers, { rootPackage: file === rootFile }));
    }
    // A commit message and the text of a pull request are public too, and a merged commit message stays in the history
    for (const change of changeTexts(context)) add(textBreaks(change.name, change.text, matchers, {}));
    return breaks;
  },
};
