// The rules of the read of the CI minutes (.github/workflows/ci-minutes.yml). `main.ts` reads the pull-request runs,
// their jobs and the changed files of their pull requests, and this file tells what each read gives. It uses no network.
//
// The read is the baseline of a test selector: a selector runs only the jobs and the tests that a change can affect.
// For a sample of the pull-request runs of each public repository, the read answers three questions.
// - Where does the time go? Each job, by its name, with the time of each class of its steps: setup, install, build,
//   test, check and other. A selector that runs fewer tests saves only test time. A selector that skips a job saves
//   all of its time.
// - What does each pull request change? Docs only, the lockfile, a workflow, a root file, or the folders of the
//   packages of a workspace, with the count of packages that it touches.
// - What can each part of a selector save? The minutes of the runs of docs-only pull requests, the minutes of the runs
//   that the lockfile, a workflow or a root file selects, and an upper bound for the package part: the test time times
//   the share of the packages of the repository that the pull request does not touch.
//
// The summary gives sums and counts only. ci-minutes.json keeps each record, so a later read takes its quantiles and
// intervals from the records with @mark1russell7/rigor-statistics, with no new read of the API.

/** The class of a step of a job. Setup, install and build are the fixed cost of a job. Test and check depend on the files. */
export type StepClass = "setup" | "install" | "build" | "test" | "check" | "other";

/** Each class of a step, in the order of the summary. */
export const STEP_CLASSES: readonly StepClass[] = ["setup", "install", "build", "test", "check", "other"];

/** A run of a workflow, with the fields of the REST API that the read uses. */
export interface Run {
  readonly id: number;
  readonly name: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly pull_requests: readonly { readonly number: number }[];
}

/** A step of a job. */
export interface Step {
  readonly name: string;
  readonly conclusion: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

/** A job of a run, with its steps. */
export interface Job {
  readonly name: string;
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly steps?: readonly Step[];
}

/** The record of one job that ran: its time, its time in the queue, and the time of each step with its class. */
export interface JobRecord {
  readonly repo: string;
  readonly workflow: string;
  readonly run: number;
  readonly pr: number;
  readonly job: string;
  readonly conclusion: string | null;
  readonly queueMs: number;
  readonly ms: number;
  /** The minutes of the job rounded up, as GitHub counts the minutes of each job. */
  readonly minutes: number;
  readonly steps: readonly { readonly name: string; readonly cls: StepClass; readonly ms: number }[];
}

/** The kind of the change of a pull request. The first kind that applies decides, in this order. */
export type ChangeKind = "large" | "docs-only" | "lockfile" | "workflow" | "root" | "packages" | "other";

/** The change of one pull request. */
export interface Change {
  readonly kind: ChangeKind;
  /** The count of changed files in the read, at most one page. */
  readonly files: number;
  /** The folders of the packages of the workspace that the change touches, for example `packages/core`. */
  readonly packages: readonly string[];
  readonly lockfile: boolean;
  readonly workflow: boolean;
  readonly root: boolean;
}

/** The read of one repository. */
export interface RepoRead {
  readonly repo: string;
  /** The count of the folders of packages of the workspace (packages/*), or 0 for a repository with one package. */
  readonly packages: number;
  /** The pull-request runs of the window. */
  readonly runs: number;
  /** The pull requests of those runs. */
  readonly pullRequests: number;
  /** The runs whose jobs the read has. */
  readonly sampled: number;
}

/** The record of the change of one pull request of the sample. */
export interface PrRecord {
  readonly repo: string;
  readonly pr: number;
  readonly change: Change;
}

/** The size of one page of the REST API. A list of changed files of this size can have more files. */
export const PAGE = 100;

/** This function gives the time from `start` to `end` in milliseconds, or 0 when a time is not known or the end is first. */
export function took(start: string | null | undefined, end: string | null | undefined): number {
  if (!start || !end) return 0;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * This function gives the class of a step from its name. The first rule that matches decides. A name with two classes,
 * for example "Build and test", gets the class of the first rule. Thus the test time is an upper bound.
 */
export function stepClass(name: string): StepClass {
  if (/^(Set up job|Complete job)$|^Post /i.test(name)) return "setup";
  if (/\binstall\b|\bnpm ci\b|setup-playwright/i.test(name)) return "install";
  if (/checkout|setup-node|action-setup|setup-cue|^set ?up\b|\bcache\b|artifact|^upload\b|^download\b/i.test(name)) return "setup";
  if (/\btests?\b|vitest|jest|\be2e\b|playwright|coverage|mutation|stryker|\bbench/i.test(name)) return "test";
  if (/\bbuild\b|compile|bundle|\bpack\b/i.test(name)) return "build";
  if (/lint|typecheck|type-check|\btsc\b|\bste\b|api.report|boundaries|conventions|format|prettier|biome|publint|knip|audit|\bcheck|security|scan|codeql|secret/i.test(name)) return "check";
  return "other";
}

/** This function tells if a job ran: it has a start and an end, and it was not skipped. */
export function ran(job: Job): boolean {
  return job.started_at !== null && job.completed_at !== null && job.conclusion !== "skipped";
}

/** This function gives the record of one job that ran. */
export function jobRecord(repo: string, workflow: string, run: number, pr: number, job: Job): JobRecord {
  const ms = took(job.started_at, job.completed_at);
  return {
    repo,
    workflow,
    run,
    pr,
    job: job.name,
    conclusion: job.conclusion,
    queueMs: took(job.created_at, job.started_at),
    ms,
    minutes: Math.max(1, Math.ceil(ms / 60_000)),
    steps: (job.steps ?? []).map((step) => ({ name: step.name, cls: stepClass(step.name), ms: took(step.started_at, step.completed_at) })),
  };
}

/** This function tells if a path is a document: a Markdown file, a file of a docs folder, a changeset or a license. */
export function isDocs(path: string): boolean {
  return /\.md$|(^|\/)docs\/|^\.changeset\/|(^|\/)LICENSE(\.|$)/.test(path);
}

/** This function gives the folder of the package of a path in a workspace, for example `packages/core`, or undefined. */
export function packageOf(path: string): string | undefined {
  return /^((?:packages|apps)\/[^/]+)\//.exec(path)?.[1];
}

/**
 * This function gives the change of a pull request from its changed files. A list of one full page can have more
 * files, also files that are not documents, so its kind is "large" before all other kinds, and a selector runs each
 * job for it. The root files are the files with no folder and the files of cue.mod, other than the lockfile and the
 * documents.
 */
export function changeOf(paths: readonly string[]): Change {
  const code = paths.filter((path) => !isDocs(path));
  const lockfile = code.some((path) => /(^|\/)pnpm-lock\.yaml$/.test(path));
  const workflow = code.some((path) => path.startsWith(".github/"));
  const root = code.some((path) => (!path.includes("/") && path !== "pnpm-lock.yaml") || path.startsWith("cue.mod/"));
  const packages = [...new Set(code.map(packageOf).filter((folder): folder is string => folder !== undefined))].sort();
  const other = code.some((path) => packageOf(path) === undefined && !path.startsWith(".github/") && path.includes("/") && !path.startsWith("cue.mod/"));
  const kind: ChangeKind =
    paths.length >= PAGE
      ? "large"
      : paths.length > 0 && code.length === 0
        ? "docs-only"
        : lockfile
          ? "lockfile"
          : workflow
            ? "workflow"
            : root
              ? "root"
              : packages.length > 0 && !other
                ? "packages"
                : "other";
  return { kind, files: paths.length, packages, lockfile, workflow, root };
}

/** This function gives `count` items of a list, spread over the list with the same step, in the order of the list. */
export function spread<T>(items: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  if (items.length <= count) return [...items];
  return Array.from({ length: count }, (_, i) => items[Math.floor((i * items.length) / count)] as T);
}

/** This function gives the completed pull-request runs of a list that name a pull request: the runs that the sample can take. */
export function sampleable(runs: readonly Run[]): Run[] {
  return runs.filter((run) => run.event === "pull_request" && run.status === "completed" && run.pull_requests.length > 0);
}

/** The time of a class of steps, in milliseconds. */
export type ClassMs = Record<StepClass, number>;

/** The sums of the time of one name of a job over the sample. */
export interface JobSum {
  readonly job: string;
  readonly repos: number;
  readonly count: number;
  readonly minutes: number;
  readonly ms: number;
  readonly classMs: ClassMs;
}

/** The sums of the runs of one kind of change. */
export interface KindSum {
  readonly kind: ChangeKind;
  readonly pullRequests: number;
  readonly jobs: number;
  readonly minutes: number;
  readonly testMs: number;
}

/** The summary of a read: sums and counts of the sample. */
export interface Summary {
  readonly repos: number;
  readonly runs: number;
  readonly pullRequests: number;
  readonly sampledRuns: number;
  readonly jobs: number;
  readonly minutes: number;
  readonly classMs: ClassMs;
  readonly queueMs: number;
  /** The jobs that waited 5 minutes or more in the queue. */
  readonly queuedLong: number;
  readonly byJob: readonly JobSum[];
  readonly byKind: readonly KindSum[];
  /** What each part of a selector can save, in rounded minutes of the sample. */
  readonly gain: {
    readonly docsOnly: number;
    readonly lockfile: number;
    readonly workflow: number;
    readonly root: number;
    /** An upper bound: the test time of the "packages" runs times the share of the packages that a change does not touch. */
    readonly packageTests: number;
  };
}

const zero = (): ClassMs => ({ setup: 0, install: 0, build: 0, test: 0, check: 0, other: 0 });

/** This function gives the summary of the records of a read. */
export function summarize(repos: readonly RepoRead[], jobs: readonly JobRecord[], prs: readonly PrRecord[]): Summary {
  const changes = new Map(prs.map((pr) => [`${pr.repo}#${pr.pr}`, pr.change]));
  const packages = new Map(repos.map((repo) => [repo.repo, repo.packages]));
  const classMs = zero();
  const byJob = new Map<string, { repos: Set<string>; count: number; minutes: number; ms: number; classMs: ClassMs }>();
  const byKind = new Map<ChangeKind, { prs: Set<string>; jobs: number; minutes: number; testMs: number }>();
  const gain = { docsOnly: 0, lockfile: 0, workflow: 0, root: 0, packageTests: 0 };
  let queueMs = 0;
  let queuedLong = 0;
  for (const record of jobs) {
    const stepMs = zero();
    for (const step of record.steps) stepMs[step.cls] += step.ms;
    for (const cls of STEP_CLASSES) classMs[cls] += stepMs[cls];
    queueMs += record.queueMs;
    if (record.queueMs >= 5 * 60_000) queuedLong++;
    const sum = byJob.get(record.job) ?? { repos: new Set<string>(), count: 0, minutes: 0, ms: 0, classMs: zero() };
    sum.repos.add(record.repo);
    sum.count++;
    sum.minutes += record.minutes;
    sum.ms += record.ms;
    for (const cls of STEP_CLASSES) sum.classMs[cls] += stepMs[cls];
    byJob.set(record.job, sum);
    const key = `${record.repo}#${record.pr}`;
    const change = changes.get(key);
    const kind: ChangeKind = change?.kind ?? "other";
    const k = byKind.get(kind) ?? { prs: new Set<string>(), jobs: 0, minutes: 0, testMs: 0 };
    k.prs.add(key);
    k.jobs++;
    k.minutes += record.minutes;
    k.testMs += stepMs.test;
    byKind.set(kind, k);
    if (kind === "docs-only") gain.docsOnly += record.minutes;
    if (kind === "lockfile") gain.lockfile += record.minutes;
    if (kind === "workflow") gain.workflow += record.minutes;
    if (kind === "root") gain.root += record.minutes;
    const count = packages.get(record.repo) ?? 0;
    if (kind === "packages" && change !== undefined && count > 0) {
      gain.packageTests += (stepMs.test / 60_000) * Math.max(0, 1 - change.packages.length / count);
    }
  }
  return {
    repos: repos.length,
    runs: repos.reduce((n, repo) => n + repo.runs, 0),
    pullRequests: repos.reduce((n, repo) => n + repo.pullRequests, 0),
    sampledRuns: repos.reduce((n, repo) => n + repo.sampled, 0),
    jobs: jobs.length,
    minutes: jobs.reduce((n, record) => n + record.minutes, 0),
    classMs,
    queueMs,
    queuedLong,
    byJob: [...byJob.entries()]
      .map(([job, sum]) => ({ job, repos: sum.repos.size, count: sum.count, minutes: sum.minutes, ms: sum.ms, classMs: sum.classMs }))
      .sort((a, b) => b.minutes - a.minutes || a.job.localeCompare(b.job)),
    byKind: [...byKind.entries()]
      .map(([kind, k]) => ({ kind, pullRequests: k.prs.size, jobs: k.jobs, minutes: k.minutes, testMs: k.testMs }))
      .sort((a, b) => b.minutes - a.minutes || a.kind.localeCompare(b.kind)),
    gain: { ...gain, packageTests: Math.round(gain.packageTests) },
  };
}

const share = (part: number, whole: number): string => (whole > 0 ? `${Math.round((100 * part) / whole)} %` : "no read");
const min = (ms: number): string => `${Math.round(ms / 60_000)}`;

/** This function gives the Markdown summary of a read: a headline, the classes of the steps, the kinds of change, the gain and the jobs. */
export function render(summary: Summary, days: number, notRead: readonly string[], top = 15): string[] {
  const stepMs = STEP_CLASSES.reduce((n, cls) => n + summary.classMs[cls], 0);
  const out = [
    "## CI minutes",
    "",
    `${summary.repos} repositories, ${summary.runs} pull-request runs of ${summary.pullRequests} pull requests in ${days} days. ` +
      `The sample: ${summary.sampledRuns} runs, ${summary.jobs} jobs, ${summary.minutes} minutes (each job rounded up). ` +
      `${summary.queuedLong} jobs waited 5 minutes or more in the queue.`,
  ];
  if (notRead.length > 0) out.push("", `No read: ${notRead.join(", ")}.`);
  out.push("", "| Class of step | Minutes | Share |", "| --- | ---: | ---: |");
  for (const cls of STEP_CLASSES) out.push(`| ${cls} | ${min(summary.classMs[cls])} | ${share(summary.classMs[cls], stepMs)} |`);
  out.push("", "| Change | Pull requests | Jobs | Minutes | Test minutes |", "| --- | ---: | ---: | ---: | ---: |");
  for (const k of summary.byKind) out.push(`| ${k.kind} | ${k.pullRequests} | ${k.jobs} | ${k.minutes} | ${min(k.testMs)} |`);
  const g = summary.gain;
  out.push(
    "",
    "| Part of a selector | Minutes of the sample | Share |",
    "| --- | ---: | ---: |",
    `| Docs only: no job | ${g.docsOnly} | ${share(g.docsOnly, summary.minutes)} |`,
    `| Lockfile: the packages whose dependencies changed | ${g.lockfile} | ${share(g.lockfile, summary.minutes)} |`,
    `| Workflow: the jobs of that workflow | ${g.workflow} | ${share(g.workflow, summary.minutes)} |`,
    `| Root file: the tools that read it | ${g.root} | ${share(g.root, summary.minutes)} |`,
    `| Packages: the tests of the touched packages (upper bound) | ${g.packageTests} | ${share(g.packageTests, summary.minutes)} |`,
    "",
    "The rows lockfile, workflow and root give the minutes of those runs today. A selector saves only a part of them.",
    "",
    `| Job (top ${top}) | Repositories | Jobs | Minutes | Setup and install | Build | Test | Check |`,
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const j of summary.byJob.slice(0, top)) {
    out.push(
      `| ${j.job.replaceAll("|", "\\|")} | ${j.repos} | ${j.count} | ${j.minutes} | ${min(j.classMs.setup + j.classMs.install)} | ${min(j.classMs.build)} | ${min(j.classMs.test)} | ${min(j.classMs.check)} |`,
    );
  }
  return out;
}
