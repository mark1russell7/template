/**
 * The size budgets of `site-pages check`. A budget is a glob of the files of the built site and a limit of the gzip size of each
 * file. A file over its limit fails the check. A budget with no file fails too, so a new file name does not escape its limit.
 * The code reads the files on disk. It needs no browser.
 */

import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/** One budget: the glob of the files, from the site folder, and the largest gzip size of each file, in bytes. */
export interface Budget {
  pattern: string;
  limit: number;
}

/** The size of one file of a budget. */
export interface BudgetFile {
  /** The path of the file, from the site folder, with forward slashes. */
  file: string;
  /** The size on disk, in bytes. */
  bytes: number;
  /** The gzip size (zlib, level 9), in bytes. */
  gzip: number;
}

/** The result of one budget. */
export interface BudgetResult {
  pattern: string;
  limit: number;
  /** The files of the glob, the largest gzip size first. */
  files: BudgetFile[];
  ok: boolean;
  /** What failed. */
  problems: string[];
}

/**
 * This function reads a budget of the form `<glob>=<size>`, for example `assets/index-*.js=280kB`. The size is a number with
 * the unit `B`, `kB` (1000 bytes) or `MB` (1000000 bytes). A number with no unit is in kB. A bad entry gives an Error.
 */
export function parseBudget(entry: string): Budget | Error {
  const split = entry.lastIndexOf("=");
  const pattern = entry.slice(0, split).trim();
  const size = /^(\d+(?:\.\d+)?)\s*(B|kB|MB)?$/.exec(entry.slice(split + 1).trim());
  if (split <= 0 || pattern === "" || size === null) return new Error(`--budget must be <glob>=<size>, for example assets/*.js=280kB, not "${entry}"`);
  const unit = size[2] === "B" ? 1 : size[2] === "MB" ? 1_000_000 : 1000;
  return { pattern: pattern.replace(/\\/g, "/").replace(/^\/+/, ""), limit: Math.round(Number(size[1]) * unit) };
}

/** This function gives a size in bytes as text in kB, with one decimal. */
export function kilobytes(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

/** This function measures each file of each budget in the site folder `out`, and gives the result of each budget. */
export function checkBudgets(out: string, budgets: readonly Budget[]): BudgetResult[] {
  return budgets.map(({ pattern, limit }) => {
    const files = globSync(pattern, { cwd: out })
      .map((file) => file.replace(/\\/g, "/"))
      .sort()
      .map((file): BudgetFile => {
        const body = readFileSync(join(out, file));
        return { file, bytes: body.length, gzip: gzipSync(body, { level: 9 }).length };
      })
      .sort((a, b) => b.gzip - a.gzip);
    const problems =
      files.length === 0
        ? [`no file of the site matches the budget ${pattern}`]
        : files.filter((file) => file.gzip > limit).map((file) => `${file.file} is ${kilobytes(file.gzip)} (gzip), over the budget ${pattern} of ${kilobytes(limit)}`);
    return { pattern, limit, files, ok: problems.length === 0, problems };
  });
}

/** This function gives the log line of a budget. */
export function budgetLine(result: BudgetResult): string {
  const largest = result.files[0];
  const size = largest === undefined ? "no file" : `${kilobytes(largest.gzip)} (gzip) in ${largest.file}`;
  const problems = result.problems.length > 0 ? `\n  - ${result.problems.join("\n  - ")}` : "";
  return `${result.ok ? "PASS" : "FAIL"} budget ${result.pattern}: ${size}, the limit is ${kilobytes(result.limit)}, ${result.files.length} file(s)${problems}`;
}
