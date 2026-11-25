import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetLine, checkBudgets, kilobytes, parseBudget } from "./budget.ts";
import { runCheckCli, summary, type CheckIo, type CheckResult } from "./check.ts";

describe("parseBudget", () => {
  it("reads the glob and the size, with kB as the default unit", () => {
    expect(parseBudget("assets/index-*.js=280kB")).toEqual({ pattern: "assets/index-*.js", limit: 280_000 });
    expect(parseBudget("assets/*.js=280")).toEqual({ pattern: "assets/*.js", limit: 280_000 });
    expect(parseBudget("/a.css=512B")).toEqual({ pattern: "a.css", limit: 512 });
    expect(parseBudget("**/*.wasm=1.5MB")).toEqual({ pattern: "**/*.wasm", limit: 1_500_000 });
  });

  it("refuses an entry with no glob or no size", () => {
    for (const entry of ["assets/*.js", "=280kB", "assets/*.js=", "assets/*.js=big", "assets/*.js=280 GB"]) {
      expect(parseBudget(entry), entry).toBeInstanceOf(Error);
    }
  });
});

describe("checkBudgets", () => {
  let out: string;
  const big = Buffer.from(Array.from({ length: 20_000 }, (_, i) => String.fromCharCode(33 + ((i * 7919) % 90))).join(""));
  const small = Buffer.from("export const a = 1;\n".repeat(10));

  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "site-budget-"));
    mkdirSync(join(out, "assets"));
    writeFileSync(join(out, "assets", "index-AAA.js"), big);
    writeFileSync(join(out, "assets", "chunk-BBB.js"), small);
    writeFileSync(join(out, "index.html"), "<!doctype html>");
  });

  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("measures the gzip size of each file of the glob, the largest first", () => {
    const [result] = checkBudgets(out, [{ pattern: "assets/*.js", limit: 1_000_000 }]);
    expect(result?.ok).toBe(true);
    expect(result?.files.map((file) => file.file)).toEqual(["assets/index-AAA.js", "assets/chunk-BBB.js"]);
    expect(result?.files[0]).toEqual({ file: "assets/index-AAA.js", bytes: big.length, gzip: gzipSync(big, { level: 9 }).length });
  });

  it("fails each file over the limit, and names the file", () => {
    const limit = gzipSync(big, { level: 9 }).length - 1;
    const [result] = checkBudgets(out, [{ pattern: "assets/*.js", limit }]);
    expect(result?.ok).toBe(false);
    expect(result?.problems).toHaveLength(1);
    expect(result?.problems[0]).toContain("assets/index-AAA.js");
    expect(budgetLine(result!)).toMatch(/^FAIL budget assets\/\*\.js/);
  });

  it("passes a file at the limit", () => {
    const [result] = checkBudgets(out, [{ pattern: "assets/index-*.js", limit: gzipSync(big, { level: 9 }).length }]);
    expect(result?.ok).toBe(true);
  });

  it("fails a budget with no file, so a new file name does not escape its limit", () => {
    const [result] = checkBudgets(out, [{ pattern: "assets/main-*.js", limit: 1_000_000 }]);
    expect(result?.ok).toBe(false);
    expect(result?.problems).toEqual(["no file of the site matches the budget assets/main-*.js"]);
  });

  it("puts each budget in the summary", () => {
    const budgets = checkBudgets(out, [{ pattern: "assets/*.js", limit: 1 }]);
    const result: CheckResult = { ok: false, url: "http://127.0.0.1/", browser: "chrome", views: [], budgets };
    const text = summary(result);
    expect(text).toContain("| Size budget | Largest file | Gzip | Limit | Result |");
    expect(text).toContain(`| \`assets/*.js\` | \`assets/index-AAA.js\` | ${kilobytes(budgets[0]!.files[0]!.gzip)} | 0.0 kB | **fail**`);
  });
});

describe("runCheckCli --budget", () => {
  const io = (): CheckIo & { err: string[] } => {
    const err: string[] = [];
    return { cwd: process.cwd(), env: {}, stdout: () => {}, stderr: (text) => err.push(text), err };
  };

  it("refuses a bad budget and a budget with no --out", async () => {
    const bad = io();
    expect(await runCheckCli(["--out", ".", "--base", "/", "--budget", "assets/*.js"], bad)).toBe(2);
    expect(bad.err.join("")).toContain("--budget must be <glob>=<size>");
    const noOut = io();
    expect(await runCheckCli(["--url", "http://127.0.0.1/", "--budget", "assets/*.js=280kB"], noOut)).toBe(2);
    expect(noOut.err.join("")).toContain("--budget needs --out");
  });
});
