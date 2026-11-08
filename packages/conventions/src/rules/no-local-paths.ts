/**
 * The rule `no-local-paths`: no tracked file names the home folder of a user of a computer. The commit messages of a
 * change and the title and the body of its pull request do not name one either. The same is true for each private
 * pattern of the environment variable `CONVENTIONS_PRIVATE_PATTERNS`. A break of a private pattern does not show the
 * text or the pattern, because a public log must not name them.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { rangeOf } from "../change.ts";
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

/** A pattern of text that no file has: from the option `patterns`, which is public, or from the environment, which is private. */
interface ExtraPattern {
  readonly regex: RegExp;
  /** The line of the pattern in the environment variable (from 1), for a private pattern. */
  readonly privateLine?: number;
}

/** A text that the rule examines, other than a file: a commit message, or the title or the body of the pull request. */
export interface ChangeText {
  /** The name of the text in a break: `commit <sha>`, `pull request title` or `pull request body`. */
  readonly name: string;
  readonly text: string;
}

/** This function gives the private patterns of the environment variable, with the line of each (from 1). */
export function privatePatterns(env: Readonly<Record<string, string | undefined>>): { readonly source: string; readonly line: number }[] {
  return (env[PRIVATE_PATTERNS_VARIABLE] ?? "")
    .split("\n")
    .map((source, index) => ({ source: source.trim(), line: index + 1 }))
    .filter((pattern) => pattern.source !== "");
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
    const allowed = new Set([...DEFAULT_ALLOWED, ...(Array.isArray(options["allow"]) ? options["allow"] : [])].map((name) => name.toLowerCase()));
    // A repository keeps private names out of its public files with the environment variable, for example from a secret of CI
    const extra: ExtraPattern[] = [
      ...(Array.isArray(options["patterns"]) ? options["patterns"] : []).map((source) => ({ regex: new RegExp(source, "g") })),
      ...privatePatterns(context.env).map((pattern) => ({ regex: new RegExp(pattern.source, "g"), privateLine: pattern.line })),
    ];
    const rootFile = context.rootPackage.file;
    const breaks: Break[] = [];
    /** This function adds the breaks of the extra patterns on one line. A break of a private pattern shows no text. */
    const extraBreaks = (file: string, line: string, at: number, isRootFile: boolean): void => {
      for (const pattern of extra) {
        // The option patterns of the root package.json names the pattern itself
        if (isRootFile && pattern.privateLine === undefined && line.trim().replace(/,$/, "") === JSON.stringify(pattern.regex.source)) continue;
        for (const match of line.matchAll(pattern.regex)) {
          breaks.push(
            pattern.privateLine === undefined
              ? { file, line: at, message: `The text "${match[0]}" matches the pattern ${pattern.regex.source}.`, fix: "Remove the text." }
              : { file, line: at, message: `A text matches the private pattern on line ${String(pattern.privateLine)} of ${PRIVATE_PATTERNS_VARIABLE}.`, fix: "Remove the text. The check does not show the text, because the pattern is private." },
          );
        }
      }
    };
    /** This function adds the breaks of the home folders on one line. */
    const homeBreaks = (file: string, line: string, at: number): void => {
      for (const pattern of HOME_PATTERNS) {
        for (const match of line.matchAll(pattern)) {
          const user = match.groups?.["user"] ?? "";
          // A name of one character is a placeholder of a test, not a person
          if (user.length < 2 || allowed.has(user.toLowerCase())) continue;
          breaks.push({ file, line: at, message: `The text "${match[0]}" is the home folder of a user.` });
        }
      }
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
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";
        // The reason of an exception in the root package.json tells why a text is no home folder, so it can quote one. A private pattern still counts there
        const isReason = file === rootFile && /^\s*"(?:reason|off)"\s*:/.test(line);
        if (!isReason) homeBreaks(file, line, index + 1);
        extraBreaks(file, line, index + 1, file === rootFile);
      }
    }
    // A commit message and the text of a pull request are public too, and a merged commit message stays in the history
    for (const change of changeTexts(context)) {
      const lines = change.text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        homeBreaks(change.name, lines[index] ?? "", index + 1);
        extraBreaks(change.name, lines[index] ?? "", index + 1, false);
      }
    }
    return breaks;
  },
};
