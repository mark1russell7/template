// The script of the action coverage. It has two commands:
//
//   node coverage.ts packages            reads the JSON of "pnpm ls -r --json --depth -1" from stdin and gives the
//                                        folder of each package whose test script starts Vitest, one on each line
//   node coverage.ts summary <floor> <dir>...
//                                        reads <dir>/coverage/coverage-summary.json of each folder, gives a Markdown
//                                        table, and exits with 1 when a folder has no summary or a value under the floor
//
// The folders are relative to the current folder. The floor is a percent, and 0 is no floor.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The four measures of the summary of Vitest (the reporter json-summary of istanbul). */
export const MEASURES = ["statements", "branches", "functions", "lines"] as const;
export type Measure = (typeof MEASURES)[number];
export type Totals = Readonly<Record<Measure, { readonly total: number; readonly covered: number; readonly pct: number | "Unknown" }>>;

/** One row of the table: a package and its totals, or no totals when the summary is missing. */
export interface Row {
  readonly dir: string;
  readonly totals: Totals | undefined;
}

/**
 * This function gives the folders of the packages whose test script starts Vitest, from the JSON of
 * `pnpm ls -r --json --depth -1`. The root of the workspace is not in the list when it has packages.
 */
export function vitestDirs(list: unknown, root: string, testScriptOf: (dir: string) => string | undefined): string[] {
  if (!Array.isArray(list)) throw new Error("The list of pnpm is not a JSON array.");
  const dirs = list.map((p) => String((p as { path?: unknown }).path ?? "")).filter((path) => path !== "");
  const packages = dirs.length > 1 ? dirs.filter((path) => resolve(path) !== resolve(root)) : dirs;
  return packages
    .filter((path) => /\bvitest\b/.test(testScriptOf(path) ?? ""))
    .map((path) => relative(root, path).replaceAll("\\", "/") || ".")
    .toSorted();
}

const pct = (m: { readonly pct: number | "Unknown" }): number => (typeof m.pct === "number" ? m.pct : 100);

/** This function gives the Markdown table of the rows and the failures: a missing summary, or a measure under the floor. */
export function coverageTable(rows: readonly Row[], floor: number): { markdown: string; failures: string[] } {
  const failures: string[] = [];
  const lines = rows.map(({ dir, totals }) => {
    if (totals === undefined) {
      failures.push(`${dir}: no coverage summary. The tests failed, or the package has no @vitest/coverage-v8.`);
      return `| ${dir} | - | - | - | - | no summary |`;
    }
    const under = MEASURES.filter((m) => floor > 0 && pct(totals[m]) < floor);
    for (const m of under) failures.push(`${dir}: ${m} ${pct(totals[m]).toFixed(2)} % is under the floor ${String(floor)} %`);
    const cells = MEASURES.map((m) => `${pct(totals[m]).toFixed(2)} % (${String(totals[m].covered)}/${String(totals[m].total)})`);
    return `| ${dir} | ${cells.join(" | ")} | ${under.length > 0 ? `under the floor: ${under.join(", ")}` : "pass"} |`;
  });
  const title = floor > 0 ? `### Coverage (floor ${String(floor)} %)` : "### Coverage (no floor)";
  const markdown = [title, "", "| Package | Statements | Branches | Functions | Lines | Result |", "| --- | ---: | ---: | ---: | ---: | --- |", ...lines, ""].join("\n");
  return { markdown, failures };
}

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (command === "packages") {
    const list: unknown = JSON.parse(readFileSync(0, "utf8"));
    const testScriptOf = (dir: string): string | undefined => {
      const file = resolve(dir, "package.json");
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { scripts?: { test?: string } }).scripts?.test : undefined;
    };
    for (const dir of vitestDirs(list, process.cwd(), testScriptOf)) process.stdout.write(`${dir}\n`);
    return 0;
  }
  if (command === "summary") {
    const [floorText = "0", ...dirs] = rest;
    const floor = Number(floorText);
    if (!(floor >= 0 && floor <= 100)) throw new Error(`The floor "${floorText}" is not a percent from 0 to 100.`);
    const rows = dirs.map((dir): Row => {
      const file = resolve(dir, "coverage", "coverage-summary.json");
      return { dir, totals: existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { total: Totals }).total : undefined };
    });
    const { markdown, failures } = coverageTable(rows, floor);
    process.stdout.write(markdown);
    for (const f of failures) process.stderr.write(`::error::${f}\n`);
    return failures.length > 0 ? 1 : 0;
  }
  throw new Error(`Unknown command "${command ?? ""}". Use "packages" or "summary".`);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
