// The count of the process starts of this process, by command. Each start of a process on Windows also loads images
// that the kernel does not free, so a suite that starts thousands of processes can stop the computer.
//
// This counter is a copy of a test helper. Its home is @mark1russell7/rigor-testkit, and the copy goes when that
// package exports the counter. The end: conventions then imports it from there.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

/** This function gives the name of a command file: its name with no folder and no extension, or `node` for this Node.js. */
export function commandName(file: unknown): string {
  if (typeof file !== "string") return "unknown";
  if (file === process.execPath) return "node";
  return basename(file.replace(/\\/g, "/")).replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
}

/** This function gives the name of the command of a command line: the first word, or the first part in quotes. */
export function lineCommandName(line: unknown): string {
  if (typeof line !== "string") return "unknown";
  const match = /^\s*(?:"([^"]+)"|(\S+))/.exec(line);
  return commandName(match?.[1] ?? match?.[2] ?? "");
}

/**
 * This function gives the key of a start in the count. A git start counts under `git-<command>`, for
 * example `git-ls-files`, so that a report shows which git commands start most. The first argument that is not an
 * option, or the value of `-c` or `-C`, is the command.
 */
export function startKey(name: string, args: unknown): string {
  if (name !== "git" || !Array.isArray(args)) return name;
  for (let index = 0; index < args.length; index++) {
    const arg: unknown = args[index];
    if (arg === "-c" || arg === "-C") index++;
    else if (typeof arg === "string" && !arg.startsWith("-")) return `git-${arg}`;
  }
  return name;
}

/** This function gives the count of git starts in the counts: the key `git` and each key `git-<command>`. */
export function gitStartsIn(counts: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const [key, n] of counts) if (key === "git" || key.startsWith("git-")) sum += n;
  return sum;
}

/** The git-start budgets of the test files: a budget for each file in `files`, and the budget of each other file. */
export interface GitBudgets {
  readonly default: number;
  readonly files: Readonly<Record<string, number>>;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * This function reads the text of `git-starts.json`.
 *
 * @throws Error when the text is not an object with a count `default` and an object `files` of counts
 */
export function parseGitBudgets(text: string): GitBudgets {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("git-starts.json: the text is not an object");
  const { default: other, files } = value as Record<string, unknown>;
  if (!isCount(other)) throw new Error("git-starts.json: default is not a count");
  if (typeof files !== "object" || files === null || Array.isArray(files)) throw new Error("git-starts.json: files is not an object");
  for (const [file, budget] of Object.entries(files)) if (!isCount(budget)) throw new Error(`git-starts.json: the budget of ${file} is not a count`);
  return { default: other, files: files as Record<string, number> };
}

/** This function gives the message for a test file with more git starts than its budget, or undefined. */
export function gitBudgetBreak(file: string, counts: ReadonlyMap<string, number>, budgets: GitBudgets): string | undefined {
  const used = gitStartsIn(counts);
  const budget = budgets.files[file] ?? budgets.default;
  if (used <= budget) return undefined;
  return (
    `${file} started git ${String(used)} times, over its budget of ${String(budget)} in src/test/git-starts.json. ` +
    "Share the fixture repositories of src/test/git-fixture.ts: stageAll, commitAll and shared. " +
    "Raise the budget only for the git starts of the code under test."
  );
}

type Wrapped = (file: unknown, ...rest: unknown[]) => unknown;
const STATE = Symbol.for("conventions.process-starts");
const holder = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;

/**
 * This function wraps the functions of `node:child_process` one time in a process, and gives the map of the counts by
 * command. The ESM named imports see the wrappers too.
 */
export function countProcessStarts(): Map<string, number> {
  const existing = holder[STATE];
  if (existing !== undefined) return existing;
  const counts = new Map<string, number>();
  const count = (name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const functions = childProcess as unknown as Record<string, Wrapped | undefined>;
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    const original = functions[name];
    if (original === undefined) continue;
    functions[name] = (file, ...rest) => {
      const command = name === "fork" ? "node" : name === "exec" || name === "execSync" ? lineCommandName(file) : commandName(file);
      count(startKey(command, name === "exec" || name === "execSync" ? undefined : rest[0]));
      return original(file, ...rest);
    };
  }
  syncBuiltinESMExports();
  holder[STATE] = counts;
  return counts;
}

/** This function gives the count of the starts of the command `name` in this test file. */
export function startsOf(name: string): number {
  const counts = countProcessStarts();
  return name === "git" ? gitStartsIn(counts) : (counts.get(name) ?? 0);
}
