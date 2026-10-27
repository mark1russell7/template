/**
 * The rule `no-local-paths`: no tracked file names the home folder of a user of a computer.
 */
import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { Break, Rule } from "../rule.ts";

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
  /\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)(?<user>[^\\/\s"'`<>|:*?%$(){}[\],;]+)/g,
  /(?<![\w.~-])\/Users\/(?<user>[^/\s"'`<>|:*?%$(){}[\],;]+)/g,
  /(?<![\w.~-])\/home\/(?<user>[^/\s"'`<>|:*?%$(){}[\],;]+)/g,
];

export const noLocalPaths: Rule = {
  id: "no-local-paths",
  title: "No tracked file has the home folder of a user (`C:\\Users\\<name>`, `/Users/<name>`, `/home/<name>`).",
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
    const fromEnv = (context.env["CONVENTIONS_PRIVATE_PATTERNS"] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const sources = [...(Array.isArray(options["patterns"]) ? options["patterns"] : []), ...fromEnv];
    const extra = sources.map((source) => new RegExp(source, "g"));
    const rootFile = context.rootPackage.file;
    const breaks: Break[] = [];
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
        for (const pattern of HOME_PATTERNS) {
          for (const match of line.matchAll(pattern)) {
            const user = match.groups?.["user"] ?? "";
            // A name of one character is a placeholder of a test, not a person
            if (user.length < 2 || allowed.has(user.toLowerCase())) continue;
            breaks.push({ file, line: index + 1, message: `The text "${match[0]}" is the home folder of a user.` });
          }
        }
        for (const pattern of extra) {
          // The option patterns of the root package.json names the pattern itself
          if (file === rootFile && line.trim().replace(/,$/, "") === JSON.stringify(pattern.source)) continue;
          for (const match of line.matchAll(pattern)) breaks.push({ file, line: index + 1, message: `The text "${match[0]}" matches the pattern ${pattern.source}.`, fix: "Remove the text." });
        }
      }
    }
    return breaks;
  },
};
