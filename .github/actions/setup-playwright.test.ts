// Tests install.ts of the action setup-playwright: the inputs, the order of the steps, the two values of packages,
// the stop of a try at its limit and the start check. The process work is fake: no test starts a process.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  browserArguments,
  install,
  parseProcesses,
  processTree,
  readInputs,
  stopTree,
  type Inputs,
  type ProcessRow,
  type RunResult,
  type System,
  type Work,
} from "./setup-playwright/install.ts";

const env = (change: Record<string, string> = {}): Record<string, string> => ({
  COMMAND: "npx playwright",
  BROWSERS: "chromium",
  HIT: "false",
  MINUTES: "12",
  ATTEMPTS: "2",
  PACKAGES: "required",
  BEST_EFFORT_MINUTES: "5",
  ...change,
});

/** The calls of a fake run, and the result that the fake gives for each step. */
interface Fake {
  readonly work: Work;
  readonly runs: Array<{ command: string; limitMs: number }>;
  readonly lines: string[];
  repairs: number;
  readonly starts: string[];
}

/** A fake of the process work. `results` gives the results of each step in order, and the last one repeats. */
function fake(
  results: Record<string, readonly RunResult[]>,
  options: { repair?: boolean; starts?: boolean; platform?: NodeJS.Platform } = {},
): Fake {
  const count = new Map<string, number>();
  const state: Fake = {
    runs: [],
    lines: [],
    repairs: 0,
    starts: [],
    work: {
      run: async (command, limitMs) => {
        state.runs.push({ command: command.join(" "), limitMs });
        const step = command[2] ?? "";
        const list = results[step] ?? [{ code: 0, stopped: false }];
        const i = count.get(step) ?? 0;
        count.set(step, i + 1);
        return list[Math.min(i, list.length - 1)] ?? { code: 0, stopped: false };
      },
      repair: async () => {
        state.repairs += 1;
        return options.repair ?? true;
      },
      starts: async (name, args) => {
        state.starts.push(`${name}: ${args.join(" ")}`);
        return options.starts ?? true;
      },
      log: (line) => state.lines.push(line),
      platform: options.platform ?? "linux",
    },
  };
  return state;
}

const passed: RunResult = { code: 0, stopped: false };
const failed: RunResult = { code: 100, stopped: false };
const limit: RunResult = { code: 124, stopped: true };

const inputs = (change: Record<string, string> = {}): Inputs => readInputs(env(change));

describe("setup-playwright: the inputs", () => {
  it("reads the inputs", () => {
    assert.deepEqual(inputs({ BROWSERS: " chromium  firefox ", HIT: "true", PACKAGES: "best-effort" }), {
      command: ["npx", "playwright"],
      browsers: ["chromium", "firefox"],
      hit: true,
      minutes: 12,
      attempts: 2,
      packages: "best-effort",
      bestEffortMinutes: 5,
    });
  });

  it("refuses an unknown value of packages", () => {
    assert.throws(() => inputs({ PACKAGES: "skip" }), /The input packages is "skip"\. Give "required" or "best-effort"\./);
    assert.throws(() => inputs({ PACKAGES: "" }), /The input packages is ""/);
  });

  for (const [variable, input] of [
    ["MINUTES", "timeout-minutes"],
    ["ATTEMPTS", "attempts"],
    ["BEST_EFFORT_MINUTES", "best-effort-minutes"],
  ] as const) {
    for (const value of ["0", "-1", "1.5", "abc", "", "05"]) {
      it(`refuses ${input} "${value}"`, () => {
        assert.throws(() => inputs({ [variable]: value }), new RegExp(`The input ${input} is "${value.replace(".", "\\.")}"\\. Give a whole number of 1 or more\\.`));
      });
    }
  }

  it("refuses an empty command or an empty list of browsers", () => {
    assert.throws(() => inputs({ COMMAND: " " }), /The input command is empty/);
    assert.throws(() => inputs({ BROWSERS: "" }), /The input browsers is empty/);
  });
});

describe("setup-playwright: the browsers and required", () => {
  it("installs the browsers first and the system packages second, each with timeout-minutes", async () => {
    const f = fake({});
    const outcome = await install(inputs(), f.work);
    assert.deepEqual(outcome, { code: 0, packages: "installed", cause: "" });
    assert.deepEqual(f.runs, [
      { command: "npx playwright install chromium", limitMs: 720_000 },
      { command: "npx playwright install-deps chromium", limitMs: 720_000 },
    ]);
  });

  it("does not install the browsers after a cache hit", async () => {
    const f = fake({});
    await install(inputs({ HIT: "true" }), f.work);
    assert.deepEqual(f.runs.map((r) => r.command), ["npx playwright install-deps chromium"]);
    assert.ok(f.lines.includes("The browsers came from the cache."));
  });

  it("fails required after each try of the system packages fails, with no start check", async () => {
    const f = fake({ "install-deps": [failed] });
    const outcome = await install(inputs({ ATTEMPTS: "3" }), f.work);
    assert.deepEqual(outcome, { code: 1 });
    assert.equal(f.runs.filter((r) => r.command.includes("install-deps")).length, 3);
    assert.ok(f.lines.includes('::warning::Try 1 of 3 of "playwright install-deps chromium" ended with code 100.'));
    assert.ok(f.lines.includes('::error::"playwright install-deps chromium" failed 3 times.'));
    assert.equal(f.repairs, 0);
    assert.deepEqual(f.starts, []);
  });

  it("passes required when a later try passes, and repairs after a try at the limit", async () => {
    const f = fake({ "install-deps": [limit, passed] });
    const outcome = await install(inputs(), f.work);
    assert.deepEqual(outcome, { code: 0, packages: "installed", cause: "" });
    assert.ok(f.lines.includes('::warning::Try 1 of 2 of "playwright install-deps chromium" took more than 12 minutes.'));
    assert.equal(f.repairs, 1);
  });

  it("fails required when the repair after a try at the limit fails", async () => {
    const f = fake({ "install-deps": [limit, passed] }, { repair: false });
    const outcome = await install(inputs(), f.work);
    assert.deepEqual(outcome, { code: 1 });
    assert.equal(f.runs.filter((r) => r.command.includes("install-deps")).length, 1);
    assert.match(f.lines.at(-1) ?? "", /^::error::The repair of the package database/);
  });

  for (const packages of ["required", "best-effort"]) {
    it(`fails when the browsers do not install, with ${packages}`, async () => {
      const f = fake({ install: [failed] });
      const outcome = await install(inputs({ PACKAGES: packages }), f.work);
      assert.deepEqual(outcome, { code: 1 });
      assert.deepEqual(f.runs.map((r) => r.command), ["npx playwright install chromium", "npx playwright install chromium"]);
      assert.ok(f.lines.includes('::error::"playwright install chromium" failed 2 times.'));
    });
  }
});

describe("setup-playwright: best-effort", () => {
  it("gives installed when the one try passes, with best-effort-minutes", async () => {
    const f = fake({});
    const outcome = await install(inputs({ PACKAGES: "best-effort", BEST_EFFORT_MINUTES: "3" }), f.work);
    assert.deepEqual(outcome, { code: 0, packages: "installed", cause: "" });
    assert.deepEqual(f.runs.at(-1), { command: "npx playwright install-deps chromium", limitMs: 180_000 });
    assert.deepEqual(f.starts, []);
  });

  it("gives missing with the cause failed after one failed try, when each browser starts", async () => {
    const f = fake({ "install-deps": [failed, passed] });
    const outcome = await install(inputs({ PACKAGES: "best-effort", BROWSERS: "chromium firefox" }), f.work);
    assert.deepEqual(outcome, { code: 0, packages: "missing", cause: "failed" });
    assert.equal(f.runs.filter((r) => r.command.includes("install-deps")).length, 1);
    assert.equal(f.repairs, 0);
    assert.deepEqual(f.starts, ["chromium: --browser chromium", "firefox: --browser firefox"]);
    assert.equal(
      f.lines.at(-1),
      '::warning::The system packages of the browsers are not installed: "playwright install-deps chromium firefox" ended with code 100. Each browser starts, but fonts and other system packages can be missing.',
    );
  });

  it("gives missing with the cause time-limit after a try at the limit, after the repair and the start check", async () => {
    const f = fake({ "install-deps": [limit] });
    const outcome = await install(inputs({ PACKAGES: "best-effort", BEST_EFFORT_MINUTES: "1" }), f.work);
    assert.deepEqual(outcome, { code: 0, packages: "missing", cause: "time-limit" });
    assert.equal(f.repairs, 1);
    assert.deepEqual(f.starts, ["chromium: --browser chromium"]);
    assert.match(f.lines.at(-1) ?? "", /^::warning::The system packages of the browsers are not installed: "playwright install-deps chromium" took more than 1 minute\. /);
  });

  it("does not repair on macOS or Windows, with the same rule", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      const f = fake({ "install-deps": [limit] }, { platform });
      const outcome = await install(inputs({ PACKAGES: "best-effort" }), f.work);
      assert.deepEqual(outcome, { code: 0, packages: "missing", cause: "time-limit" });
      assert.equal(f.repairs, 0);
    }
  });

  it("fails when a browser does not start", async () => {
    const f = fake({ "install-deps": [failed] }, { starts: false });
    const outcome = await install(inputs({ PACKAGES: "best-effort" }), f.work);
    assert.deepEqual(outcome, { code: 1 });
    assert.ok(f.lines.some((l) => l.startsWith("::error::chromium does not start")));
    assert.match(f.lines.at(-1) ?? "", /^::error::The system packages are not installed \(.* ended with code 100\), and a browser does not start\.$/);
  });

  it("fails when the repair after a try at the limit fails, with no start check", async () => {
    const f = fake({ "install-deps": [limit] }, { repair: false });
    const outcome = await install(inputs({ PACKAGES: "best-effort" }), f.work);
    assert.deepEqual(outcome, { code: 1 });
    assert.deepEqual(f.starts, []);
  });

  it("starts no ffmpeg", async () => {
    const f = fake({ "install-deps": [failed] });
    await install(inputs({ PACKAGES: "best-effort", BROWSERS: "chromium ffmpeg" }), f.work);
    assert.deepEqual(f.starts, ["chromium: --browser chromium"]);
  });
});

describe("setup-playwright: the names of the browsers", () => {
  it("gives the arguments of the CLI for each name", () => {
    assert.deepEqual(browserArguments("chromium"), ["--browser", "chromium"]);
    assert.deepEqual(browserArguments("chromium-headless-shell"), ["--browser", "chromium"]);
    assert.deepEqual(browserArguments("firefox"), ["--browser", "firefox"]);
    assert.deepEqual(browserArguments("firefox-beta"), ["--browser", "firefox"]);
    assert.deepEqual(browserArguments("webkit"), ["--browser", "webkit"]);
    assert.deepEqual(browserArguments("chrome"), ["--browser", "chromium", "--channel", "chrome"]);
    assert.deepEqual(browserArguments("msedge"), ["--browser", "chromium", "--channel", "msedge"]);
    assert.equal(browserArguments("ffmpeg"), undefined);
  });
});

const row = (pid: number, ppid: number, pgid: number, uid = 1001, start = "a"): ProcessRow => ({ pid, ppid, pgid, uid, key: `${pid}@${start}` });

describe("setup-playwright: the tree of a try", () => {
  it("reads the table of ps, and skips a zombie", () => {
    const rows = parseProcesses(
      [
        "  100     1   100  1001 Ss   Tue Nov 11 16:29:01 2026",
        "  101   100   100     0 S+   Tue Nov 11 16:29:02 2026",
        "  102   101   102     0 Z    Tue Nov 11 16:29:03 2026",
        "",
      ].join("\n"),
    );
    assert.deepEqual(rows, [
      { pid: 100, ppid: 1, pgid: 100, uid: 1001, key: "100@Tue Nov 11 16:29:01 2026" },
      { pid: 101, ppid: 100, pgid: 100, uid: 0, key: "101@Tue Nov 11 16:29:02 2026" },
    ]);
  });

  it("finds the descendants by parent also in a new group, and the members of the group", () => {
    // 10 is the try. 11 (sudo) is its child, 12 (root, a new session behind the terminal of sudo) is a child of 11,
    // 13 is a child of 12. 14 left the tree but stays in the group. 20 and 21 are not of the try.
    const rows = [row(10, 1, 10), row(11, 10, 10), row(12, 11, 12, 0), row(13, 12, 12, 0), row(14, 1, 10), row(20, 1, 20), row(21, 20, 20)];
    assert.deepEqual(processTree(rows, 10, undefined).map((r) => r.pid).sort((a, b) => a - b), [10, 11, 12, 13, 14]);
  });

  it("finds the processes of a stopped parent by their keys, and not a new process with a reused ID", () => {
    const known = new Set(["12@a", "13@a"]);
    // 12 moved to the parent 1. A new process 13 with a new start time is not the old one.
    const rows = [row(12, 1, 12, 0), row(15, 12, 12, 0), row(13, 1, 13, 1001, "b")];
    assert.deepEqual(processTree(rows, 10, known).map((r) => r.pid).sort((a, b) => a - b), [12, 15]);
  });

  it("stops the tree with TERM, and with KILL after the grace when a process is left", async () => {
    let now = 0;
    let table = [row(10, 1, 10), row(11, 10, 10), row(12, 11, 12, 0), row(30, 1, 30)];
    const signals: string[] = [];
    const system: System = {
      table: () => table,
      signal: (rows, signal) => {
        signals.push(`${signal} ${rows.map((r) => r.pid).join(",")}`);
        // 10 and 11 stop at TERM. 12 ignores TERM and stops at KILL.
        table = signal === "SIGTERM" ? table.filter((r) => r.pid !== 10 && r.pid !== 11).map((r) => (r.pid === 12 ? { ...r, ppid: 1 } : r)) : table.filter((r) => r.pid === 30);
      },
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    };
    const left = await stopTree(10, 1_000, system);
    assert.equal(left, 0);
    assert.deepEqual(signals, ["SIGTERM 10,11,12", "SIGKILL 12"]);
    assert.ok(now >= 1_000);
  });

  it("gives the number of processes that are left after KILL", async () => {
    let now = 0;
    const system: System = {
      table: () => [row(10, 1, 10)],
      signal: () => {},
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    };
    assert.equal(await stopTree(10, 500, system), 1);
  });

  it("sends no signal when the try already stopped", async () => {
    const signals: string[] = [];
    const system: System = { table: () => [row(30, 1, 30)], signal: (_r, s) => signals.push(s), sleep: async () => {}, now: () => 0 };
    assert.equal(await stopTree(10, 500, system), 0);
    assert.deepEqual(signals, []);
  });
});
