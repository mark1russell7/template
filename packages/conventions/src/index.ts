/**
 * One check in CI for the conventions that the docs of a repository tell in prose. Each rule is a
 * small module with an id, a reason, a fix and the rows of the invariants audit that it comes from.
 * The field `conventions` of the root `package.json` turns a rule off or keeps an exception, each
 * with a reason.
 *
 * ```sh
 * conventions check
 * conventions fix
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
  replaceLine,
  runGit,
  specifiersOf,
  type AuditSource,
  type Break,
  type Edit,
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
  gateTrigger,
  homePackage,
  licenseFile,
  mainCheck,
  noBuildOutput,
  noLocalPaths,
  pinnedGitDeps,
  releaseFiles,
  requiredScripts,
  roadmapParses,
  RULES,
  runnerBudget,
  sourceMain,
  testsRequired,
  trustPolicy,
  tsconfigTest,
  typedFiles,
  typedScripts,
  workspaceProtocol,
} from "./rules/index.ts";
export { DEFAULT_ALLOWED, HOME_PATTERNS } from "./rules/no-local-paths.ts";
export { hasImportMetaMain, REAL_COMPARE } from "./rules/main-check.ts";
export { roadmapOfLine } from "./rules/roadmap-parses.ts";
export { repositoryOfRemote, scheduleMinute } from "./rules/runner-budget.ts";
export { declaredName, messageOf, repoOf, signaturesOf } from "./rules/home-package.ts";
export { HOME_EXPORTS } from "./home-exports.ts";
export { authorOf, LICENSE_TEXTS, licenseFileOf, mitText } from "./rules/license-file.ts";
export { ACTIONS_COMMIT, convertGate, prPathFilters, summaryName, type PathFilter } from "./rules/gate-trigger.ts";
export { isGitSpecifier, isPinned } from "./rules/pinned-git-deps.ts";
export { isSourcePath, pathsOf } from "./rules/source-main.ts";
export { STRICT_OPTIONS } from "./rules/cue-preset.ts";
export { hasTests } from "./rules/tsconfig-test.ts";
export { IGNORE_AFTER, TRAIN_SCOPES } from "./rules/trust-policy.ts";
export { configsOfScript, scriptsOf } from "./rules/typed-files.ts";
export {
  annotations,
  createContext,
  formatResult,
  listRules,
  readConfig,
  runChecks,
  runCli,
  runFix,
  summaryMarkdown,
  USAGE,
  type CheckOptions,
  type CheckResult,
  type CliIo,
  type FixResult,
  type RuleResult,
} from "./run.ts";
export { findHomes, HOMES, MAP_RULE, mapMarkdown, mapText, mergeHomes, readOverlay, type Home, type HomeState } from "./map.ts";
export { globFolders, globToRegExp, packageFolders, workspaceGlobs } from "./workspace.ts";
