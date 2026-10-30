/**
 * `@mark1russell7/site-pages`: a release timeline page and a live status page for the site of a
 * GitHub repository. The data functions make the JSON, and the render functions make the HTML.
 */

export type * from "./data/types.ts";
export { compareVersions, kindOf, parseVersion, versionOfTag, type ParsedVersion, type TagVersion } from "./data/versions.ts";
export { firstSentence, headingAnchor, parseChangelog, releaseBodyEntries, type ChangelogEntry, type ChangelogSection } from "./data/changelog.ts";
export { checkStateOf, githubOpenWork, githubReleases, GITHUB_API, GITHUB_GRAPHQL, type GitHubOptions } from "./data/github.ts";
export { npmPublishTimes, NPM_REGISTRY, type NpmOptions } from "./data/npm.ts";
export { gitTagDates, headCommit, headingDate, isShallow, originRepository, type TagDate } from "./data/git.ts";
export { globFiles } from "./data/glob.ts";
export {
  DEFAULT_CHANGELOGS,
  mergeReleases,
  readChangelogs,
  readReleases,
  ReleaseDataError,
  type ChangelogSource,
  type ReadReleasesOptions,
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
export { build, HELP, parseBuildArgs, runCli, UsageError, type BuildOptions, type BuildResult, type CliIo } from "./build.ts";
