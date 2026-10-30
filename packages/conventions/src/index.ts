/**
 * One check in CI for the conventions that the docs of a repository tell in prose. Each rule is a
 * small module with an id, a reason, a fix and the rows of the invariants audit that it comes from.
 * The field `conventions` of the root `package.json` turns a rule off or keeps an exception, each
 * with a reason.
 *
 * ```sh
 * conventions check
 * conventions --list
 * ```
 */
export { defaultOptions, parseConfig, type ConventionsConfig, type RuleConfig } from "./config.ts";
export {
  cleanPath,
  codePackages,
  DEPENDENCY_FIELDS,
  hasFile,
  inFolder,
  keyLine,
  lineOf,
  matchesAny,
  parseJsonc,
  readJsonc,
  runGit,
  specifiersOf,
  type AuditSource,
  type Break,
  type Manifest,
  type OptionSpec,
  type Options,
  type OptionValue,
  type PackageInfo,
  type Rule,
  type RuleContext,
  type RuleOutcome,
} from "./rule.ts";
export {
  cuePreset,
  noBuildOutput,
  noLocalPaths,
  pinnedGitDeps,
  releaseFiles,
  requiredScripts,
  RULES,
  sourceMain,
  testsRequired,
  tsconfigTest,
  typedFiles,
  typedScripts,
  workspaceProtocol,
} from "./rules/index.ts";
export { DEFAULT_ALLOWED, HOME_PATTERNS } from "./rules/no-local-paths.ts";
export { isGitSpecifier, isPinned } from "./rules/pinned-git-deps.ts";
export { isSourcePath, pathsOf } from "./rules/source-main.ts";
export { STRICT_OPTIONS } from "./rules/cue-preset.ts";
export { hasTests } from "./rules/tsconfig-test.ts";
export { configsOfScript, scriptsOf } from "./rules/typed-files.ts";
export {
  annotations,
  createContext,
  formatResult,
  listRules,
  readConfig,
  runChecks,
  runCli,
  summaryMarkdown,
  USAGE,
  type CheckOptions,
  type CheckResult,
  type CliIo,
  type RuleResult,
} from "./run.ts";
export { globFolders, globToRegExp, packageFolders, workspaceGlobs } from "./workspace.ts";
