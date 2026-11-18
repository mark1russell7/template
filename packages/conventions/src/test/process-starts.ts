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
 * This function gives the key of a start in the count. With `detail`, a git start counts under `git-<command>`, for
 * example `git-ls-files`, so that a report shows which git commands start most. The first argument that is not an
 * option, or the value of `-c` or `-C`, is the command.
 */
export function startKey(name: string, args: unknown, detail: boolean): string {
  if (name !== "git" || !detail || !Array.isArray(args)) return name;
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
  const detail = process.env["PROCESS_STARTS_DETAIL"] === "1";
  const functions = childProcess as unknown as Record<string, Wrapped | undefined>;
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    const original = functions[name];
    if (original === undefined) continue;
    functions[name] = (file, ...rest) => {
      const command = name === "fork" ? "node" : name === "exec" || name === "execSync" ? lineCommandName(file) : commandName(file);
      count(startKey(command, name === "exec" || name === "execSync" ? undefined : rest[0], detail));
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
