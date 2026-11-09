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
 * conventions pre-push origin
 * conventions hook install
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
  RULE_WARN_DAYS,
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
  apiReportScript,
  coverageProvider,
  cuePreset,
  gateTrigger,
  homePackage,
  licenseFile,
  mainCheck,
  noBuildOutput,
  noLocalPaths,
  packNoBuildinfo,
  pagesAfterRelease,
  pagesSite,
  pinnedGitDeps,
  pipeFails,
  gateAfterCancel,
  pushMainOnly,
  releaseFiles,
  requiredScripts,
  roadmapParses,
  RULES,
  runnerBudget,
  securityOneJob,
  serviceRunMain,
  setupCue,
  sharedCi,
  sourceMain,
  testsRequired,
  trustPolicy,
  publishedMinor,
  tsconfigTest,
  typedFiles,
  typedScripts,
  unreleasedChange,
  versionTitle,
  workflowParses,
  workspaceProtocol,
} from "./rules/index.ts";
export {
  DEFAULT_ALLOWED,
  HOME_PATTERNS,
  invalidPatternBreaks,
  PRIVATE_NAMES_FILE_CONFIG,
  PRIVATE_NAMES_FILE_VARIABLE,
  PRIVATE_PATTERNS_VARIABLE,
  privateNamesFile,
  privatePatterns,
  privateTextBreaks,
  type PrivatePattern,
  type PrivateSources,
  type TextBreakOptions,
} from "./rules/no-local-paths.ts";
export {
  firstNameMatch,
  isAllowedHit,
  isCommonUse,
  lineNameHit,
  lineNameHits,
  nameMatches,
  parsePrivateNames,
  pathNameHit,
  PRIVATE_NAME_LIST,
  PrivateNameListError,
  type AllowedHit,
  type LinePlace,
  type NameHit,
  type NameRule,
  type PrivateNameList,
} from "./private-names.ts";
export { HOOK_MARKER, installHook, NO_READ_LINE, PRE_PUSH_HOOK, prePush, type HookOptions, type PrePushOptions } from "./pre-push.ts";
export { hasImportMetaMain, REAL_COMPARE } from "./rules/main-check.ts";
export { roadmapOfLine } from "./rules/roadmap-parses.ts";
export { repositoryOfRemote, scheduleMinute } from "./rules/runner-budget.ts";
export { declaredName, messageOf, repoOf, reposOf, signaturesOf } from "./rules/home-package.ts";
export { HOME_EXPORTS } from "./home-exports.ts";
export { authorOf, LICENSE_TEXTS, licenseFileOf, mitText, repositoryIsPublic } from "./rules/license-file.ts";
export { GITHUB_YAML, yamlFaults, type YamlFault } from "./rules/workflow-parses.ts";
export { PAGES_WORKFLOWS, pagesCalls, type PagesCall } from "./rules/pages-site.ts";
export { ACTIONS_COMMIT, convertGate, prPathFilters, summaryName, type PathFilter } from "./rules/gate-trigger.ts";
export { SECURITY_SCAN_COMMIT, SECURITY_SCAN_INPUTS, SECURITY_TIMEOUT_MINUTES, securityCallers, withOneJob, type SecurityCaller } from "./rules/security-one-job.ts";
export { SERVICE_PACKAGE, runCalls } from "./rules/service-run-main.ts";
export { SHARED_ACTIONS, SHARED_CI, SHARED_WORKFLOWS, callsSharedCi } from "./rules/shared-ci.ts";
export { isGitSpecifier, isPinned } from "./rules/pinned-git-deps.ts";
export { isSourcePath, pathsOf } from "./rules/source-main.ts";
export { STRICT_OPTIONS } from "./rules/cue-preset.ts";
export { hasTests } from "./rules/tsconfig-test.ts";
export { IGNORE_AFTER, TRAIN_SCOPES } from "./rules/trust-policy.ts";
export { configsOfScript, scriptsOf } from "./rules/typed-files.ts";
export { lockedVersions, minorOf, publishedMinorRule, reachOf, type Minor } from "./rules/published-minor.ts";
export { NPM_REGISTRY, npmLookup, SHIPPED_FIELDS, UNSHIPPED_FILES, unreleasedChangeRule, type RegistryAnswer, type RegistryLookup } from "./rules/unreleased-change.ts";
export { namedVersions, setVersions } from "./rules/version-title.ts";
export { readAction, readWorkflow, type Workflow, type WorkflowInput, type WorkflowJob, type WorkflowStep } from "./workflow.ts";
export { blockHash, githubFetch, HOME_TIMEOUT_MS, sharedDocsRule, type HomeAnswer, type HomeFetch } from "./rules/shared-docs.ts";
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
export { changelogSection, MAX_NOTES, npmUrl, releaseNotes, tagName } from "./release-text.ts";
export { globFolders, globToRegExp, packageFolders, workspaceGlobs } from "./workspace.ts";
