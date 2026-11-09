/**
 * The data shapes of `releases.json` and `status.json`. The standalone pages read them, and a site
 * can read the same JSON with its own components.
 */

/** A link with its text, for example a pull request, a commit or a page on npm. */
export interface Link {
  label: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

/**
 * The kind of a version. The oldest version is "first". `X.0.0` with `X` of 1 or more is "major".
 * A version with the PATCH number 0 is "minor". Each other version is "patch".
 */
export type ReleaseKind = "first" | "major" | "minor" | "patch";

/** One change of a release: one commit, and the packages whose changelogs list it. */
export interface ReleaseChange {
  /** The short SHA of the commit, or null for an entry without a commit. */
  commit: string | null;
  /** The first sentence of the entry, as inline Markdown. */
  text: string;
  /** The npm names of the packages, sorted. */
  packages: string[];
}

/** One version of the repository. `releases.json` holds an array of them, the newest version first. */
export interface Release {
  version: string;
  /** The ISO date of the version: from the git tag, the GitHub release, npm, or the changelog commit. */
  date: string;
  kind: ReleaseKind;
  /** The changes, the change with the most packages first. */
  changes: ReleaseChange[];
  /** The pages of the version: the GitHub release, the changelog section and the npm page. */
  links: Link[];
}

/** A release of the GitHub repository, as `githubReleases` gives it. */
export interface GitHubRelease {
  tag: string;
  name: string;
  /** The text of the release, as Markdown. */
  body: string;
  /** The ISO date of the publication. */
  publishedAt: string;
  url: string;
  prerelease: boolean;
}

/** The result of `githubReleases`. Without a token, or after an error, it has only the reason. */
export type GitHubReleases = { available: true; releases: GitHubRelease[] } | { available: false; reason: string };

/** The publication time of one version of one package on npm. */
export interface NpmVersionTime {
  name: string;
  version: string;
  date: string;
}

/** The result of `npmPublishTimes`: the times that npm gave, and a message for each package that failed. */
export interface NpmPublishTimes {
  times: NpmVersionTime[];
  problems: string[];
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** The class of a status. The board shows the open classes in this sequence, and "done" last. */
export type StatusClass = "waiting" | "blocked" | "progress" | "open" | "later" | "done";

/** One row of a table of the roadmap file. The text fields are inline Markdown. */
export interface BoardItem {
  id: string;
  title: string;
  /** The text of the Status cell, as the roadmap has it. */
  status: string;
  statusClass: StatusClass;
  owner?: string;
  area?: string;
  /** The IDs that the item needs, as the roadmap has them. */
  needs?: string;
  /** The nearest heading above the table, as plain text. */
  section: string;
  /** The line of the row in the roadmap file. */
  line: number;
  links: Link[];
}

/** The combined state of the checks of the last commit of a pull request. */
export type CheckState = "success" | "failure" | "pending" | "none";

/** An open pull request of the repository. */
export interface BoardPullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  branch: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  checks: CheckState;
}

/** An open issue of the repository. */
export interface BoardIssue {
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
}

/** The numbers of open pull requests and open issues on GitHub. A list can hold fewer than the total. */
export interface OpenWorkTotals {
  pullRequests: number;
  issues: number;
}

/** The result of `githubOpenWork`. Without a token, or after an error, it has only the reason. */
export type GitHubOpenWork =
  | { available: true; pullRequests: BoardPullRequest[]; issues: BoardIssue[]; totals: OpenWorkTotals }
  | { available: false; reason: string };

/** One measure of `kpi.json`. */
export interface KpiMeasure {
  /** The name of the measure, in lowercase words with single hyphens. */
  id: string;
  value: number;
  unit?: string;
  /** The ISO time of the data of this measure in UTC. Without it, the measure has the time of the file. */
  at?: string;
  /** The things that this count does not read, in plain words. So a 0 does not seem to tell more than the count measured. */
  notCounted?: string;
  /** The values that the project plans for this measure, each with its date. The list is in the order of the dates. */
  targets?: KpiTarget[];
}

/** One planned value of a measure, with the date for it. */
export interface KpiTarget {
  /** The planned value. It is a finite number that is not negative. */
  value: number;
  /** The date of the plan in UTC, as `YYYY-MM-DD`. */
  by: string;
}

/** One engine that made the data of `kpi.json`. */
export interface KpiEngine {
  /** The name of the engine, for example its npm name. */
  name: string;
  version: string;
}

/** The content of `kpi.json`, format `kpi/1`. */
export interface KpiFile {
  format: "kpi/1";
  /** The name of the project, in lowercase words with single hyphens. */
  project: string;
  /** The ISO time of the data in UTC, and not the time of the build. */
  at: string;
  /** The full commit of the build. */
  commit: string;
  measures: KpiMeasure[];
  /** The engines that made the data. The Status page shows them. */
  engines?: KpiEngine[];
}

/** One fault of a version section, with the changelog file that has it. */
export interface ChangelogFileFault {
  /** The path of the changelog file in the repository, with `/`. */
  file: string;
  version: string;
  /** The kind of the fault, as `changelogFaults` gives it. */
  kind: "no-statement" | "version-kind-only" | "break-unmarked" | "mark-without-break";
  /** The first statement of the section, or an empty text when it has none. */
  statement: string;
}

/** The reading of the changelogs of a repository against the rules of a version section. */
export interface ChangelogReading {
  /**
   * The oldest version that the gate examines: the field `sitePages.changelogFrom` of the root
   * `package.json`. It is null when the repository has no such field. Then the reading only reports.
   */
  from: string | null;
  /** The count of the version sections of the changelogs that the reading examined. */
  sections: number;
  /** The faults of those sections, in the order of the files. */
  faults: ChangelogFileFault[];
}

/** The data of the status page, as `status.json` holds it. */
export interface StatusBoardData {
  /** The ISO time of the build that read the data. */
  generatedAt: string;
  /** The commit of the build, or null. */
  commit: string | null;
  /** The roadmap file in the repository (null without a roadmap), and the repository on GitHub ("owner/name"). */
  source: { roadmap: string | null; github: string };
  items: BoardItem[];
  pullRequests: BoardPullRequest[];
  issues: BoardIssue[];
  /** The GitHub part. When GitHub was not available, the board shows the reason. */
  github: { available: boolean; reason?: string; totals?: OpenWorkTotals };
  /** The content of `kpi.json`, when the site has that file. */
  kpi?: KpiFile;
  /** The reading of the changelogs, when the repository has a changelog. */
  changelog?: ChangelogReading;
}
