// The script deadline.ts starts a command with the time that is left to a deadline:
//
//   node deadline.ts <command> [<argument>...]
//
// The action coverage and the job coverage of reusable-ci.yml use it. Thus a slow step stops before the limit of the
// job, and the step fails. A job that reaches its limit gets the result "cancelled", also with continue-on-error.
//
// DEADLINE       the deadline in epoch seconds. Without it, the command has no limit.
// DEADLINE_LEVEL the level of the annotation of a stop: error (the default) or warning.
//
// The exit code is the exit code of the command, or 124 when the command did not start or stopped at the deadline.
// At the deadline, the script sends TERM to the process group of the command, and KILL 10 seconds later. On Windows,
// taskkill stops the tree of the command. bash starts the command ('exec "$@"'), so a step finds the same commands.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import process from "node:process";

/** The exit code of a command that did not start or that stopped at the deadline, as of GNU timeout. */
export const STOPPED = 124;

/** The time from TERM to KILL, in milliseconds. */
export const KILL_AFTER_MS = 10_000;

/**
 * This function gives the milliseconds that are left to the deadline (epoch seconds), or `undefined` when there is
 * no deadline. A deadline that is not a whole number is an error.
 */
export function millisecondsLeft(deadline: string | undefined, nowMs: number): number | undefined {
  if (deadline === undefined || deadline.trim() === "") return undefined;
  if (!/^\d+$/.test(deadline.trim())) throw new Error(`The deadline "${deadline}" is not a whole number of epoch seconds.`);
  return Number(deadline.trim()) * 1000 - nowMs;
}

/** The options of {@link runBeforeDeadline}. The tests set a short time to KILL. */
export interface DeadlineOptions {
  readonly deadline: string | undefined;
  readonly level?: string | undefined;
  readonly killAfterMs?: number;
  readonly nowMs?: number;
  readonly log?: (line: string) => void;
}

/** This function sends a signal to the process group of a child (POSIX), or stops the tree of the child (Windows). */
function stop(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group has no process: the command and its children ended.
  }
}

/**
 * This function starts the command with the time that is left to the deadline, and gives its exit code, or
 * {@link STOPPED} when the command did not start or stopped at the deadline.
 */
export function runBeforeDeadline(command: readonly string[], options: DeadlineOptions): Promise<number> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const level = options.level === "warning" ? "warning" : "error";
  const left = millisecondsLeft(options.deadline, options.nowMs ?? Date.now());
  if (command.length === 0) throw new Error("Give the command to start: node deadline.ts <command> [<argument>...].");
  if (left !== undefined && left <= 0) {
    log(`::${level}::${command[0]} did not start: the deadline of the coverage job is past.`);
    return Promise.resolve(STOPPED);
  }
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", 'exec "$@"', "deadline", ...command], {
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    let stopped = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer =
      left === undefined
        ? undefined
        : setTimeout(() => {
            stopped = true;
            stop(child, "SIGTERM");
            killTimer = setTimeout(() => stop(child, "SIGKILL"), options.killAfterMs ?? KILL_AFTER_MS);
          }, left);
    const forward = (): void => stop(child, "SIGTERM");
    process.once("SIGTERM", forward);
    process.once("SIGINT", forward);
    const done = (): void => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.off("SIGTERM", forward);
      process.off("SIGINT", forward);
    };
    child.once("error", (error) => {
      done();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      done();
      if (stopped) {
        // Each process that is left in the group stops too.
        stop(child, "SIGKILL");
        log(`::${level}::${command.join(" ")} stopped at the deadline of the coverage job.`);
        resolve(STOPPED);
        return;
      }
      if (code !== null) resolve(code);
      else resolve(128 + (signal === "SIGKILL" ? 9 : signal === "SIGINT" ? 2 : 15));
    });
  });
}

if (import.meta.main) {
  process.exitCode = await runBeforeDeadline(process.argv.slice(2), {
    deadline: process.env["DEADLINE"],
    level: process.env["DEADLINE_LEVEL"],
  });
}
