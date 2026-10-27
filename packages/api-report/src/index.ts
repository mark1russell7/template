/**
 * The report of the public API of each package of a workspace, from its built `.d.ts` files. Each
 * package keeps its report in `test/api/public-api.txt`. The command `api-report check` fails when a
 * report differs from the build, and it shows the diff. Thus each change of the API shows in the
 * pull request.
 *
 * ```sh
 * pnpm -r build
 * api-report update
 * api-report check
 * ```
 */
export { parseDeclarations, statementsOf, type DeclarationInfo, type ImportBinding, type LocalExport, type Reexport } from "./declarations.ts";
export { diffLines, unifiedDiff, type DiffLine, type UnifiedDiffOptions } from "./diff.ts";
export {
  binsOf,
  byCode,
  declarationPathOf,
  entriesOf,
  patternMatch,
  publishedManifest,
  PUBLISH_CONFIG_FIELDS,
  targetOf,
  type Bin,
  type Entry,
  type Manifest,
} from "./entries.ts";
export { apiReport, DEFAULT_TOOL, HEADER_LINES, packageReport, type PackageReportOptions, type ReportOptions } from "./report.ts";
export {
  formatResult,
  readConfig,
  REPORT_FILE,
  runCli,
  runReports,
  summaryMarkdown,
  USAGE,
  type ApiReportConfig,
  type CliIo,
  type Mode,
  type PackageResult,
  type RunOptions,
  type RunResult,
} from "./run.ts";
export { globFolders, globToRegExp, packageFolders, workspaceGlobs } from "./workspace.ts";
