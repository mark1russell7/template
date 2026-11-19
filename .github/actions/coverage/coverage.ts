// The script of the action coverage. It has two commands:
//
//   node coverage.ts packages <file>     reads the JSON of "pnpm ls -r --json --depth -1" from the file and gives the
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
 * `pnpm ls -r --json --depth -1`. The list has the root of a workspace with packages, except when its Vitest config
 * declares projects. A run of that root starts the tests of the packages again.
 */
export function vitestDirs(
  list: unknown,
  root: string,
  testScriptOf: (dir: string) => string | undefined,
  declaresProjects: (dir: string) => boolean,
): string[] {
  if (!Array.isArray(list)) throw new Error("The list of pnpm is not a JSON array.");
  const dirs = list.map((p) => String((p as { path?: unknown }).path ?? "")).filter((path) => path !== "");
  // A root whose test script only starts the scripts of the packages (pnpm -r test) does not start Vitest, so the
  // filter of the test script below removes it. A root that is a package with its own tests stays.
  const packages = dirs.length > 1 && declaresProjects(root) ? dirs.filter((path) => resolve(path) !== resolve(root)) : dirs;
  return packages
    .filter((path) => /\bvitest\b/.test(testScriptOf(path) ?? ""))
    .map((path) => relative(root, path).replaceAll("\\", "/") || ".")
    .toSorted();
}

const EXTENSIONS = ["ts", "mts", "cts", "js", "mjs", "cjs"];
/** The configs that Vitest reads, in its order: the first `vitest.config` file, else the first `vite.config` file. */
const CONFIGS = ["vitest.config", "vite.config"].flatMap((name) => EXTENSIONS.map((ext) => `${name}.${ext}`));
/** The workspace files of Vitest 3. Vitest 4 removed them, and a config declares `projects` in their place. */
const WORKSPACES = [...EXTENSIONS, "json"].map((ext) => `vitest.workspace.${ext}`);

/**
 * This function tells if the folder declares Vitest projects. It finds a workspace file of Vitest, or the key
 * `projects` or `workspace` in the config that Vitest reads. The argument `read` gives the text of a file, or undefined.
 */
export function declaresProjects(dir: string, read: (file: string) => string | undefined = readIfFile): boolean {
  if (WORKSPACES.some((name) => read(resolve(dir, name)) !== undefined)) return true;
  for (const name of CONFIGS) {
    const text = read(resolve(dir, name));
    if (text !== undefined) return /\b(?:projects|workspace)\s*:/.test(text);
  }
  return false;
}

function readIfFile(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
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
    // The list comes from a file, not from stdin. A read of a pipe that is not blocking fails with EAGAIN on the runners.
    const [file] = rest;
    if (file === undefined) throw new Error('The command "packages" needs the file of the JSON of "pnpm ls".');
    const list: unknown = JSON.parse(readFileSync(file, "utf8"));
    const testScriptOf = (dir: string): string | undefined => {
      const file = resolve(dir, "package.json");
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { scripts?: { test?: string } }).scripts?.test : undefined;
    };
    for (const dir of vitestDirs(list, process.cwd(), testScriptOf, (dir) => declaresProjects(dir))) process.stdout.write(`${dir}\n`);
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
