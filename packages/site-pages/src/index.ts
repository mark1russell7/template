/**
 * `@mark1russell7/site-pages`: a release timeline page and a live status page for the site of a
 * GitHub repository. The data functions make the JSON, and the render functions make the HTML.
 * The page helpers are for the browser. Only the entry `./chrome` exports them, so the root has no DOM types.
 */

export type * from "./data/types.ts";
export { compareVersions, kindOf, parseVersion, versionOfTag, type ParsedVersion, type TagVersion } from "./data/versions.ts";
export { changelogFaults, changelogVersions, firstSentence, headingAnchor, parseChangelog, releaseBodyEntries, sectionMarksBreak, type ChangelogEntry, type ChangelogFault, type ChangelogFaultKind, type ChangelogFaultOptions, type ChangelogSection } from "./data/changelog.ts";
export { checkStateOf, githubOpenWork, githubReleases, GITHUB_API, GITHUB_GRAPHQL, type GitHubOptions } from "./data/github.ts";
export { npmPublishTimes, NPM_REGISTRY, type NpmOptions } from "./data/npm.ts";
export { gitTagDates, headCommit, headingDate, isShallow, originRepository, versionCommitTime, type TagDate } from "./data/git.ts";
export { globFiles } from "./data/glob.ts";
export {
  DEFAULT_CHANGELOGS,
  mergeReleases,
  readChangelogs,
  readReleases,
  ReleaseDataError,
  releaseReading,
  type ChangelogSource,
  type ReadReleasesOptions,
  type ReleaseGap,
  type ReleaseListSources,
  type ReleaseReading,
  type ReleaseSources,
} from "./data/releases.ts";
export {
  buildStatusBoard,
  linksOf,
  markdownTables,
  OPEN_CLASSES,
  parseRoadmap,
  plainText,
  readStatusBoard,
  roadmapItems,
  RoadmapParseError,
  splitRow,
  statusClassOf,
  STATUS_CLASSES,
  type LinkOptions,
  type MarkdownTable,
  type ReadStatusBoardOptions,
  type StatusBoardInput,
} from "./data/status.ts";
export { KPI_FILE, KPI_FORMAT, KpiError, kpiFile, kpiProblems, kpiText, readKpi, writeKpi, type KpiInput } from "./data/kpi.ts";
export { escapeHtml, inlineMarkdown, safeUrl } from "./render/html.ts";
export { dayRange, longDate, shortDate, utcDay } from "./render/dates.ts";
export { BASE_CSS, pageShell, type PageOptions, type PageParts } from "./render/theme.ts";
export {
  laneCenter,
  oldestFirst,
  releaseSummary,
  timelineLayout,
  type ReleasePoint,
  type ReleaseSummary,
  type TimelineBand,
  type TimelineLayout,
  type TimelineMark,
  type TimelineOptions,
} from "./render/timeline.ts";
export { releasesLead, renderReleasesPage, RELEASES_SCRIPT } from "./render/releases.ts";
export { classCounts, openGroups, renderStatusPage, sectionsOf, slugOf, statusLead, STATUS_SCRIPT, type BoardSection, type ItemGroup } from "./render/status.ts";
export { probeScript, TYPESCRIPT_PROBE } from "./check/probe.ts";
export {
  checkFreshness,
  cronLines,
  DATA_STAMP_SCHEMA,
  latestAt,
  MAX_DATA_AGE_DAYS,
  MAX_LIMIT_DAYS_WITHOUT_RULING,
  MAX_MINORS_BEHIND,
  minorsBehind,
  parseDataStamps,
  type CronLine,
  type DataLimit,
  type DataRun,
  type DataStamps,
  type DataStampsParse,
  type FreshnessCheck,
  type FreshnessOptions,
  type PageStamp,
} from "./check/freshness.ts";
export { renderDataStamp } from "./render/data-stamp.ts";
export { build, HELP, parseBuildArgs, runCli, UsageError, type BuildOptions, type BuildResult, type CliIo } from "./build.ts";
