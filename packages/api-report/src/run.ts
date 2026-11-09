/**
 * The commands `check` and `update` of the bin `api-report`, as functions. `runReports` compares or
 * writes the reports of each package, and `runCli` reads the arguments and writes the result.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { unifiedDiff } from "./diff.ts";
import { byCode, relativePath, type Manifest } from "./entries.ts";
import { pageFaults, type ApiPage, type FrontmatterValue } from "./page.ts";
import { apiModel } from "./model.ts";
import { referencePage } from "./reference.ts";
import { DEFAULT_TOOL, documentedPackageReport, type DocumentedReport } from "./report.ts";
import { globFolders, packageFolders, workspaceGlobs } from "@mark1russell7/conventions/workspace";

/** The path of the report in a package folder, when the configuration gives no other path. */
export const REPORT_FILE = "test/api/public-api.txt";

/** The configuration of the reports: the field `apiReport` of the root `package.json`, or the options of the CLI. */
export interface ApiReportConfig {
  /** The globs of the package folders, relative to the root. A glob that starts with `!` removes folders. The default is the globs of the workspace and a public root package. */
  readonly packages?: readonly string[];
  /** The path of the report in each package folder. The default is `test/api/public-api.txt`. */
  readonly report?: string;
  /** When true, each private package also gets a report. The default is false. */
  readonly includePrivate?: boolean;
  /** When false, the report reads the fields of `package.json` without `publishConfig`. The default is true. */
  readonly publishConfig?: boolean;
  /** The command that the header of each report names. The default is `api-report`. */
  readonly tool?: string;
  /** The pages of an API. The command `check` holds their names against the report of each package. */
  readonly pages?: readonly ApiPage[];
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
   * or the command wrote it (`update`). `stale`: a folder has a report, and the run does not read
   * the package: it is private, excluded by a `!` glob, or removed. `private`: the package has no
   * report. `error`: the command did not make the report.
   */
  readonly status: "same" | "changed" | "new" | "stale" | "private" | "error";
  /** The change from the committed report to the new report, in the unified format. */
  readonly diff?: string;
  readonly error?: string;
  /** The faults of the hand-written pages of this package against its report. */
  readonly pageFaults?: readonly string[];
  /** The pages of each export that the command `update` wrote. */
  readonly writtenPages?: readonly string[];
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
  const pages = config["pages"];
  if (pages !== undefined) result.pages = readPages(pages);
  const unknown = Object.keys(config).filter((key) => !["packages", "report", "tool", "includePrivate", "publishConfig", "pages"].includes(key));
  if (unknown.length > 0) throw new Error(`apiReport has unknown fields: ${unknown.join(", ")}.`);
  return result;
}

/** This function reads the field `pages` of `apiReport`. */
function readPages(value: unknown): readonly ApiPage[] {
  if (!Array.isArray(value)) throw new Error("apiReport.pages must be an array.");
  return value.map((item: unknown, index): ApiPage => {
    const at = `apiReport.pages[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`${at} must be an object.`);
    const { package: folder, pages, except, reference, frontmatter, docs } = item as Record<string, unknown>;
    if (typeof folder !== "string" || folder === "") throw new Error(`${at}.package must be a string.`);
    if (reference !== undefined && (typeof reference !== "string" || !isRootPath(reference))) throw new Error(`${at}.reference must be a path in the repository.`);
    const emptyOk = reference !== undefined;
    if (!Array.isArray(pages) || (pages.length === 0 && !emptyOk) || !pages.every((page) => typeof page === "string")) throw new Error(`${at}.pages must be an array of paths.`);
    if (frontmatter !== undefined && reference === undefined) throw new Error(`${at}.frontmatter needs the field reference.`);
    if (docs !== undefined && typeof docs !== "boolean") throw new Error(`${at}.docs must be a boolean.`);
    if (docs !== undefined && reference === undefined) throw new Error(`${at}.docs needs the field reference.`);
    const fields = frontmatter === undefined ? undefined : readFrontmatter(frontmatter, `${at}.frontmatter`);
    const named = {
      package: folder,
      pages: pages as string[],
      ...(reference === undefined ? {} : { reference: reference as string }),
      ...(fields === undefined ? {} : { frontmatter: fields }),
      ...(docs === undefined ? {} : { docs }),
    };
    if (except === undefined) return named;
    if (typeof except !== "object" || except === null || Array.isArray(except) || !Object.values(except).every((reason) => typeof reason === "string")) {
      throw new Error(`${at}.except must be an object of names and reasons.`);
    }
    return { ...named, except: except as Record<string, string> };
  });
}

/** This function reads the field `frontmatter` of an item of `pages`: names of fields, each with a text, a number or a boolean. */
function readFrontmatter(value: unknown, at: string): Readonly<Record<string, FrontmatterValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${at} must be an object of fields.`);
  for (const [key, field] of Object.entries(value)) {
    if (!/^[A-Za-z_][\w-]*$/.test(key)) throw new Error(`${at} has a field name that is not a plain name: ${JSON.stringify(key)}.`);
    const ok = typeof field === "string" || typeof field === "boolean" || typeof field === "number";
    if (!ok) throw new Error(`${at}.${key} must be a text, a number or a boolean.`);
  }
  return value as Record<string, FrontmatterValue>;
}

/** This function is true for a relative path with no `..`. */
function isRootPath(path: string): boolean {
  const clean = path.replaceAll("\\", "/");
  return clean !== "" && !isAbsolute(path) && !clean.split("/").includes("..");
}

/** This function gives the text of a file with `\n` line ends, or undefined when the file does not exist. */
function textOf(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : undefined;
}

/** This function gives the faults of the pages of one package. A file that does not exist is a fault, and so is a page of each export that differs from the report. */
function faultsOfPages(root: string, entry: ApiPage, report: DocumentedReport, packageName: string): string[] {
  const missing = entry.pages.filter((page) => !existsSync(resolve(root, page)));
  if (missing.length > 0) return missing.map((page) => `${page}: the page does not exist.`);
  const faults: string[] = [];
  if (entry.reference !== undefined && textOf(resolve(root, entry.reference)) !== referenceOf(entry, report, packageName)) {
    faults.push(`${entry.reference}: the page differs from the report. Start the command update, and commit the page.`);
  }
  const pages = entry.pages.map((page) => readFileSync(resolve(root, page), "utf8"));
  return [...faults, ...pageFaults(report.text, packageName, pages, entry.except, entry.reference !== undefined)];
}

/** This function gives the page of each export of one package. With the field `docs`, the page also has the doc comments. */
function referenceOf(entry: ApiPage, report: DocumentedReport, packageName: string): string {
  return referencePage(apiModel(report.text, packageName, entry.docs === true ? report.docs : undefined), entry.frontmatter);
}

/** This function writes the page of each export of one package, and gives its path when the text changes. */
function writeReference(root: string, entry: ApiPage, report: DocumentedReport, packageName: string): string[] {
  if (entry.reference === undefined) return [];
  const file = resolve(root, entry.reference);
  const text = referenceOf(entry, report, packageName);
  if (textOf(file) === text) return [];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return [entry.reference];
}

/** This function makes sure that the path of a report stays in its package folder. */
/**
 * This function gives the folders of the reports when the command names no folder. With `globs`, these are the package
 * folders of the globs. Without `globs`, these are the package folders of the workspace, and also the root when its
 * package is public and the globs leave it out. A repository can publish its root and keep a private site in its
 * workspace. The result has absolute paths, in the order of the code units.
 */
export function reportFolders(root: string, globs?: readonly string[]): string[] {
  if (globs !== undefined) return packageFolders(root, globs);
  const folders = packageFolders(root);
  const top = resolve(root);
  const manifest = join(top, "package.json");
  if (workspaceGlobs(root) === undefined || !existsSync(manifest) || folders.some((folder) => resolve(folder) === top)) return folders;
  let isPrivate = false;
  try {
    isPrivate = (JSON.parse(readFileSync(manifest, "utf8")) as { private?: unknown }).private === true;
  } catch {
    // The run reads the file again and tells the error of the root
  }
  return isPrivate ? folders : [top, ...folders];
}

function checkReportPath(report: string): string {
  const clean = report.replaceAll("\\", "/").replace(/^\.\//, "");
  if (clean === "" || isAbsolute(report) || clean.split("/").includes("..")) throw new Error(`The path of a report must be relative to the package folder, with no "..": ${report}`);
  return clean;
}

/**
 * This function gives the folders that the globs name, as absolute paths, in the order of the code
 * units. It ignores the `!` globs and needs no `package.json` file, so the result also has the
 * excluded folders and the folders of removed packages.
 */
function globbedFolders(root: string, globs: readonly string[] | undefined): string[] {
  const found = new Set<string>();
  for (const glob of (globs ?? workspaceGlobs(root) ?? []).filter((item) => !item.startsWith("!"))) {
    for (const folder of globFolders(root, glob)) found.add(folder);
  }
  return [...found].sort(byCode).map((folder) => join(root, folder));
}

/**
 * This function compares (`check`) or writes (`update`) the report of each package. It writes nothing
 * in `check` mode. Without named folders, a run that finds no package fails: it examined nothing,
 * and that is not a pass. A repository of private packages passes: it has no public API to report.
 * A report in a folder that the run does not read is `stale`.
 */
export function runReports(options: RunOptions): RunResult {
  const root = resolve(options.root);
  const report = checkReportPath(options.report ?? REPORT_FILE);
  const named = options.folders !== undefined && options.folders.length > 0;
  const folders = named ? (options.folders ?? []).map((folder) => resolve(root, folder)) : reportFolders(root, options.packages);
  const results: PackageResult[] = [];
  const skipped = new Set<string>();
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
      skipped.add(folder);
      if (current === undefined) results.push({ folder: shown, file: shownFile, status: "private" });
      else {
        if (options.mode === "update") rmSync(file);
        results.push({ folder: shown, file: shownFile, status: "stale" });
      }
      continue;
    }
    let documented: DocumentedReport;
    try {
      documented = documentedPackageReport(folder, {
        tool: options.tool ?? DEFAULT_TOOL,
        ...(options.publishConfig === undefined ? {} : { publishConfig: options.publishConfig }),
      });
    } catch (error) {
      results.push({ folder: shown, file: shownFile, status: "error", error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const { text } = documented;
    const ownPages = (options.pages ?? []).filter((entry) => resolve(root, entry.package) === folder);
    const written = options.mode === "update" ? ownPages.flatMap((entry) => writeReference(root, entry, documented, manifest.name ?? "")) : [];
    const faults = ownPages.flatMap((entry) => faultsOfPages(root, entry, documented, manifest.name ?? ""));
    const onPages = {
      ...(options.mode === "check" && faults.length > 0 ? { pageFaults: faults } : {}),
      ...(written.length > 0 ? { writtenPages: written } : {}),
    };
    if (current === text) {
      results.push({ folder: shown, file: shownFile, status: "same", ...onPages });
      continue;
    }
    if (options.mode === "update") {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    const diff = unifiedDiff(current ?? "", text, { from: current === undefined ? "/dev/null" : `a/${shownFile}`, to: `b/${shownFile}` });
    results.push({ folder: shown, file: shownFile, status: current === undefined ? "new" : "changed", diff, ...onPages });
  }
  if (!named) {
    const read = new Set(folders);
    for (const entry of options.pages ?? []) {
      const pageFolder = resolve(root, entry.package);
      if (read.has(pageFolder) && !skipped.has(pageFolder)) continue;
      results.push({ folder: entry.package, file: entry.pages[0] ?? entry.reference ?? "", status: "error", error: "the field pages names a package that the command does not read" });
    }
    for (const folder of globbedFolders(root, options.packages)) {
      const file = join(folder, report);
      if (read.has(folder) || !existsSync(file)) continue;
      if (options.mode === "update") rmSync(file);
      results.push({ folder: relativePath(root, folder), file: relativePath(root, file), status: "stale" });
    }
    if (results.every((result) => result.status === "stale")) {
      results.push({ folder: ".", file: report, status: "error", error: "no package. The command read the globs of the workspace, or a package.json file in the root." });
    }
  }
  const failed = results.some(
    (result) => (result.pageFaults?.length ?? 0) > 0 || result.status === "error" || (options.mode === "check" && (result.status === "changed" || result.status === "new" || result.status === "stale")),
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
  list(update ? "Removed (the command does not read the package)" : "A report of a package that the command does not read", by("stale"), (item) => item.file);
  list("Written (the page of each export)", result.packages.filter((item) => (item.writtenPages?.length ?? 0) > 0), (item) => (item.writtenPages ?? []).join(", "));
  list("Errors", by("error"), (item) => `${item.folder}: ${item.error ?? "unknown error"}`);
  for (const item of result.packages) {
    if ((item.pageFaults?.length ?? 0) > 0) out.push(`The page of the API of ${item.folder} differs from its report:`, ...(item.pageFaults ?? []).map((fault) => `  ${fault}`));
  }
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
  const pages = result.packages.flatMap((item) => (item.pageFaults ?? []).map((fault) => `- \`${item.folder}\`: ${fault}`));
  if (changed.length === 0 && other.length === 0 && pages.length === 0) return "";
  const out = ["### Public API reports", ""];
  for (const item of changed) out.push(`<details><summary><code>${item.file}</code> (${item.status})</summary>`, "", "```diff", shortDiff(item.diff ?? "").replace(/\n$/, ""), "```", "", "</details>", "");
  for (const item of other) out.push(`- \`${item.file}\`: ${item.status === "stale" ? "a report of a package that the command does not read" : (item.error ?? "error")}`);
  out.push(...pages);
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

  check                  Compare each report with the built .d.ts files. Exit code 1 when a report differs, is missing or has no
                         package that the command reads, or when the command finds no package.
  update                 Write each report again, and each page of the field reference. Remove each report of a package that the
                         command does not read.

  --root <folder>        The root of the repository. The default is the current folder.
  --packages <glob>      A glob of package folders. Use it again for more globs. The default is the globs of the workspace and a public root package.
  --report <path>        The path of the report in each package folder. The default is ${REPORT_FILE}.
  --include-private      Also make a report for each private package.
  --no-publish-config    Read the fields of package.json without publishConfig.
  -h, --help             Show this text.

The field "apiReport" of the root package.json can set packages, report, includePrivate, publishConfig, tool and pages.
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
