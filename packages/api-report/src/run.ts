/**
 * The commands `check` and `update` of the bin `api-report`, as functions. `runReports` compares or
 * writes the reports of each package, and `runCli` reads the arguments and writes the result.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { unifiedDiff } from "./diff.ts";
import { relativePath, type Manifest } from "./entries.ts";
import { DEFAULT_TOOL, packageReport } from "./report.ts";
import { packageFolders } from "./workspace.ts";

/** The path of the report in a package folder, when the configuration gives no other path. */
export const REPORT_FILE = "test/api/public-api.txt";

/** The configuration of the reports: the field `apiReport` of the root `package.json`, or the options of the CLI. */
export interface ApiReportConfig {
  /** The globs of the package folders, relative to the root. A glob that starts with `!` removes folders. The default is the globs of the workspace. */
  readonly packages?: readonly string[];
  /** The path of the report in each package folder. The default is `test/api/public-api.txt`. */
  readonly report?: string;
  /** When true, each private package also gets a report. The default is false. */
  readonly includePrivate?: boolean;
  /** When false, the report reads the fields of `package.json` without `publishConfig`. The default is true. */
  readonly publishConfig?: boolean;
  /** The command that the header of each report names. The default is `api-report`. */
  readonly tool?: string;
}

/** The command: `check` compares the reports, and `update` writes them. */
export type Mode = "check" | "update";

/** The options of `runReports`. */
export interface RunOptions extends ApiReportConfig {
  readonly mode: Mode;
  /** The root of the repository. */
  readonly root: string;
  /** The package folders to examine. They replace the globs, and a named private package gets a report. */
  readonly folders?: readonly string[];
}

/** The result of one package. */
export interface PackageResult {
  /** The package folder, relative to the root, with `/`. */
  readonly folder: string;
  /** The report file, relative to the root, with `/`. */
  readonly file: string;
  /**
   * `same`: the report is current. `changed` and `new`: the report differs or is missing (`check`),
   * or the command wrote it (`update`). `stale`: a private package has a report. `private`: the
   * package has no report. `error`: the command did not make the report.
   */
  readonly status: "same" | "changed" | "new" | "stale" | "private" | "error";
  /** The change from the committed report to the new report, in the unified format. */
  readonly diff?: string;
  readonly error?: string;
}

/** The result of `runReports`. */
export interface RunResult {
  readonly mode: Mode;
  readonly packages: readonly PackageResult[];
  /** True when the command fails: an error, or (`check` only) a report that is not current. */
  readonly failed: boolean;
}

/**
 * This function reads the field `apiReport` of the `package.json` file at `root`. The result is an
 * empty configuration when the field does not exist.
 *
 * @throws Error when the field is not an object, or a value has the wrong type
 */
export function readConfig(root: string): ApiReportConfig {
  const file = join(root, "package.json");
  if (!existsSync(file)) return {};
  const value = (JSON.parse(readFileSync(file, "utf8")) as Manifest)["apiReport"];
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("The field apiReport of package.json must be an object.");
  const config = value as Record<string, unknown>;
  const result: { -readonly [K in keyof ApiReportConfig]: ApiReportConfig[K] } = {};
  const packages = config["packages"];
  if (packages !== undefined) {
    if (!Array.isArray(packages) || !packages.every((glob) => typeof glob === "string")) throw new Error("apiReport.packages must be an array of globs.");
    result.packages = packages;
  }
  for (const key of ["report", "tool"] as const) {
    const item = config[key];
    if (item === undefined) continue;
    if (typeof item !== "string" || item === "") throw new Error(`apiReport.${key} must be a string.`);
    result[key] = item;
  }
  for (const key of ["includePrivate", "publishConfig"] as const) {
    const item = config[key];
    if (item === undefined) continue;
    if (typeof item !== "boolean") throw new Error(`apiReport.${key} must be true or false.`);
    result[key] = item;
  }
  const unknown = Object.keys(config).filter((key) => !["packages", "report", "tool", "includePrivate", "publishConfig"].includes(key));
  if (unknown.length > 0) throw new Error(`apiReport has unknown fields: ${unknown.join(", ")}.`);
  return result;
}

/** This function makes sure that the path of a report stays in its package folder. */
function checkReportPath(report: string): string {
  const clean = report.replaceAll("\\", "/").replace(/^\.\//, "");
  if (clean === "" || isAbsolute(report) || clean.split("/").includes("..")) throw new Error(`The path of a report must be relative to the package folder, with no "..": ${report}`);
  return clean;
}

/** This function compares (`check`) or writes (`update`) the report of each package. It writes nothing in `check` mode. */
export function runReports(options: RunOptions): RunResult {
  const root = resolve(options.root);
  const report = checkReportPath(options.report ?? REPORT_FILE);
  const named = options.folders !== undefined && options.folders.length > 0;
  const folders = named ? (options.folders ?? []).map((folder) => resolve(root, folder)) : packageFolders(root, options.packages);
  const results: PackageResult[] = [];
  for (const folder of folders) {
    const shown = relativePath(root, folder) || ".";
    const file = join(folder, report);
    const shownFile = relativePath(root, file);
    const manifestFile = join(folder, "package.json");
    if (!existsSync(manifestFile)) {
      results.push({ folder: shown, file: shownFile, status: "error", error: "no package.json" });
      continue;
    }
    // A CRLF checkout gives the same text
    const current = existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : undefined;
    let manifest: Manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
    } catch (error) {
      results.push({ folder: shown, file: shownFile, status: "error", error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    // A private package has no public API. A named folder gets a report all the same.
    if (manifest.private === true && !named && options.includePrivate !== true) {
      if (current === undefined) results.push({ folder: shown, file: shownFile, status: "private" });
      else {
        if (options.mode === "update") rmSync(file);
        results.push({ folder: shown, file: shownFile, status: "stale" });
      }
      continue;
    }
    let text: string;
    try {
      text = packageReport(folder, {
        tool: options.tool ?? DEFAULT_TOOL,
        ...(options.publishConfig === undefined ? {} : { publishConfig: options.publishConfig }),
      });
    } catch (error) {
      results.push({ folder: shown, file: shownFile, status: "error", error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (current === text) {
      results.push({ folder: shown, file: shownFile, status: "same" });
      continue;
    }
    if (options.mode === "update") {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    const diff = unifiedDiff(current ?? "", text, { from: current === undefined ? "/dev/null" : `a/${shownFile}`, to: `b/${shownFile}` });
    results.push({ folder: shown, file: shownFile, status: current === undefined ? "new" : "changed", diff });
  }
  const failed = results.some(
    (result) => result.status === "error" || (options.mode === "check" && (result.status === "changed" || result.status === "new" || result.status === "stale")),
  );
  return { mode: options.mode, packages: results, failed };
}

/** The most lines of the diff of one package in the output. */
const MAX_DIFF_LINES = 400;

/** This function shortens a diff to `MAX_DIFF_LINES` lines. */
function shortDiff(diff: string): string {
  const lines = diff.replace(/\n$/, "").split("\n");
  if (lines.length <= MAX_DIFF_LINES) return `${lines.join("\n")}\n`;
  return `${lines.slice(0, MAX_DIFF_LINES).join("\n")}\n... ${lines.length - MAX_DIFF_LINES} more lines. Start the command update and read the diff in git.\n`;
}

/** This function gives the text of a result for a terminal or a CI log. */
export function formatResult(result: RunResult, tool: string = DEFAULT_TOOL): string {
  const by = (status: PackageResult["status"]): PackageResult[] => result.packages.filter((item) => item.status === status);
  const reports = result.packages.filter((item) => item.status !== "private" && item.status !== "stale" && item.status !== "error").length;
  const out: string[] = [`${reports} public packages with a report of the API, ${by("private").length} private packages without a report.`];
  const list = (title: string, items: readonly PackageResult[], line: (item: PackageResult) => string): void => {
    if (items.length === 0) return;
    out.push(`${title}:`);
    for (const item of items) out.push(`  ${line(item)}`);
  };
  const update = result.mode === "update";
  list(update ? "Written" : "The report differs from the built .d.ts files", by("changed"), (item) => item.file);
  list(update ? "Written (new)" : "No report", by("new"), (item) => (update ? item.file : `${item.folder} (${item.file})`));
  list(update ? "Removed (the package is private)" : "A report of a private package", by("stale"), (item) => item.file);
  list("Errors", by("error"), (item) => `${item.folder}: ${item.error ?? "unknown error"}`);
  let text = `${out.join("\n")}\n`;
  if (!update) {
    for (const item of by("changed")) text += `\n${shortDiff(item.diff ?? "")}`;
    if (by("changed").length + by("new").length + by("stale").length > 0) {
      text += `\nTo accept a change of the API, start the build, then \`${tool} update\`, review the diff, and commit the reports.\n`;
    }
  }
  return text;
}

/** This function gives the result as Markdown for the summary of a GitHub Actions run. It gives an empty string when all reports are current. */
export function summaryMarkdown(result: RunResult): string {
  const changed = result.packages.filter((item) => item.status === "changed" || item.status === "new");
  const other = result.packages.filter((item) => item.status === "stale" || item.status === "error");
  if (changed.length === 0 && other.length === 0) return "";
  const out = ["### Public API reports", ""];
  for (const item of changed) out.push(`<details><summary><code>${item.file}</code> (${item.status})</summary>`, "", "```diff", shortDiff(item.diff ?? "").replace(/\n$/, ""), "```", "", "</details>", "");
  for (const item of other) out.push(`- \`${item.file}\`: ${item.status === "stale" ? "a report of a private package" : (item.error ?? "error")}`);
  return `${out.join("\n")}\n`;
}

/** The input and output of `runCli`. */
export interface CliIo {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** The help text of the bin. */
export const USAGE: string = `Usage: api-report <check | update> [options] [<package folder>...]

  check                  Compare each report with the built .d.ts files. Exit code 1 when a report differs or is missing.
  update                 Write each report again.

  --root <folder>        The root of the repository. The default is the current folder.
  --packages <glob>      A glob of package folders. Use it again for more globs. The default is the globs of the workspace.
  --report <path>        The path of the report in each package folder. The default is ${REPORT_FILE}.
  --include-private      Also make a report for each private package.
  --no-publish-config    Read the fields of package.json without publishConfig.
  -h, --help             Show this text.

The field "apiReport" of the root package.json can set packages, report, includePrivate, publishConfig and tool.
`;

/** An error of the arguments: exit code 2 and the help text. */
class UsageError extends Error {}

/** This function starts the bin with the arguments `args`, and gives its exit code. */
export function runCli(args: readonly string[], io: CliIo): number {
  let mode: Mode | undefined;
  let root = io.cwd;
  const packages: string[] = [];
  const folders: string[] = [];
  const flags: { report?: string; includePrivate?: boolean; publishConfig?: boolean } = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const value = (): string => {
      const next = args[++index];
      if (next === undefined || next.startsWith("-")) throw new UsageError(`The option ${arg} needs a value.`);
      return next;
    };
    try {
      if (arg === "check" || arg === "--check") mode = "check";
      else if (arg === "update" || arg === "--update") mode = "update";
      else if (arg === "--root") root = resolve(io.cwd, value());
      else if (arg === "--packages") packages.push(value());
      else if (arg === "--report") flags.report = value();
      else if (arg === "--include-private") flags.includePrivate = true;
      else if (arg === "--no-publish-config") flags.publishConfig = false;
      else if (arg === "--help" || arg === "-h") {
        io.stdout(USAGE);
        return 0;
      } else if (arg.startsWith("-")) throw new UsageError(`An unknown option: ${arg}`);
      else folders.push(arg);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      io.stderr(`api-report: ${error.message}\n\n${USAGE}`);
      return 2;
    }
  }
  if (mode === undefined) {
    io.stderr(`api-report: give the command check or update.\n\n${USAGE}`);
    return 2;
  }
  let result: RunResult;
  let tool: string;
  try {
    const config = readConfig(root);
    tool = config.tool ?? DEFAULT_TOOL;
    result = runReports({
      ...config,
      ...flags,
      ...(packages.length > 0 ? { packages } : {}),
      mode,
      root,
      folders: folders.map((folder) => resolve(io.cwd, folder)),
    });
  } catch (error) {
    io.stderr(`api-report: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  io.stdout(formatResult(result, tool));
  const summary = io.env["GITHUB_STEP_SUMMARY"];
  if (summary && mode === "check") {
    const markdown = summaryMarkdown(result);
    if (markdown !== "") appendFileSync(summary, markdown);
  }
  return result.failed ? 1 : 0;
}
