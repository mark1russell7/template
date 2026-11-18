// Tests of scripts/workflows/gate-attempt.ts and of the two jobs of reusable-gate.yml (CI.md, "A gate with a second
// attempt"). Start them with "pnpm test:workflows". The tests use no network.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { decideAttempt, main, readAttempt } from "./gate-attempt.ts";

const root = resolve(import.meta.dirname, "..", "..");

describe("readAttempt", () => {
  const cases: [string, number, string, string][] = [
    ["pass\n", 0, "pass", "each of 1 gates passes"],
    ["pass\npass\npass\n", 0, "pass", "each of 3 gates passes"],
    ["pass\nblock\nno-read\n", 1, "block", "1 of 3 gates block, and the command exited with 1"],
    ["pass\nno-read\n", 0, "no-read", "1 of 2 gates have no read"],
    ["no-read\n", 1, "no-read", "1 of 1 gates have no read, and the command exited with 1"],
    ["pass\n", 1, "error", "each of 1 gates passes, but the command exited with 1"],
    ["", 0, "error", "the command wrote no verdict (exit code 0)"],
    ["\n  \n", 2, "error", "the command wrote no verdict (exit code 2)"],
    ["pass\nok\n", 0, "error", 'the line 2 of the verdict file is "ok", not pass, block or no-read'],
    ["PASS\n", 0, "error", 'the line 1 of the verdict file is "PASS", not pass, block or no-read'],
    ["no read\n", 0, "error", 'the line 1 of the verdict file is "no read", not pass, block or no-read'],
  ];
  for (const [text, exit, verdict, reason] of cases) {
    it(`gives ${verdict} for ${JSON.stringify(text)} and the exit code ${exit}`, () => {
      const read = readAttempt(text, exit);
      assert.equal(read.verdict, verdict);
      assert.equal(read.reason, reason);
    });
  }

  it("reads Windows line ends and spaces around a word, and counts each word", () => {
    assert.deepEqual(readAttempt(" pass \r\nno-read\r\npass\r\n", 0), { verdict: "no-read", reason: "1 of 3 gates have no read", counts: { pass: 2, block: 0, "no-read": 1 } });
  });

  it("cuts a long line in the reason", () => {
    const read = readAttempt(`${"x".repeat(200)}\n`, 0);
    assert.equal(read.verdict, "error");
    assert.ok(read.reason.includes(`"${"x".repeat(80)}..."`), read.reason);
    assert.ok(!read.reason.includes("x".repeat(81)), read.reason);
  });
});

describe("decideAttempt", () => {
  const read = (text: string, exit = 0) => readAttempt(text, exit);

  it("passes a pass with no annotation", () => {
    for (const attempt of [1, 2]) {
      const decision = decideAttempt(read("pass\n"), attempt, 2);
      assert.equal(decision.exitCode, 0);
      assert.equal(decision.annotation, undefined);
      assert.equal(decision.summary, `Gate, attempt ${attempt} of 2: **pass**. each of 1 gates passes.`);
    }
  });

  it("passes a no read of the first attempt with a warning, because the second attempt runs", () => {
    const decision = decideAttempt(read("no-read\n"), 1, 2);
    assert.equal(decision.exitCode, 0);
    assert.equal(decision.annotation, "::warning title=Gate attempt 1 of 2%3A no-read::No read: 1 of 1 gates have no read. Attempt 2 runs on a fresh runner. A no read is not a pass.");
  });

  it("fails a no read of the last attempt: a second no read stays a no read", () => {
    const decision = decideAttempt(read("no-read\n"), 2, 2);
    assert.equal(decision.exitCode, 1);
    assert.equal(decision.annotation, "::error title=Gate attempt 2 of 2%3A no-read::No read: 1 of 1 gates have no read. This was the last of 2 attempts. A no read is not a pass.");
    assert.equal(decideAttempt(read("no-read\n"), 1, 1).exitCode, 1);
  });

  it("fails a block and an error at each attempt", () => {
    for (const attempt of [1, 2]) {
      assert.equal(decideAttempt(read("block\n"), attempt, 2).exitCode, 1);
      assert.equal(decideAttempt(read(""), attempt, 2).exitCode, 1);
      assert.match(decideAttempt(read("block\n"), attempt, 2).annotation ?? "", /^::error title=Gate attempt \d of 2%3A block::Block: 1 of 1 gates block\.$/u);
    }
  });

  it("escapes the text of the verdict file in the annotation and in the summary", () => {
    const decision = decideAttempt(read("a*b\n"), 1, 2);
    assert.equal(decision.annotation, '::error title=Gate attempt 1 of 2%3A error::Error: the line 1 of the verdict file is "a*b", not pass, block or no-read.');
    assert.ok(decision.summary.includes(String.raw`a\*b`), decision.summary);
  });
});

describe("main", () => {
  /** This function starts main with a verdict file, and gives the exit code, the log, the output and the summary. */
  function start(text: string | undefined, env: Record<string, string>): { code: number; log: string[]; output: string; summary: string } {
    const folder = mkdtempSync(join(tmpdir(), "gate-attempt-"));
    try {
      const file = join(folder, "verdicts.txt");
      if (text !== undefined) writeFileSync(file, text);
      writeFileSync(join(folder, "output"), "");
      writeFileSync(join(folder, "summary"), "");
      const log: string[] = [];
      const code = main({ GATE_VERDICT_FILE: file, GITHUB_OUTPUT: join(folder, "output"), GITHUB_STEP_SUMMARY: join(folder, "summary"), ...env }, (line) => log.push(line));
      return { code, log, output: readFileSync(join(folder, "output"), "utf8"), summary: readFileSync(join(folder, "summary"), "utf8") };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
  const at = (attempt: string, exit = "0") => ({ GATE_ATTEMPT: attempt, GATE_ATTEMPTS: "2", GATE_EXIT: exit });

  it("writes the verdict to the output and the line to the summary", () => {
    const pass = start("pass\npass\n", at("1"));
    assert.deepEqual([pass.code, pass.output, pass.log], [0, "verdict=pass\n", ["Gate, attempt 1 of 2: pass. each of 2 gates passes."]]);
    assert.equal(pass.summary, "Gate, attempt 1 of 2: **pass**. each of 2 gates passes.\n");
    const first = start("no-read\n", at("1", "1"));
    assert.deepEqual([first.code, first.output], [0, "verdict=no-read\n"]);
    assert.match(first.log[1] ?? "", /^::warning /u);
    const second = start("no-read\n", at("2", "1"));
    assert.deepEqual([second.code, second.output], [1, "verdict=no-read\n"]);
    assert.match(second.log[1] ?? "", /^::error /u);
  });

  it("fails a block of the second attempt after a no read of the first", () => {
    const first = start("pass\nno-read\n", at("1", "1"));
    assert.deepEqual([first.code, first.output], [0, "verdict=no-read\n"]);
    const second = start("pass\nblock\n", at("2", "1"));
    assert.deepEqual([second.code, second.output], [1, "verdict=block\n"]);
    assert.match(second.log[1] ?? "", /^::error title=Gate attempt 2 of 2%3A block::Block: 1 of 2 gates block, and the command exited with 1\.$/u);
  });

  it("gives error for a missing file, a bad exit code and a bad attempt", () => {
    assert.deepEqual([start(undefined, at("1")).code, start(undefined, at("1")).output], [1, "verdict=error\n"]);
    const exit = start("pass\n", at("1", ""));
    assert.deepEqual([exit.code, exit.output], [1, "verdict=error\n"]);
    assert.match(exit.log[0] ?? "", /GATE_EXIT is ""/u);
    for (const env of [at("0"), at("3"), at("x"), { GATE_ATTEMPT: "1", GATE_EXIT: "0" }]) {
      const bad = start("pass\n", env);
      assert.deepEqual([bad.code, bad.output], [1, "verdict=error\n"], JSON.stringify(env));
      assert.match(bad.log[0] ?? "", /not an attempt from 1 to the count of attempts/u);
    }
    const empty = main({ GATE_ATTEMPT: "1", GATE_ATTEMPTS: "2", GATE_EXIT: "0" }, () => undefined);
    assert.equal(empty, 1);
  });
});

describe("reusable-gate.yml", () => {
  const text = readFileSync(join(root, ".github/workflows/reusable-gate.yml"), "utf8");
  /** This function gives the text of a job of the workflow, from its key to the next job. */
  function job(name: string): string {
    const heads = [...text.matchAll(/^ {2}([\w-]+):\s*$/gmu)].filter((head) => head.index > text.indexOf("\njobs:"));
    const index = heads.findIndex((head) => head[1] === name);
    assert.ok(index >= 0, `the job ${name}`);
    return text.slice(heads[index]!.index, heads[index + 1]?.index ?? text.length).replace(/\n+(?: {2}#.*\n)*$/u, "\n");
  }
  const steps = (body: string): string => body.slice(body.indexOf("\n    steps:\n"));

  it("gives the two jobs the same steps", () => {
    assert.equal(steps(job("second")), steps(job("first")));
  });

  it("starts the second job only on a no read of the first, as attempt 2 of 2", () => {
    const first = job("first");
    const second = job("second");
    assert.match(first, /^ {6}GATE_ATTEMPT: "1"\n {6}GATE_ATTEMPTS: "2"$/mu);
    assert.match(second, /^ {6}GATE_ATTEMPT: "2"\n {6}GATE_ATTEMPTS: "2"$/mu);
    assert.match(second, /^ {4}needs: first\n {4}if: needs\.first\.outputs\.verdict == 'no-read'$/mu);
    for (const body of [first, second]) assert.match(body, /^ {6}verdict: \$\{\{ steps\.verdict\.outputs\.verdict \|\| 'error' \}\}$/mu);
  });

  it("gives the verdict of the last attempt that ran", () => {
    assert.match(text, /^ {8}value: \$\{\{ jobs\.second\.outputs\.verdict \|\| jobs\.first\.outputs\.verdict \}\}$/mu);
    assert.match(text, /^ {8}value: \$\{\{ jobs\.second\.outputs\.verdict && '2' \|\| '1' \}\}$/mu);
  });
});
