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
 * except `console.table`, which is output.
 *
 * The rule is a ratchet. A repository writes its count in the option `baseline`. The check fails when the count is not
 * the baseline: a new call fails, and a fix lowers the baseline. From the day `failFrom` each call fails. The default
 * day is `CONSOLE_LAST_DAY`, and a repository can set an earlier day, but not a later day.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import { matchesAny, type Break, type Options, type Rule } from "../rule.ts";

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

/** The last day of the warnings: from this day each call fails in each repository. A repository cannot set a later day. */
export const CONSOLE_LAST_DAY = "2027-01-20";

/** The file of the summary break of the ratchet: the options of the rule are in the root `package.json`. */
const CONFIG_FILE = "package.json";

/** The decision of the rule for one repository. */
export interface ConsoleGate {
  /** True when the calls fail the check. */
  readonly fails: boolean;
  /** The reason, in words for the owner of the repository. */
  readonly why: string;
  /** True when the reason is a problem of the options or the baseline, so the check gives it as a break of `package.json`. */
  readonly summary: boolean;
}

/**
 * This function decides the rule for a repository: the options, the count of the calls in its sources and the day of the
 * check. A baseline of -1 is no baseline.
 */
export function consoleGate(options: Options, count: number, today: string): ConsoleGate {
  const failFrom = String(options["failFrom"] ?? CONSOLE_LAST_DAY);
  const baseline = Number(options["baseline"] ?? -1);
  if (failFrom > CONSOLE_LAST_DAY) {
    return { fails: true, summary: true, why: `The option failFrom of no-console is ${failFrom}, after the last day ${CONSOLE_LAST_DAY}. Set a day on or before it.` };
  }
  if (baseline >= 0 && count > baseline) {
    return { fails: true, summary: true, why: `The sources have ${String(count)} console calls, more than the baseline ${String(baseline)} of no-console. Remove the new calls.` };
  }
  if (baseline >= 0 && count < baseline) {
    return { fails: true, summary: true, why: `The sources have ${String(count)} console calls, fewer than the baseline ${String(baseline)} of no-console. Set the option baseline to ${String(count)}.` };
  }
  if (count === 0) return { fails: false, summary: false, why: "" };
  if (options["fail"] === true) return { fails: true, summary: false, why: "The option fail of no-console is set." };
  if (today >= failFrom) return { fails: true, summary: false, why: `Each console call fails from ${failFrom}.` };
  const ratchet = baseline >= 0 ? `The count ${String(count)} is the baseline.` : `Set the option baseline to ${String(count)}, so the count cannot grow.`;
  return { fails: false, summary: false, why: `Each console call fails from ${failFrom}. ${ratchet}` };
}

export const noConsole: Rule = {
  id: "no-console",
  title: "No source file calls `console`: output for a person goes to the printer of `@mark1russell7/text/print`, and a diagnostic goes to a log record of `@mark1russell7/otel-ts`.",
  reason:
    "A console line has no trace id, no level that a collector reads and no redaction of secrets. A diagnostic then does not join the trace of its request, and the output of a CLI cannot go to a buffer in a test. A census of 2026-11-25 found 1549 console calls in the sources of 36 repositories.",
  fix: "Write the output of a CLI with createPrinter({ out: process.stdout, err: process.stderr }) of @mark1russell7/text/print. Emit each diagnostic of a library or a service with the logger of @mark1russell7/otel-ts. After each fix, set the option baseline to the new count.",
  sources: [{ repo: "private", rule: "no-console", doc: "a decision of 2026-11-25: no raw console, one printer for output and one logger for diagnostics" }],
  options: {
    fail: { type: "boolean", default: false, description: "Each call fails the check also before the day failFrom." },
    failFrom: { type: "string", default: CONSOLE_LAST_DAY, description: "The day from which each call fails. A repository can set an earlier day, but not a day after CONSOLE_LAST_DAY." },
    baseline: { type: "number", default: -1, description: "The count of the calls in the sources. The check fails when the count is not the baseline. -1 is no baseline." },
    skip: { type: "strings", default: NOT_SOURCE, description: "The globs of the files that are not sources: tests, fixtures, scripts, benches and examples." },
  },
  // Each new rule gives failsFrom. This rule has decide, so its days are the option failFrom and CONSOLE_LAST_DAY.
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
    const gate = consoleGate(options, breaks.length, context.today ?? new Date().toISOString().slice(0, 10));
    return gate.summary ? [{ file: CONFIG_FILE, message: gate.why }, ...breaks] : breaks;
  },
  decide(options, state) {
    // A summary break and a break of the runner (an unused exception) are in package.json: they are not calls.
    const gate = consoleGate(options, state.breaks.filter((item) => item.file !== CONFIG_FILE).length, state.today);
    if (gate.fails) return undefined;
    // Only a summary break or a break of the runner is left, so the check fails.
    return state.breaks.some((item) => item.file === CONFIG_FILE) ? undefined : gate.why;
  },
};
