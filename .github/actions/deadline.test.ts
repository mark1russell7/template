// Tests deadline.ts of the action coverage: the time that is left, the exit codes and the stop at the deadline.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { millisecondsLeft, runBeforeDeadline, STOPPED } from "./coverage/deadline.ts";

const node = process.execPath.replaceAll("\\", "/");
const seconds = (offset: number): string => String(Math.floor(Date.now() / 1000) + offset);

describe("deadline: the time that is left", () => {
  it("gives no limit with no deadline or an empty deadline", () => {
    assert.equal(millisecondsLeft(undefined, 0), undefined);
    assert.equal(millisecondsLeft(" ", 0), undefined);
  });

  it("gives the milliseconds to the deadline, below 0 when it is past", () => {
    assert.equal(millisecondsLeft("100", 40_000), 60_000);
    assert.equal(millisecondsLeft("100", 160_000), -60_000);
  });

  it("refuses a deadline that is not a whole number", () => {
    assert.throws(() => millisecondsLeft("12.5", 0), /not a whole number/);
  });
});

describe("deadline: the command", () => {
  it("gives the exit code of the command with no deadline", async () => {
    const lines: string[] = [];
    const code = await runBeforeDeadline([node, "-e", "process.exit(3)"], { deadline: undefined, log: (l) => lines.push(l) });
    assert.equal(code, 3);
    assert.deepEqual(lines, []);
  });

  it("passes each argument as one word, with no shell expansion", async () => {
    const code = await runBeforeDeadline([node, "-e", "process.exit(process.argv[1] === 'a b $HOME' ? 0 : 1)", "a b $HOME"], { deadline: seconds(60) });
    assert.equal(code, 0);
  });

  it("does not start the command after the deadline, and gives 124 with the level", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deadline-"));
    const marker = join(dir, "started").replaceAll("\\", "/");
    try {
      const lines: string[] = [];
      const code = await runBeforeDeadline([node, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`], {
        deadline: seconds(-1),
        level: "warning",
        log: (l) => lines.push(l),
      });
      assert.equal(code, STOPPED);
      assert.equal(existsSync(marker), false);
      assert.match(lines[0] ?? "", /^::warning::.* did not start: the deadline of the coverage job is past\.$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops a slow command at the deadline, and gives 124 with an error", async () => {
    const lines: string[] = [];
    const start = Date.now();
    const code = await runBeforeDeadline([node, "-e", "setTimeout(() => {}, 60_000)"], { deadline: seconds(2), log: (l) => lines.push(l) });
    assert.equal(code, STOPPED);
    assert.ok(Date.now() - start < 20_000, `it took ${Date.now() - start} ms`);
    assert.match(lines[0] ?? "", /^::error::.* stopped at the deadline of the coverage job\.$/);
  });

  it("kills a command that ignores TERM after the time to KILL", async () => {
    const start = Date.now();
    const code = await runBeforeDeadline([node, "-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60_000)"], {
      deadline: seconds(2),
      killAfterMs: 500,
      log: () => {},
    });
    assert.equal(code, STOPPED);
    assert.ok(Date.now() - start < 20_000, `it took ${Date.now() - start} ms`);
  });

  it("refuses an empty command", async () => {
    await assert.rejects(async () => runBeforeDeadline([], { deadline: undefined }), /Give the command/);
  });
});

describe("deadline: a duration, a label and a stopper", () => {
  it("stops a slow command after the duration, with the label and the level in the message", async () => {
    const lines: string[] = [];
    const start = Date.now();
    const code = await runBeforeDeadline([node, "-e", "setTimeout(() => {}, 60_000)"], {
      durationMs: 1_000,
      label: "the try",
      level: "notice",
      log: (l) => lines.push(l),
    });
    assert.equal(code, STOPPED);
    assert.ok(Date.now() - start < 20_000, `it took ${Date.now() - start} ms`);
    assert.match(lines[0] ?? "", /^::notice::.* stopped at the deadline of the try\.$/);
  });

  it("gives the exit code of a command that ends inside the duration", async () => {
    const code = await runBeforeDeadline([node, "-e", "process.exit(5)"], { durationMs: 60_000, log: () => {} });
    assert.equal(code, 5);
  });

  it("uses the earlier of a deadline and a duration", async () => {
    const lines: string[] = [];
    const code = await runBeforeDeadline([node, "-e", "process.exit(0)"], { deadline: seconds(-1), durationMs: 60_000, log: (l) => lines.push(l) });
    assert.equal(code, STOPPED);
    assert.match(lines[0] ?? "", /did not start: the deadline of the coverage job is past\.$/);
  });

  it("calls the stopper with the process ID and the time to KILL, and waits for it", async () => {
    const calls: Array<[number, number]> = [];
    let ended = false;
    const code = await runBeforeDeadline([node, "-e", "setTimeout(() => {}, 60_000)"], {
      durationMs: 1_000,
      killAfterMs: 700,
      log: () => {},
      stopper: async (pid, graceMs) => {
        calls.push([pid, graceMs]);
        if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        else process.kill(-pid, "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 300));
        ended = true;
      },
    });
    assert.equal(code, STOPPED);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[1], 700);
    assert.equal(ended, true);
  });

  it("refuses a duration that is not a positive number", () => {
    assert.throws(() => runBeforeDeadline([node, "-e", ""], { durationMs: 0 }), /not a positive number/);
  });
});

describe("deadline: the command line", () => {
  it("runs a copy of the file in another folder, as reusable-ci.yml does", () => {
    const dir = mkdtempSync(join(tmpdir(), "deadline-copy-"));
    try {
      const copy = join(dir, "deadline.ts");
      copyFileSync(fileURLToPath(new URL("./coverage/deadline.ts", import.meta.url)), copy);
      const result = spawnSync(process.execPath, [copy, node, "-e", "process.exit(3)"], { encoding: "utf8", env: { ...process.env, DEADLINE: seconds(60) } });
      assert.equal(result.status, 3, result.stdout + result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
