// The script install.ts of the action setup-playwright. It installs the Playwright browsers first and their system
// packages second:
//
//   node install.ts check     checks the inputs and installs nothing
//   node install.ts install   installs, and writes the outputs packages and packages-cause to GITHUB_OUTPUT
//
// The inputs come from the environment: COMMAND, BROWSERS, HIT, MINUTES, ATTEMPTS, PACKAGES and BEST_EFFORT_MINUTES
// (action.yml tells each one).
//
// "required": the system packages have ATTEMPTS tries of MINUTES each, and a failure of the last try fails the step.
// "best-effort": the system packages have one try of BEST_EFFORT_MINUTES. When the try fails or reaches its limit and
// each browser starts, the step warns and passes with packages=missing. The verdict is the result of the real
// install inside the limit: no probe guesses it.
//
// The function install takes the process work (the runner, the repair, the start check, the log, the platform) as
// arguments, so that the tests give fakes and start no process.
import { spawnSync } from "node:child_process";
import { appendFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runBeforeDeadline, type Stopper } from "../coverage/deadline.ts";

/** The time from TERM to KILL when a try reaches its limit, in milliseconds. */
export const GRACE_MS = 15_000;

/** The time limit of the repair of the package database (dpkg --configure -a), in minutes. */
export const REPAIR_MINUTES = 5;

/** The time limit of the start of each browser, in seconds. */
export const START_SECONDS = 120;

/** The two values of the input packages. */
export type Mode = "required" | "best-effort";

/** The inputs of the action, checked. */
export interface Inputs {
  /** The command of the Playwright CLI, as words. */
  readonly command: readonly string[];
  readonly browsers: readonly string[];
  /** True when the browsers came from the cache. */
  readonly hit: boolean;
  readonly minutes: number;
  readonly attempts: number;
  readonly packages: Mode;
  readonly bestEffortMinutes: number;
}

/** This function gives a positive whole number, or an error that names the input. */
function wholeNumber(name: string, value: string | undefined): number {
  const text = (value ?? "").trim();
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`The input ${name} is "${value ?? ""}". Give a whole number of 1 or more.`);
  return Number(text);
}

/** This function reads and checks the inputs from the environment `env`. An input that is not correct is an error. */
export function readInputs(env: Readonly<Record<string, string | undefined>>): Inputs {
  const packages = env["PACKAGES"] ?? "";
  if (packages !== "required" && packages !== "best-effort") {
    throw new Error(`The input packages is "${packages}". Give "required" or "best-effort".`);
  }
  const command = (env["COMMAND"] ?? "").trim().split(/\s+/).filter((word) => word !== "");
  if (command.length === 0) throw new Error("The input command is empty.");
  const browsers = (env["BROWSERS"] ?? "").trim().split(/\s+/).filter((word) => word !== "");
  if (browsers.length === 0) throw new Error("The input browsers is empty.");
  return {
    command,
    browsers,
    hit: env["HIT"] === "true",
    minutes: wholeNumber("timeout-minutes", env["MINUTES"]),
    attempts: wholeNumber("attempts", env["ATTEMPTS"]),
    packages,
    bestEffortMinutes: wholeNumber("best-effort-minutes", env["BEST_EFFORT_MINUTES"]),
  };
}

/** The result of one run of a command with a time limit. */
export interface RunResult {
  /** The exit code of the command. */
  readonly code: number;
  /** True when the command reached its limit and was stopped. */
  readonly stopped: boolean;
}

/** The process work of {@link install}. */
export interface Work {
  /** This function starts the command with a time limit in milliseconds. */
  readonly run: (command: readonly string[], limitMs: number) => Promise<RunResult>;
  /** This function repairs the package database (Linux), with its own time limit, and gives true when it passed. */
  readonly repair: () => Promise<boolean>;
  /** This function starts the browser `name` with the arguments `args` of the CLI, and gives true when it started. */
  readonly starts: (name: string, args: readonly string[]) => Promise<boolean>;
  readonly log: (line: string) => void;
  readonly platform: NodeJS.Platform;
}

/** The result of {@link install}. */
export interface Outcome {
  /** The exit code of the step. */
  readonly code: 0 | 1;
  /** The output packages, when the step passes. */
  readonly packages?: "installed" | "missing";
  /** The output packages-cause: "" with installed, "failed" or "time-limit" with missing. */
  readonly cause?: "" | "failed" | "time-limit";
}

/**
 * This function gives the arguments of the CLI that start the browser `name`, or `undefined` for ffmpeg, which is
 * not a browser. A branded browser or a different build of Chromium (chrome, msedge, chromium-tip-of-tree) is a
 * channel of Chromium.
 */
export function browserArguments(name: string): readonly string[] | undefined {
  if (name === "ffmpeg") return undefined;
  if (name === "chromium" || name === "chromium-headless-shell") return ["--browser", "chromium"];
  if (name.startsWith("firefox")) return ["--browser", "firefox"];
  if (name.startsWith("webkit")) return ["--browser", "webkit"];
  return ["--browser", "chromium", "--channel", name];
}

const minutesText = (n: number): string => `${n} minute${n === 1 ? "" : "s"}`;
const timesText = (n: number): string => `${n} time${n === 1 ? "" : "s"}`;

/** This function installs the browsers and their system packages with the inputs `inputs`, and gives the outcome. */
export async function install(inputs: Inputs, work: Work): Promise<Outcome> {
  const { command, browsers, attempts, minutes } = inputs;
  const linux = work.platform === "linux";
  const name = (step: readonly string[]): string => `"playwright ${step.join(" ")}"`;

  // After a stopped try, the package database can be in an incomplete state. A repair that fails is an error in
  // both modes, so that a broken database does not pass in silence.
  const repaired = async (): Promise<boolean> => {
    if (!linux || (await work.repair())) return true;
    work.log(`::error::The repair of the package database (dpkg --configure -a) after a stopped try failed or took more than ${minutesText(REPAIR_MINUTES)}.`);
    return false;
  };

  // The tries of one step. "broken" tells that a repair failed.
  const tries = async (step: readonly string[], withRepair: boolean): Promise<"passed" | "failed" | "broken"> => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await work.run([...command, ...step], minutes * 60_000);
      if (result.code === 0 && !result.stopped) return "passed";
      const what = result.stopped ? `took more than ${minutesText(minutes)}` : `ended with code ${result.code}`;
      work.log(`::warning::Try ${attempt} of ${attempts} of ${name(step)} ${what}.`);
      if (result.stopped && withRepair && !(await repaired())) return "broken";
    }
    return "failed";
  };

  if (inputs.hit) {
    work.log("The browsers came from the cache.");
  } else {
    const step = ["install", ...browsers];
    const result = await tries(step, false);
    if (result !== "passed") {
      work.log(`::error::${name(step)} failed ${timesText(attempts)}.`);
      return { code: 1 };
    }
  }

  const step = ["install-deps", ...browsers];
  if (inputs.packages === "required") {
    const result = await tries(step, true);
    if (result === "broken") return { code: 1 };
    if (result === "failed") {
      work.log(`::error::${name(step)} failed ${timesText(attempts)}.`);
      return { code: 1 };
    }
    return { code: 0, packages: "installed", cause: "" };
  }

  // best-effort: one try with its own limit
  const result = await work.run([...command, ...step], inputs.bestEffortMinutes * 60_000);
  if (result.code === 0 && !result.stopped) return { code: 0, packages: "installed", cause: "" };
  const cause = result.stopped ? "time-limit" : "failed";
  const what = result.stopped ? `${name(step)} took more than ${minutesText(inputs.bestEffortMinutes)}` : `${name(step)} ended with code ${result.code}`;
  if (result.stopped && !(await repaired())) return { code: 1 };
  let each = true;
  for (const browser of browsers) {
    const args = browserArguments(browser);
    if (args === undefined) continue;
    if (await work.starts(browser, args)) {
      work.log(`${browser} starts.`);
    } else {
      work.log(`::error::${browser} does not start ("playwright screenshot ${args.join(" ")} about:blank" failed or took more than ${START_SECONDS} seconds).`);
      each = false;
    }
  }
  if (!each) {
    work.log(`::error::The system packages are not installed (${what}), and a browser does not start.`);
    return { code: 1 };
  }
  work.log(`::warning::The system packages of the browsers are not installed: ${what}. Each browser starts, but fonts and other system packages can be missing.`);
  return { code: 0, packages: "missing", cause };
}

/** One process of the table of the system. The key has the start time, so that a reused process ID is a new key. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly uid: number;
  readonly key: string;
}

/**
 * This function reads the output of `ps -A -o pid=,ppid=,pgid=,uid=,stat=,lstart=`. It skips a zombie (state Z),
 * because a zombie has stopped.
 */
export function parseProcesses(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const [pid, ppid, pgid, uid, stat, ...start] = line.trim().split(/\s+/);
    if (pid === undefined || !/^\d+$/.test(pid) || stat === undefined || stat.startsWith("Z")) continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), uid: Number(uid), key: `${pid}@${start.join(" ")}` });
  }
  return rows;
}

/**
 * This function gives the processes of the tree of the try. The first time (`known` is `undefined`), the seeds are
 * the process `root` and each process of its group. After that, the seeds are the known processes that still run,
 * because the processes of a stopped parent move to a new parent. The tree is the seeds and each descendant of a
 * seed. The processes behind sudo are in the tree by their parent, also when they are in a new session.
 */
export function processTree(rows: readonly ProcessRow[], root: number, known: ReadonlySet<string> | undefined): ProcessRow[] {
  const chosen = new Map<number, ProcessRow>();
  for (const row of rows) {
    if (row.pid <= 1) continue;
    const seed = known === undefined ? row.pid === root || row.pgid === root : known.has(row.key);
    if (seed) chosen.set(row.pid, row);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (row.pid > 1 && !chosen.has(row.pid) && chosen.has(row.ppid)) {
        chosen.set(row.pid, row);
        grew = true;
      }
    }
  }
  return [...chosen.values()];
}

/** The work of the system for {@link stopTree}. */
export interface System {
  readonly table: () => ProcessRow[];
  readonly signal: (rows: readonly ProcessRow[], signal: "SIGTERM" | "SIGKILL") => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/** The time between two reads of the table of processes, in milliseconds. */
const POLL_MS = 250;

/** The time to wait after KILL, in milliseconds. */
const AFTER_KILL_MS = 5_000;

/**
 * This function stops the tree of the process `root`: the tree is read before the first signal, TERM goes to each
 * process of it, and KILL goes to each process that is left after `graceMs`. It gives the number of processes that
 * are left after KILL (0 when the tree stopped).
 */
export async function stopTree(root: number, graceMs: number, system: System): Promise<number> {
  let tree = processTree(system.table(), root, undefined);
  const known = new Set(tree.map((row) => row.key));
  if (tree.length === 0) return 0;
  system.signal(tree, "SIGTERM");
  const termEnd = system.now() + graceMs;
  for (;;) {
    await system.sleep(POLL_MS);
    tree = processTree(system.table(), root, known);
    for (const row of tree) known.add(row.key);
    if (tree.length === 0) return 0;
    if (system.now() >= termEnd) break;
  }
  system.signal(tree, "SIGKILL");
  const killEnd = system.now() + AFTER_KILL_MS;
  while (system.now() < killEnd) {
    await system.sleep(POLL_MS);
    tree = processTree(system.table(), root, known);
    if (tree.length === 0) return 0;
  }
  return tree.length;
}

/** The system of this computer for {@link stopTree} (Linux and macOS). */
function realSystem(): System {
  const myUid = process.getuid?.() ?? -1;
  return {
    table: () => {
      const result = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,uid=,stat=,lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
      return parseProcesses(result.stdout ?? "");
    },
    signal: (rows, signal) => {
      // A process of root (behind sudo) takes a signal only from root.
      const others: string[] = [];
      for (const row of rows) {
        if (myUid === 0 || row.uid === myUid) {
          try {
            process.kill(row.pid, signal);
          } catch {
            // The process stopped.
          }
        } else {
          others.push(String(row.pid));
        }
      }
      if (others.length > 0) spawnSync("sudo", ["-n", "kill", "-s", signal.slice(3), "--", ...others], { stdio: "ignore" });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/** This function gives the stopper of the tries: the tree of the try on Linux and macOS, taskkill on Windows. */
function treeStopper(log: (line: string) => void): Stopper {
  return async (pid, graceMs) => {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    const left = await stopTree(pid, graceMs, realSystem());
    if (left > 0) log(`::warning::${left} processes of the stopped try are left after KILL.`);
  };
}

/** This function gives the process work of this computer for the inputs `inputs`. */
function realWork(inputs: Inputs): Work {
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const run = async (command: readonly string[], limitMs: number): Promise<RunResult> => {
    let stopped = false;
    const start = Date.now();
    const stopper = treeStopper(log);
    const code = await runBeforeDeadline(command, {
      durationMs: limitMs,
      label: `the try (${minutesText(Math.round(limitMs / 60_000))})`,
      level: "notice",
      killAfterMs: GRACE_MS,
      stopper: (pid, graceMs) => {
        stopped = true;
        return stopper(pid, graceMs);
      },
    });
    const seconds = ((Date.now() - start) / 1000).toFixed(1);
    log(`"${command.join(" ")}" ended after ${seconds} seconds with the exit code ${code}${stopped ? " (stopped at its limit)" : ""}.`);
    return { code, stopped };
  };
  return {
    run,
    repair: async () => {
      if (spawnSync("sh", ["-c", "command -v dpkg"], { stdio: "ignore" }).status !== 0) return true;
      const repair = process.getuid?.() === 0 ? ["dpkg", "--configure", "-a"] : ["sudo", "-n", "dpkg", "--configure", "-a"];
      const result = await run(repair, REPAIR_MINUTES * 60_000);
      return result.code === 0 && !result.stopped;
    },
    starts: async (name, args) => {
      const file = join(process.env["RUNNER_TEMP"] ?? tmpdir(), `setup-playwright-start-${name}.png`);
      rmSync(file, { force: true });
      try {
        const result = await run([...inputs.command, "screenshot", ...args, "--timeout", "60000", "about:blank", file], START_SECONDS * 1000);
        return result.code === 0 && !result.stopped && (statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 0;
      } finally {
        rmSync(file, { force: true });
      }
    },
    log,
    platform: process.platform,
  };
}

// The form of the other scripts of the actions: it needs no new feature of Node.js, and it holds for a copy.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const mode = process.argv[2];
  let inputs: Inputs | undefined;
  try {
    if (mode !== "check" && mode !== "install") throw new Error("Give the mode: node install.ts check|install.");
    inputs = readInputs(process.env);
  } catch (error) {
    process.stdout.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
  if (inputs !== undefined && mode === "install") {
    const outcome = await install(inputs, realWork(inputs));
    const output = process.env["GITHUB_OUTPUT"];
    if (outcome.packages !== undefined && output !== undefined && output !== "") {
      appendFileSync(output, `packages=${outcome.packages}\npackages-cause=${outcome.cause ?? ""}\n`);
    }
    process.exitCode = outcome.code;
  }
}
