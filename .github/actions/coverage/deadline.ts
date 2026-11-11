// The script deadline.ts starts a command with the time that is left to a deadline:
//
//   node deadline.ts <command> [<argument>...]
//
// The action coverage and the job coverage of reusable-ci.yml use it. Thus a slow step stops before the limit of the
// job, and the step fails. A job that reaches its limit gets the result "cancelled", also with continue-on-error.
// The action setup-playwright imports runBeforeDeadline, with a duration in place of a deadline and its own stop.
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

/**
 * This function stops the command whose process has the ID `pid`, and the processes that it started. It sends TERM,
 * waits at most `graceMs` milliseconds, and then sends KILL. The promise resolves when the processes stopped.
 */
export type Stopper = (pid: number, graceMs: number) => Promise<void>;

/** The options of {@link runBeforeDeadline}. The tests set a short time to KILL. */
export interface DeadlineOptions {
  /** The deadline in epoch seconds, or `undefined` or "" for no deadline. */
  readonly deadline?: string | undefined;
  /** The time limit in milliseconds from the start. With a deadline too, the earlier of the two applies. */
  readonly durationMs?: number | undefined;
  /** The level of the annotation of a stop: "error" (the default), "warning" or "notice". */
  readonly level?: string | undefined;
  /** The name of the limit in the messages. The default is "the coverage job". */
  readonly label?: string | undefined;
  readonly killAfterMs?: number;
  readonly nowMs?: number;
  readonly log?: (line: string) => void;
  /** The stop at the limit. The default sends TERM to the process group (POSIX) or stops the tree (Windows). */
  readonly stopper?: Stopper | undefined;
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
  const level = options.level === "warning" || options.level === "notice" ? options.level : "error";
  const label = options.label ?? "the coverage job";
  const fromDeadline = millisecondsLeft(options.deadline, options.nowMs ?? Date.now());
  const duration = options.durationMs;
  if (duration !== undefined && !(Number.isFinite(duration) && duration > 0)) throw new Error(`The duration ${duration} ms is not a positive number.`);
  const left = fromDeadline === undefined ? duration : duration === undefined ? fromDeadline : Math.min(fromDeadline, duration);
  if (command.length === 0) throw new Error("Give the command to start: node deadline.ts <command> [<argument>...].");
  if (left !== undefined && left <= 0) {
    log(`::${level}::${command[0]} did not start: the deadline of ${label} is past.`);
    return Promise.resolve(STOPPED);
  }
  const killAfterMs = options.killAfterMs ?? KILL_AFTER_MS;
  const stopper = options.stopper;
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", 'exec "$@"', "deadline", ...command], {
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    let stopped = false;
    let killTimer: NodeJS.Timeout | undefined;
    // With a stopper, the promise of its stop. The exit of the command waits for it.
    let stopping: Promise<void> | undefined;
    const timer =
      left === undefined
        ? undefined
        : setTimeout(() => {
            stopped = true;
            if (stopper !== undefined && child.pid !== undefined) {
              stopping = stopper(child.pid, killAfterMs);
              return;
            }
            stop(child, "SIGTERM");
            killTimer = setTimeout(() => stop(child, "SIGKILL"), killAfterMs);
          }, left);
    const forward = (): void => {
      if (stopper !== undefined && child.pid !== undefined) void stopper(child.pid, killAfterMs);
      else stop(child, "SIGTERM");
    };
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
        const report = (): void => {
          log(`::${level}::${command.join(" ")} stopped at the deadline of ${label}.`);
          resolve(STOPPED);
        };
        if (stopping !== undefined) {
          // The stopper ends when each process of the command stopped.
          stopping.then(report, reject);
          return;
        }
        // Each process that is left in the group stops too.
        stop(child, "SIGKILL");
        report();
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
