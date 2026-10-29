// Moves the pins of the template in the release.yml of other repositories: one pull request each.
// With --file, it moves the pins of a different workflow, for example ai-review.yml.
//
//   node scripts/release/bump-pins.ts [--sha <commit>] [--file <workflow>] [--dry-run] <owner/repo> ...
//
// A repository pins each shared release workflow and action of the template to a commit of main:
//
//   uses: mark1russell7/template/.github/actions/npm-publish@<full commit SHA> # main
//
// Renovate does not change release.yml (renovate/README.md). A workflow change between the merge of
// a version and its release run makes the tag job fail with HTTP 403 (RELEASING.md). Thus the release
// session moves these pins itself, at a quiet time. For each repository, the script:
//   1. Reads .github/workflows/release.yml (or the --file workflow) of main with the GitHub API.
//   2. Finds the pins of the template. It skips the repository when it has no pin, or when each pin
//      is at the target commit. It refuses a target that is older than a pin.
//   3. Refuses the repository when a release can start. An open pull request to main changes the
//      "version" of a package.json, for example "Version the packages" of Changesets. Or a pull
//      request is on a branch release/<version>. Or GitHub has a run of release.yml that is not complete.
//   4. Makes a branch from main, commits the new workflow on it (contents API) and opens a pull
//      request (pulls API). The script makes no clone.
//   5. Shows the address of the pull request.
//
// After a refusal or an error, the script goes to the next repository. The summary at the end shows
// the result of each repository. The exit code is 1 when a repository has a refusal or an error.
//
// Options:
//   --sha <commit>       The target commit of the template (default: the head of main). It must be
//                        on main, because each pin follows main ("# main").
//   --file <workflow>    The workflow file in .github/workflows/ (default: release.yml), for example
//                        ai-review.yml. Renovate moves these pins each week. The script moves them now,
//                        with the same release check, when a change of the template must not wait.
//   --dry-run            Shows the plan. It makes no branch, no commit and no pull request.
//   --check              Only does the release check of step 3. It changes nothing. Do this check
//                        immediately before the merge of a pull request of this script.
//   --notes <text>       A paragraph for the pull request: what the new commits of the template bring.
//   --co-author <name>   Adds "Co-Authored-By: <name>" to the commit message, for example
//                        "Claude Opus 5.5 <noreply@anthropic.com>".
//   --footer <text>      The last line of the text of the pull request.
//
// A repository without an owner ("vex") gets the owner of the template. The script uses gh with its
// account. The token of gh needs the scope "workflow" to change a workflow file.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ON_MAIN, compareWithMain, errorText } from "./dispatch.ts";

/** A function that starts gh with these arguments and the text on its input, and gives its output text. */
export type Run = (args: readonly string[], input?: string) => string;

/** A pin of the template in a workflow: the path after the template name, and the commit. */
export interface Pin {
  readonly path: string;
  readonly sha: string;
}

/** A commit of the template. */
export interface Commit {
  readonly sha: string;
  readonly message: string;
}

/** A changed file of a pull request, as GitHub gives it. A big change has no patch. */
export interface PullFile {
  readonly filename?: string;
  readonly patch?: string | null | undefined;
}

/** An open pull request. */
export interface Pull {
  readonly number: number;
  readonly head: string;
  readonly url: string;
}

/** A run of release.yml that is not complete. */
export interface ReleaseRun {
  readonly status: string;
  readonly url: string;
}

/** The result of the script for one repository. */
export interface RepoResult {
  readonly repository: string;
  readonly result: "opened" | "planned" | "skipped" | "refused" | "error" | "quiet";
  readonly text: string;
  readonly url?: string | undefined;
}

/** The options of the command line. */
export interface BumpOptions {
  readonly dryRun: boolean;
  readonly check: boolean;
  readonly sha?: string;
  readonly workflow?: string;
  readonly notes?: string;
  readonly coAuthor?: string;
  readonly footer?: string;
}

/** The result of parseArgs(): the repositories and the options, or an error. */
export type ParsedArgs = { readonly repositories: string[]; readonly options: BumpOptions; readonly error?: undefined } | { readonly error: string; readonly repositories?: undefined; readonly options?: undefined };

/** The compare of an old pin with the target, as the script asks GitHub for it. */
interface Compare {
  readonly status: string;
  readonly commits: readonly Commit[];
}

export const TEMPLATE: string = "mark1russell7/template";
export const WORKFLOW: string = ".github/workflows/release.yml";
export const BASE: string = "main";

/** The folder of the workflows. --file names a file in it. */
export const WORKFLOWS: string = ".github/workflows/";

/** The branches of a version: "Version the packages" of Changesets, and release/<version> (RELEASING.md). */
export const VERSION_BRANCH: RegExp = /^(changeset-release|release)\//;

/** The most commits of the template that the text of a pull request lists. */
export const MAX_COMMITS: number = 40;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A pin of the template: "mark1russell7/template/<path>@<40 hex> # main".
const PIN = new RegExp(`(${escape(TEMPLATE)}/[^\\s@]+)@([0-9a-f]{40})(?=[ \\t]+#[ \\t]*main\\b)`, "g");

/** This function starts gh and gives its output text. Its error has the error text of gh. */
function gh(args: readonly string[], input?: string): string {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      ...(input === undefined ? {} : { input }),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    throw new Error(String(stderr ?? "").trim() || errorText(error));
  }
}

/** This function gives the JSON values of an output with one JSON value on each line (gh --jq). */
const jsonLines = <T>(text: string): T[] =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);

const short = (sha: string): string => sha.slice(0, 7);

/** This function gives the file name of a workflow path: "release.yml". */
const fileName = (workflow: string): string => workflow.slice(workflow.lastIndexOf("/") + 1);

/** This function gives the name of a workflow without its extension: "release". */
const stem = (workflow: string): string => fileName(workflow).replace(/\.ya?ml$/, "");

/**
 * This function gives the path of the workflow for the option --file, or undefined for a value that is not
 * a workflow file. It accepts "ai-review.yml" and ".github/workflows/ai-review.yml".
 */
export function workflowPath(file: string): string | undefined {
  const name = file.startsWith(WORKFLOWS) ? file.slice(WORKFLOWS.length) : file;
  return /^[\w.-]+\.ya?ml$/.test(name) && !name.startsWith(".") ? `${WORKFLOWS}${name}` : undefined;
}

/** This function gives the first line of an error, for the output. */
const firstLine = (error: unknown): string => errorText(error).trim().split("\n")[0] ?? "";

/** This function gives the pins of the template in a workflow text: [{ path, sha }], in the sequence of the text. */
export function findPins(text: string): Pin[] {
  return [...text.matchAll(PIN)].map((match) => ({ path: (match[1] ?? "").slice(TEMPLATE.length + 1), sha: match[2] ?? "" }));
}

/** This function gives the workflow text with each pin of the template at the target commit. The other text stays the same. */
export function replacePins(text: string, target: string): string {
  return text.replace(PIN, (_: string, path: string) => `${path}@${target}`);
}

/**
 * This function tells if the changed files of a pull request change the "version" of a package.json.
 * `files` has { filename, patch } for each package.json. A file without a patch (GitHub gives none for a
 * big change) counts as a version change.
 */
export function changesVersion(files: readonly PullFile[]): boolean {
  return files.some(({ patch }) => typeof patch !== "string" || /^[+-]\s*"version"\s*:/m.test(patch));
}

/**
 * This function gives the reasons that a release can start in a repository, or an empty list. `pulls` has
 * { number, head, url } for each open pull request to main. `filesOf(number)` gives the package.json
 * files of a pull request ({ filename, patch }). `runs` has { status, url } for each run of release.yml
 * that is not complete. `ownBranch` is the branch of this script: its pull request does not count.
 */
export function releaseBlockers({
  pulls,
  filesOf,
  runs,
  ownBranch,
}: {
  readonly pulls: readonly Pull[];
  readonly filesOf: (number: number) => readonly PullFile[];
  readonly runs: readonly ReleaseRun[];
  readonly ownBranch?: string | undefined;
}): string[] {
  const reasons = runs.map(({ status, url }) => `a run of release.yml is ${status.replaceAll("_", " ")}: ${url}`);
  for (const { number, head, url } of pulls) {
    if (head === ownBranch) continue;
    if (VERSION_BRANCH.test(head)) {
      reasons.push(`the open pull request #${number} is on the version branch ${head}: ${url}`);
      continue;
    }
    if (changesVersion(filesOf(number))) reasons.push(`the open pull request #${number} changes the version of a package.json: ${url}`);
  }
  return reasons;
}

/** This function gives the branch of the pull request for a target commit and a workflow. */
export const branchName = (target: string, workflow: string = WORKFLOW): string => `ci/template-${stem(workflow)}-pins-${short(target)}`;

/** This function gives the title of the pull request for a target commit and a workflow. */
export const prTitle = (target: string, workflow: string = WORKFLOW): string => `ci: move the template ${stem(workflow)} pins to ${short(target)}`;

/** This function makes the text of a commit subject safe for a pull request of a different repository. */
export function commitSubject(message: string): string {
  return (
    (message.split("\n")[0] ?? "")
      // "#40" in a different repository is a different issue: name the template.
      .replace(/(^|[\s([])#(\d+)\b/g, `$1${TEMPLATE}#$2`)
      // A name with "@" in code font notifies no person.
      .replace(/(^|\s)(@[\w./-]+)/g, "$1`$2`")
  );
}

/**
 * This function gives the text of the pull request. `pins` has { path, sha } for each changed pin.
 * `commits` has { sha, message } for each new commit of the template, oldest first.
 */
export function prBody({
  repository,
  target,
  pins,
  commits,
  notes,
  footer,
  workflow = WORKFLOW,
}: {
  readonly repository: string;
  readonly target: string;
  readonly pins: readonly Pin[];
  readonly commits: readonly Commit[];
  readonly notes?: string | undefined;
  readonly footer?: string | undefined;
  readonly workflow?: string | undefined;
}): string {
  const link = (sha: string): string => `[\`${short(sha)}\`](https://github.com/${TEMPLATE}/commit/${sha})`;
  const renovate =
    workflow === WORKFLOW
      ? "Renovate does not change `release.yml` (`RELEASING.md` of the template)."
      : "Renovate also moves these pins in its weekly group. This pull request moves them now.";
  const lines = [
    `This pull request moves the pins of \`${TEMPLATE}\` in \`${workflow}\` to ${link(target)} of \`main\`. ` +
      `\`scripts/release/bump-pins.ts\` of the template opened it. ${renovate}`,
    "",
    "| Pin | From | To |",
    "|---|---|---|",
    ...pins.map(({ path, sha }) => `| \`${path}\` | ${link(sha)} | ${link(target)} |`),
    "",
    "## What the new commits of the template bring",
    "",
  ];
  if (notes) lines.push(notes, "");
  if (commits.length === 0) lines.push("The template has no new commit since the old pins.");
  else {
    lines.push("The commits of the template after the old pins:", "");
    const newest = commits.slice(-MAX_COMMITS).reverse();
    for (const { sha, message } of newest) lines.push(`- ${link(sha)} ${commitSubject(message)}`);
    if (commits.length > MAX_COMMITS) lines.push(`- ${commits.length - MAX_COMMITS} older commits.`);
  }
  lines.push(
    "",
    "## Before the merge",
    "",
    "A workflow change between the merge of a version and its release run makes the tag job fail with HTTP 403. " +
      "When the script opened this pull request, no open pull request changed a package version, and no run of `release.yml` was active.",
    "",
    `Immediately before the merge, do the check again: \`node scripts/release/bump-pins.ts --check ${repository}\` in the template.`,
  );
  if (footer) lines.push("", footer);
  return `${lines.join("\n")}\n`;
}

/** This function gives the commit message. */
export function commitMessage({
  target,
  pins,
  coAuthor,
  workflow = WORKFLOW,
}: {
  readonly target: string;
  readonly pins: readonly Pin[];
  readonly coAuthor?: string | undefined;
  readonly workflow?: string | undefined;
}): string {
  const from = [...new Set(pins.map(({ sha }) => short(sha)))].join(", ");
  const lines = [
    prTitle(target, workflow),
    "",
    `The pins of ${TEMPLATE} in ${fileName(workflow)} go from ${from} to ${short(target)} (scripts/release/bump-pins.ts of the template).`,
  ];
  if (coAuthor) lines.push("", `Co-Authored-By: ${coAuthor}`);
  return lines.join("\n");
}

/** This function gives the full commit SHA of the target, and stops when the commit is not on main. */
export function resolveTarget(sha: string | undefined, run: Run = gh): string {
  const full = run(["api", `repos/${TEMPLATE}/commits/${sha ?? BASE}`, "--jq", ".sha"]).trim();
  if (!/^[0-9a-f]{40}$/.test(full)) throw new Error(`GitHub gave no commit for ${sha ?? BASE}`);
  if (sha !== undefined) {
    const status = compareWithMain(TEMPLATE, full, run);
    if (!ON_MAIN.has(status)) throw new Error(`the commit ${full} is not on main of ${TEMPLATE} (status: ${status})`);
  }
  return full;
}

/** This function gives the reasons that a release can start in a repository (step 3), with the open pull requests. */
export function checkRepo(
  repository: string,
  { ownBranch }: { readonly ownBranch?: string | undefined } = {},
  run: Run = gh,
): { pulls: Pull[]; blockers: string[] } {
  let runs: ReleaseRun[];
  try {
    runs = jsonLines<ReleaseRun>(
      run(["api", `repos/${repository}/actions/workflows/release.yml/runs?per_page=30`, "--jq", '.workflow_runs[] | select(.status != "completed") | {status, url: .html_url}']),
    );
  } catch (error) {
    // A repository without release.yml (HTTP 404) has no release run. The version pull requests still count.
    if (!/HTTP 404|Not Found/.test(firstLine(error))) throw error;
    runs = [];
  }
  const pulls = jsonLines<Pull>(
    run(["api", "--paginate", `repos/${repository}/pulls?state=open&base=${BASE}&per_page=100`, "--jq", ".[] | {number, head: .head.ref, url: .html_url}"]),
  );
  const filesOf = (number: number): PullFile[] =>
    jsonLines<PullFile>(
      run([
        "api",
        "--paginate",
        `repos/${repository}/pulls/${number}/files?per_page=100`,
        "--jq",
        '.[] | select(.filename == "package.json" or (.filename | endswith("/package.json"))) | {filename, patch}',
      ]),
    );
  return { pulls, blockers: releaseBlockers({ pulls, filesOf, runs, ownBranch }) };
}

/**
 * This function moves the pins of one repository (steps 1 to 5). It gives { repository, result, text, url }:
 * result is "opened", "planned", "skipped", "refused" or "error". `compareCache` keeps the compare of
 * each old pin, for the next repositories.
 */
export function bumpRepo(
  repository: string,
  {
    target,
    workflow = WORKFLOW,
    dryRun = false,
    notes,
    coAuthor,
    footer,
    compareCache = new Map<string, Compare>(),
  }: {
    readonly target: string;
    readonly workflow?: string | undefined;
    readonly dryRun?: boolean | undefined;
    readonly notes?: string | undefined;
    readonly coAuthor?: string | undefined;
    readonly footer?: string | undefined;
    readonly compareCache?: Map<string, Compare> | undefined;
  },
  run: Run = gh,
): RepoResult {
  const done = (result: RepoResult["result"], text: string, url?: string): RepoResult => ({ repository, result, text, url });
  const branch = branchName(target, workflow);

  let head: string;
  let file: { content: string; sha: string };
  try {
    head = run(["api", `repos/${repository}/git/ref/heads/${BASE}`, "--jq", ".object.sha"]).trim();
    file = JSON.parse(run(["api", `repos/${repository}/contents/${workflow}?ref=${head}`])) as { content: string; sha: string };
  } catch (error) {
    if (/HTTP 404|Not Found/.test(firstLine(error))) return done("skipped", `no ${workflow} on ${BASE}`);
    return done("error", `GitHub did not give ${workflow}: ${firstLine(error)}`);
  }
  const text = Buffer.from(file.content, "base64").toString("utf8");
  const pins = findPins(text);
  if (pins.length === 0) return done("skipped", `${workflow} has no pin of ${TEMPLATE} ("@<commit> # main")`);
  const old = pins.filter(({ sha }) => sha !== target);
  if (old.length === 0) return done("skipped", `each pin is at ${short(target)}`);

  // The new commits of the template, and a target that is older than a pin.
  const commits = new Map<string, Commit>();
  for (const sha of new Set(old.map((pin) => pin.sha))) {
    let compare = compareCache.get(sha);
    if (compare === undefined) {
      try {
        compare = JSON.parse(
          run([
            "api",
            `repos/${TEMPLATE}/compare/${sha}...${target}`,
            "--jq",
            "{status, commits: [.commits[] | {sha, message: .commit.message}]}",
          ]),
        ) as Compare;
      } catch (error) {
        return done("error", `GitHub did not compare the pin ${short(sha)} with ${short(target)}: ${firstLine(error)}`);
      }
      compareCache.set(sha, compare);
    }
    if (compare.status === "behind") return done("refused", `the target ${short(target)} is older than the pin ${short(sha)}`);
    for (const commit of compare.commits) commits.set(commit.sha, commit);
  }

  let check: { pulls: Pull[]; blockers: string[] };
  try {
    check = checkRepo(repository, { ownBranch: branch }, run);
  } catch (error) {
    return done("refused", `the release check failed, so the script did not continue: ${firstLine(error)}`);
  }
  const own = check.pulls.find((pull) => pull.head === branch);
  if (own !== undefined) return done("skipped", `the pull request #${own.number} for ${short(target)} is open`, own.url);
  if (check.blockers.length > 0) return done("refused", `a release can start (HTTP 403 of the tag job): ${check.blockers.join("; ")}`);

  const changed = old.map(({ path, sha }) => ({ path, sha }));
  const plan = `${changed.length} of ${pins.length} pins from ${[...new Set(changed.map(({ sha }) => short(sha)))].join(", ")} to ${short(target)}`;
  if (dryRun) return done("planned", `${plan}, on the branch ${branch}`);

  try {
    run(["api", "-X", "POST", `repos/${repository}/git/refs`, "--input", "-", "--jq", ".ref"], JSON.stringify({ ref: `refs/heads/${branch}`, sha: head }));
  } catch (error) {
    return done("error", `GitHub did not make the branch ${branch} (remove an old branch with that name): ${firstLine(error)}`);
  }
  try {
    run(
      ["api", "-X", "PUT", `repos/${repository}/contents/${workflow}`, "--input", "-", "--jq", ".commit.sha"],
      JSON.stringify({
        message: commitMessage({ target, pins: changed, coAuthor, workflow }),
        content: Buffer.from(replacePins(text, target), "utf8").toString("base64"),
        sha: file.sha,
        branch,
      }),
    );
    const url = run(
      ["api", "-X", "POST", `repos/${repository}/pulls`, "--input", "-", "--jq", ".html_url"],
      JSON.stringify({
        title: prTitle(target, workflow),
        head: branch,
        base: BASE,
        body: prBody({ repository, target, pins: changed, commits: [...commits.values()], notes, footer, workflow }),
      }),
    ).trim();
    return done("opened", plan, url);
  } catch (error) {
    // No pull request: remove the branch, so that the next start of the script can make it again.
    try {
      run(["api", "-X", "DELETE", `repos/${repository}/git/refs/heads/${branch}`]);
    } catch {
      // The error text below tells the cause.
    }
    return done("error", `GitHub did not commit or open the pull request: ${firstLine(error)}`);
  }
}

/** This function reads the arguments. It gives { repositories, options } or { error }. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const valued: Readonly<Record<string, "sha" | "file" | "notes" | "coAuthor" | "footer">> = {
    "--sha": "sha",
    "--file": "file",
    "--notes": "notes",
    "--co-author": "coAuthor",
    "--footer": "footer",
  };
  const values: Partial<Record<"sha" | "file" | "notes" | "coAuthor" | "footer", string>> = {};
  let dryRun = false;
  let check = false;
  const repositories: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const key = Object.hasOwn(valued, arg) ? valued[arg] : undefined;
    if (key !== undefined) {
      const next = argv[i + 1];
      if (next === undefined) return { error: `${arg} needs a value` };
      values[key] = next;
      i++;
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--check") check = true;
    else if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    else if (/^[\w.-]+(\/[\w.-]+)?$/.test(arg)) repositories.push(arg.includes("/") ? arg : `${TEMPLATE.split("/")[0]}/${arg}`);
    else return { error: `not a repository: ${arg}` };
  }
  if (repositories.length === 0) return { error: "no repository" };
  const { file, ...rest } = values;
  if (file === undefined) return { repositories, options: { dryRun, check, ...rest } };
  const workflow = workflowPath(file);
  if (workflow === undefined) return { error: `not a workflow file in ${WORKFLOWS}: ${file}` };
  return { repositories, options: { dryRun, check, ...rest, workflow } };
}

// This part runs for "node bump-pins.ts", not for an import (the tests). realpath: the path can have a link.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error !== undefined) {
    process.stderr.write(
      `${parsed.error}\nusage: node scripts/release/bump-pins.ts [--sha <commit>] [--file <workflow>] [--dry-run | --check] [--notes <text>] [--co-author <name>] [--footer <text>] <owner/repo> ...\n`,
    );
    process.exit(2);
  }
  const { repositories, options } = parsed;
  const results: RepoResult[] = [];
  if (options.check) {
    for (const repository of repositories) {
      try {
        const { blockers } = checkRepo(repository);
        results.push({ repository, result: blockers.length === 0 ? "quiet" : "refused", text: blockers.join("; ") || "no version pull request and no active release run" });
      } catch (error) {
        results.push({ repository, result: "error", text: `the release check failed: ${firstLine(error)}` });
      }
      const last = results.at(-1);
      if (last !== undefined) process.stdout.write(`${repository}: ${last.result}: ${last.text}\n`);
    }
  } else {
    let target = "";
    try {
      target = resolveTarget(options.sha);
    } catch (error) {
      process.stderr.write(`The target commit is not correct: ${firstLine(error)}\n`);
      process.exit(1);
    }
    process.stdout.write(`Target: ${TEMPLATE}@${target}, file: ${options.workflow ?? WORKFLOW}${options.dryRun ? " (dry run: no change)" : ""}\n`);
    const compareCache = new Map<string, Compare>();
    for (const repository of repositories) {
      const result = bumpRepo(repository, { ...options, target, compareCache });
      results.push(result);
      process.stdout.write(`${repository}: ${result.result}: ${result.text}${result.url ? ` ${result.url}` : ""}\n`);
    }
  }
  process.stdout.write("\nSummary:\n");
  for (const { repository, result, url } of results) process.stdout.write(`  ${result.padEnd(8)} ${repository}${url ? `  ${url}` : ""}\n`);
  process.exit(results.some(({ result }) => result === "refused" || result === "error") ? 1 : 0);
}
