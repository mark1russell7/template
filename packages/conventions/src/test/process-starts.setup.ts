// A setup file of vitest: it counts the process starts of each test file, by command, and holds the count of git under
// a limit. Each start of a process on Windows also loads images that the kernel does not free, so a suite that starts
// thousands of processes can stop the computer. The tests run in CI, but each session can start `vitest related` on its
// computer.
//
// This counter is a copy of a test helper. Its home is @mark1russell7/rigor-testkit, and the copy goes when that
// package exports the counter. The end: conventions then imports it from there.
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join, relative } from "node:path";
import { afterAll, beforeAll, inject } from "vitest";
import type { FileStarts } from "./process-starts.global.ts";

/**
 * The most git starts of one test file. Each case that needs a repository copies the fixture of its file, so a
 * file needs only some git starts for each case that commits.
 */
export const GIT_STARTS_LIMIT: number = Number.POSITIVE_INFINITY;

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

type Wrapped = (file: unknown, ...rest: unknown[]) => unknown;
const STATE = Symbol.for("conventions.process-starts");
const holder = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;

/** This function wraps the functions of `node:child_process` one time in a process, and gives the map of the counts. */
function install(): Map<string, number> {
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
      count(name === "fork" ? "node" : name === "exec" || name === "execSync" ? lineCommandName(file) : commandName(file));
      return original(file, ...rest);
    };
  }
  syncBuiltinESMExports();
  holder[STATE] = counts;
  return counts;
}

const counts = install();

beforeAll(() => {
  counts.clear();
});

// Vitest gives the fixtures first, and the suite of the test file second.
// eslint-disable-next-line no-empty-pattern
afterAll(({}, suite) => {
  const file = relative(process.cwd(), suite.file.filepath).replace(/\\/g, "/");
  const dir = inject("processStartsDir");
  const row: FileStarts = { file, counts: Object.fromEntries(counts) };
  if (dir !== undefined) writeFileSync(join(dir, `${file.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify(row));
  const git = counts.get("git") ?? 0;
  if (git > GIT_STARTS_LIMIT) {
    throw new Error(`${file} started git ${git} times, over the limit of ${GIT_STARTS_LIMIT}. Make one fixture repository for the file, and copy it for each case.`);
  }
});
