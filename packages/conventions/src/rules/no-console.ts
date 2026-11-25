/**
 * The rule `no-console`: no source file calls `console`. Each call is one of two kinds, and the break names the kind.
 *
 * - Output for a person: the text, the tables and the status lines of a command-line tool. It goes to the printer of
 *   `@mark1russell7/text/print` (`createPrinter`), with the streams as parameters.
 * - A diagnostic of a library or a service: a warning, a debug line, a caught error. It goes to a log record through the
 *   logger of `@mark1russell7/otel-ts` (`getLogger`), with its trace context, and not to a printer.
 *
 * A call in a CLI file is output, except `console.debug` and `console.trace`. A CLI file starts with `#!`, has the name
 * `cli`, `main` or a folder `bin` or `commands` in its path, or reads `process.argv`. Each other call is a diagnostic,
 * except `console.table`, which is output. Until a repository sets the option `fail`, a break is a warning. A repository
 * sets the option when its count is 0, so the count cannot grow again.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import { matchesAny, type Break, type Rule } from "../rule.ts";

/** The files that the rule reads: the sources of JavaScript and TypeScript, and the pages and components that hold scripts. */
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx|svelte|vue|html)$/;

/** The files that are not sources: tests, fixtures, scripts, benches and examples. The census of 2026-11-25 uses the same split. */
export const NOT_SOURCE: readonly string[] = [
  "**/*.d.ts",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.e2e.*",
  "**/*.probe.ts",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/e2e/**",
  "**/fixture/**",
  "**/fixtures/**",
  "**/script/**",
  "**/scripts/**",
  "**/bin/**",
  "**/tools/**",
  "**/bench/**",
  "**/benches/**",
  "**/benchmark/**",
  "**/benchmarks/**",
  "**/example/**",
  "**/examples/**",
  "**/demo/**",
];

/** A call of a method of `console`. The group `method` is the name of the method. */
const CALL = /\bconsole\s*\.\s*(?<method>[A-Za-z]+)\s*\(/g;

/** A line that is a comment: it starts with `//`, `/*` or `*`. */
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

/** The path of a CLI file: a folder `cli`, `bin` or `commands`, or a file `cli.*` or `main.*`. */
const CLI_PATH = /(?:^|\/)(?:cli|bin|commands?)(?:\/|\.)|(?:^|[/._-])(?:cli|main)\.[a-z]+$/;

/** The kind of a call of `console`. */
export type ConsoleKind = "output" | "diagnostic";

/** This function tells if a source file is a CLI file: it starts with `#!`, its path names a CLI, or it reads `process.argv`. */
export function isCliFile(file: string, text: string): boolean {
  return text.startsWith("#!") || CLI_PATH.test(file) || /\bprocess\.argv\b/.test(text);
}

/** This function gives the kind of a call of `console.<method>` in a file. */
export function consoleKind(cli: boolean, method: string): ConsoleKind {
  if (method === "table") return "output";
  return cli && method !== "debug" && method !== "trace" ? "output" : "diagnostic";
}

/** This function gives the message of a break: the call, its kind and where it goes. */
function messageOf(file: string, method: string, kind: ConsoleKind): string {
  return kind === "output"
    ? `${file} calls console.${method} for output to a person. Write it with createPrinter of @mark1russell7/text/print.`
    : `${file} calls console.${method} for a diagnostic. Emit a log record with the logger of @mark1russell7/otel-ts (getLogger), with its trace context.`;
}

/** This function gives a break for each call of `console` in the text of one source file. */
export function consoleBreaks(file: string, text: string): Break[] {
  const cli = isCliFile(file, text);
  const breaks: Break[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (COMMENT.test(line)) return;
    for (const match of line.matchAll(CALL)) {
      const method = match.groups?.["method"] ?? "";
      breaks.push({ file, line: index + 1, message: messageOf(file, method, consoleKind(cli, method)) });
    }
  });
  return breaks;
}

export const noConsole: Rule = {
  id: "no-console",
  title: "No source file calls `console`: output for a person goes to the printer of `@mark1russell7/text/print`, and a diagnostic goes to a log record of `@mark1russell7/otel-ts`.",
  reason:
    "A console line has no trace id, no level that a collector reads and no redaction of secrets. A diagnostic then does not join the trace of its request, and the output of a CLI cannot go to a buffer in a test. A census of 2026-11-25 found 1549 console calls in the sources of 36 repositories.",
  fix: "Write the output of a CLI with createPrinter({ out: process.stdout, err: process.stderr }) of @mark1russell7/text/print. Emit each diagnostic of a library or a service with the logger of @mark1russell7/otel-ts. When the count is 0, set the option fail: true.",
  sources: [{ repo: "private", rule: "no-console", doc: "a decision of 2026-11-25: no raw console, one printer for output and one logger for diagnostics" }],
  options: {
    fail: { type: "boolean", default: false, description: "A break fails the check. Until a repository sets it, a break is a warning. Set it when the count is 0." },
    skip: { type: "strings", default: NOT_SOURCE, description: "The globs of the files that are not sources: tests, fixtures, scripts, benches and examples." },
  },
  failsFrom: "2026-12-09",
  check(context, options) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const skip = options["skip"] as readonly string[];
    const breaks: Break[] = [];
    for (const file of files.filter((path) => SOURCE.test(path) && !matchesAny(path, skip)).sort(byCode)) {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      if (text.includes("console")) breaks.push(...consoleBreaks(file, text));
    }
    return breaks;
  },
  warnOnly(options) {
    return options["fail"] === true ? undefined : "The rule fails in a repository that sets the option fail: true, when its count is 0.";
  },
};
