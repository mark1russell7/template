// The compare of the conventions rules of a pull request with the rules of its base, over the public repositories
// that use @mark1russell7/conventions (CI.md, "The compare of the conventions rules"). The job rules of
// ci.yml starts it:
//
//   GH_TOKEN=... node next/scripts/workflows/rule-compare.ts --base <dir> --next <dir> --out <dir> --work <dir> [--jobs <n>] [--repos <JSON list of owner/name>]
//
// With no --repos, repoList() reads the public repositories of each owner of the package conventions that are not
// archived. Thus a repository that moves to another owner stays in the compare. The read comes from scripts/lib/gh.ts,
// with its retry after a transient error, so the job installs @mark1russell7/service next to @mark1russell7/text.
//
// A change of a rule can fail a repository that passed before. The repository sees the failure only when the train moves
// its version of conventions, and that pull request of the train is red. So this script finds such failures before the
// change merges:
//   1. It clones each repository of the list (one commit, no tags). scopeOf() puts a repository with no dependency on
//      @mark1russell7/conventions in its root package.json out of scope.
//   2. It starts `conventions check --json --no-base` of the base and of the pull request in the clone, one after the
//      other. checkEnv() gives the check the event file of a dispatched run of that repository, so no rule reads the
//      pull request of the template, and the rules that examine a change skip.
//   3. newFailures() compares the failures at each place. A place is a rule and a file with its line. A place with more
//      failures in the check of the pull request than in the check of the base has new failures. A place with the same
//      count and a different text has a changed text: that is not a new failure.
//   4. A repository with a new failure gets a second pair, and confirmed() keeps the new failures that both pairs give.
//   5. A confirmed new failure fails the job. A new failure of one pair only is a warning. A repository with no result of
//      the base is a no read, with a warning. A result of the base and none of the pull request fails.
// The summary names each rule that skips in each repository with a result: the compare cannot read such a rule.
//
// With --tool boundaries, the compare examines a change of @mark1russell7/boundaries in the same way (CI.md, "The compare
// of the import boundaries"). A repository with a dependency on it and the script check:boundaries in its root package.json
// is in scope. The script installs the clone, links the package of the base and then of the pull request into its
// node_modules, and starts the depcruise command of check:boundaries with a JSON output. A place is a rule and the file of
// the import, and boundaryResult() gives the violations as a result of the same form.
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { escapeMarkdown, escapeWorkflowData } from "@mark1russell7/text";
import { OWNERS } from "../../packages/conventions/src/owners.ts";
import { type OwnedRepo, pool, publicRepos } from "../lib/gh.ts";

/** One break of a rule in the JSON output of `conventions check`. */
export interface CheckBreak {
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

/** One rule in the JSON output of `conventions check`. */
export interface CheckRule {
  readonly id: string;
  readonly status: "pass" | "break" | "warn" | "off" | "skipped" | "error";
  readonly breaks: readonly CheckBreak[];
  readonly note?: string;
}

/** The part of the JSON output of `conventions check` that the compare reads. */
export interface CheckResult {
  readonly rules: readonly CheckRule[];
}

/** One failure of a check: a break of a rule with the status `break`, or a rule that threw. */
export interface Failure {
  readonly rule: string;
  readonly place: string;
  readonly message: string;
}

/** The place of the failure of a rule that threw. */
export const THREW = "(the rule threw)";

/** This function gives the place of a break: its file, and its line when it has one. */
const placeOf = (item: CheckBreak): string => (item.line === undefined ? item.file : `${item.file}:${String(item.line)}`);

/** This function gives each failure of a check. A break of a rule with the status `warn` does not fail the check. */
export function failures(result: CheckResult): Failure[] {
  return result.rules.flatMap((rule): Failure[] => {
    if (rule.status === "error") return [{ rule: rule.id, place: THREW, message: rule.note ?? "" }];
    if (rule.status !== "break") return [];
    return rule.breaks.map((item) => ({ rule: rule.id, place: placeOf(item), message: item.message }));
  });
}

/** This function gives the failures of each place: the key is the rule and the place. */
function byPlace(items: readonly Failure[]): Map<string, Failure[]> {
  const groups = new Map<string, Failure[]>();
  for (const item of items) {
    const key = `${item.rule}\u0000${item.place}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

/**
 * The difference of two checks: the new failures, the failures with a changed text at the same place, and the gone
 * failures. A gone failure is a failure of the base at a place with fewer failures in the pull request.
 */
export interface Difference {
  readonly fresh: readonly Failure[];
  readonly retold: readonly Failure[];
  readonly gone: readonly Failure[];
}

/**
 * This function keeps the failures of `mine` with no failure of the same text at the same place in `other`. They go
 * into `more` when their place has more failures in `mine`, else into `same`.
 */
function unmatched(mine: Map<string, Failure[]>, other: Map<string, Failure[]>): { more: Failure[]; same: Failure[] } {
  const more: Failure[] = [];
  const same: Failure[] = [];
  for (const [key, items] of mine) {
    const old = other.get(key) ?? [];
    const left = new Map<string, number>();
    for (const item of old) left.set(item.message, (left.get(item.message) ?? 0) + 1);
    const unknown = items.filter((item) => {
      const count = left.get(item.message) ?? 0;
      if (count > 0) left.set(item.message, count - 1);
      return count === 0;
    });
    (items.length > old.length ? more : same).push(...unknown);
  }
  return { more, same };
}

/**
 * This function compares the failures of `next` with the failures of `base` at each place. It keeps the failures of
 * `next` with no failure of the same text in `base`. They are new when their place has more failures in `next`.
 * Else they have a changed text. The failures of `base` at a place with fewer failures in `next` are gone.
 */
export function newFailures(base: CheckResult, next: CheckResult): Difference {
  const before = byPlace(failures(base));
  const after = byPlace(failures(next));
  const { more: fresh, same: retold } = unmatched(after, before);
  return { fresh, retold, gone: unmatched(before, after).more };
}

/** This function gives the key of a failure: its rule, its place and its text. */
const failureKey = (item: Failure): string => `${item.rule}\u0000${item.place}\u0000${item.message}`;

/** This function keeps the new failures of the first pair that the second pair also gives. */
export function confirmed(first: readonly Failure[], second: readonly Failure[]): Failure[] {
  const again = new Set(second.map(failureKey));
  return first.filter((item) => again.has(failureKey(item)));
}

/** The results of one pair of checks: the check of the base and the check of the pull request. A missing result is `undefined`. */
export interface Pair {
  readonly base?: CheckResult | undefined;
  readonly next?: CheckResult | undefined;
}

/** The parts of the outcome of a repository with a result of both checks. */
interface Read {
  readonly repo: string;
  /** The rules that skip in the check of the pull request. */
  readonly skipped: readonly string[];
  /** The failures with a changed text at the same place, in the first pair. */
  readonly retold: readonly Failure[];
  /** The failures of the base that the pull request does not give, in the first pair. */
  readonly gone: readonly Failure[];
}

/** The result of the compare of one repository. */
export type RepoOutcome =
  | (Read & { readonly kind: "same"; readonly rules: number })
  | (Read & { readonly kind: "new"; readonly failures: readonly Failure[] })
  | (Read & { readonly kind: "once"; readonly failures: readonly Failure[] })
  | { readonly repo: string; readonly kind: "next-unread"; readonly reason: string }
  | { readonly repo: string; readonly kind: "unread"; readonly reason: string }
  | { readonly repo: string; readonly kind: "off"; readonly reason: string };

/** This function gives the outcome of a repository from the results of its first pair, and of its second pair when it has one. */
export function outcome(repo: string, first: Pair, second?: Pair): RepoOutcome {
  if (first.base === undefined) return { repo, kind: "unread", reason: "the check of the base gave no result" };
  if (first.next === undefined) return { repo, kind: "next-unread", reason: "the check of the pull request gave no result, and the check of the base gave one" };
  const skipped = first.next.rules.filter((rule) => rule.status === "skipped").map((rule) => rule.id);
  const { fresh, retold, gone } = newFailures(first.base, first.next);
  if (fresh.length === 0) return { repo, kind: "same", rules: first.next.rules.length, skipped, retold, gone };
  if (second?.base === undefined || second.next === undefined) return { repo, kind: "once", failures: fresh, skipped, retold, gone };
  const both = confirmed(fresh, newFailures(second.base, second.next).fresh);
  return both.length > 0 ? { repo, kind: "new", failures: both, skipped, retold, gone } : { repo, kind: "once", failures: fresh, skipped, retold, gone };
}

/** This function tells if an outcome fails the compare: a confirmed new failure, or no result of the pull request only. */
export const fails = (each: RepoOutcome): boolean => each.kind === "new" || each.kind === "next-unread";

/** The name of the package of the rules. */
export const CONVENTIONS = "@mark1russell7/conventions";

/** The name of the package of the import boundaries. */
export const BOUNDARIES = "@mark1russell7/boundaries";

/** The script of a root `package.json` that starts the check of the import boundaries. */
export const BOUNDARY_SCRIPT = "check:boundaries";

/** A package of the template that each repository starts as a check. The option `--tool` names one. */
export interface Tool {
  readonly name: "conventions" | "boundaries";
  /** The package. A repository with no dependency on it in its root `package.json` is out of scope. */
  readonly package: string;
  /** The words of the title of the summary. */
  readonly title: string;
  /** The title of the workflow commands. */
  readonly label: string;
}

/** The tools of the compare. */
export const TOOLS: Readonly<Record<Tool["name"], Tool>> = {
  conventions: { name: "conventions", package: CONVENTIONS, title: "the conventions rules", label: "Rule compare" },
  boundaries: { name: "boundaries", package: BOUNDARIES, title: "the import boundaries", label: "Boundary compare" },
};

/**
 * This function reads the text of the root `package.json` of a repository. It gives the reason that the repository is
 * out of scope for the package `name`, or undefined when the compare examines it. A file that does not parse is in
 * scope: the two checks tell about it.
 */
export function scopeOf(text: string | undefined, name: string = CONVENTIONS): string | undefined {
  if (text === undefined) return "the repository has no package.json at its root";
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const names = ["dependencies", "devDependencies"].flatMap((field) => {
    const value = manifest[field];
    return typeof value === "object" && value !== null ? Object.keys(value) : [];
  });
  return names.includes(name) ? undefined : `its root package.json has no dependency on ${name}`;
}

/** The scope of a repository for the compare of the import boundaries: out of scope, a no read, or the arguments of depcruise. */
export type BoundaryScope = { readonly kind: "off"; readonly reason: string } | { readonly kind: "unread"; readonly reason: string } | { readonly kind: "args"; readonly args: readonly string[] };

/** A word of a plain command: no quote, no variable, no redirect and no other mark of a shell. */
const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

/**
 * This function reads the text of the root `package.json` of a repository. A repository with no dependency on
 * `@mark1russell7/boundaries`, or with no script `check:boundaries`, is out of scope. A script that is not one
 * `depcruise` command with plain words is a no read. Else the function gives the words after `depcruise`, and the
 * option of a JSON output into `outFile`. The last option of `depcruise` decides, so these options come last.
 */
export function boundaryScope(text: string | undefined, outFile: string): BoundaryScope {
  const off = scopeOf(text, BOUNDARIES);
  if (off !== undefined) return { kind: "off", reason: off };
  let script: unknown;
  try {
    script = ((JSON.parse(text ?? "") as { scripts?: Record<string, unknown> }).scripts ?? {})[BOUNDARY_SCRIPT];
  } catch {
    return { kind: "unread", reason: "its root package.json does not parse" };
  }
  if (typeof script !== "string") return { kind: "off", reason: `its root package.json has no script ${BOUNDARY_SCRIPT}` };
  const [command, ...words] = script.trim().split(/\s+/);
  if (command !== "depcruise" || !words.every((word) => PLAIN_WORD.test(word))) {
    return { kind: "unread", reason: `its script ${BOUNDARY_SCRIPT} is not one depcruise command with plain words` };
  }
  return { kind: "args", args: [...words, "--output-type", "json", "--output-to", outFile] };
}

/** This function gives a path of `node_modules` with no folder of the pnpm store, so that the summary is short. */
export const shortPath = (path: string): string => path.replace(/node_modules\/\.pnpm\/[^/]+\/node_modules\//g, "node_modules/");

/** One violation in the JSON output of `depcruise`. */
interface Violation {
  readonly type?: string;
  readonly from?: string;
  readonly to?: string;
  readonly rule?: { readonly name?: string; readonly severity?: string };
}

/** The part of the JSON output of `depcruise` that the compare reads. */
interface CruiseOutput {
  readonly summary?: { readonly violations?: unknown; readonly ruleSetUsed?: { readonly forbidden?: unknown; readonly required?: unknown } };
}

/** This function gives the names of the rules of a list of the rule set of `depcruise`. */
const ruleNames = (list: unknown): string[] => (Array.isArray(list) ? list.flatMap((item: { name?: unknown }) => (typeof item?.name === "string" ? [item.name] : [])) : []);

/**
 * This function gives the JSON output of `depcruise` as a result of the compare, or undefined when the text is not
 * an output. Each rule of the rule set is a rule of the result. A violation of a rule with the severity `error` is a
 * break, and each other severity warns. The place of a violation is the file of the import, and its text tells the target.
 */
export function boundaryResult(text: string): CheckResult | undefined {
  let output: CruiseOutput;
  try {
    output = JSON.parse(text) as CruiseOutput;
  } catch {
    return undefined;
  }
  const summary = output.summary;
  if (summary === undefined || !Array.isArray(summary.violations)) return undefined;
  const rules = new Map<string, { status: CheckRule["status"]; breaks: CheckBreak[] }>();
  for (const id of [...ruleNames(summary.ruleSetUsed?.forbidden), ...ruleNames(summary.ruleSetUsed?.required)]) rules.set(id, { status: "pass", breaks: [] });
  for (const item of summary.violations as Violation[]) {
    const id = item.rule?.name ?? "(no rule name)";
    const entry = rules.get(id) ?? { status: "pass", breaks: [] };
    entry.status = item.rule?.severity === "error" || entry.status === "break" ? "break" : "warn";
    const from = shortPath(item.from ?? "");
    const to = shortPath(item.to ?? "");
    entry.breaks.push({ file: from, message: item.type === "module" || to === from ? `${item.type ?? "module"} ${from}` : `${item.type ?? "dependency"} to ${to}` });
    rules.set(id, entry);
  }
  return { rules: [...rules].map(([id, entry]) => ({ id, status: entry.status, breaks: entry.breaks })) };
}

/** The variables of this run that tell a rule about the event or the pull request of the template. checkEnv() removes them. */
export const EVENT_VARIABLES: readonly string[] = ["GITHUB_EVENT_PATH", "GITHUB_EVENT_NAME", "GITHUB_BASE_REF", "GITHUB_HEAD_REF", "GITHUB_STEP_SUMMARY", "CONVENTIONS_BASE", "CONVENTIONS_PULL_REQUEST"];

/**
 * This function gives the environment of a check of a repository. It removes each variable of the event of this run.
 * Then it adds the repository and the event file of a dispatched run of that repository.
 */
export function checkEnv(env: Readonly<Record<string, string | undefined>>, repository: string, eventFile: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const name of EVENT_VARIABLES) delete out[name];
  return { ...out, GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: eventFile };
}

/**
 * This function gives the event file of a dispatched run of a public repository. The job lists only public
 * repositories, so the rules that ask if a repository is public get the answer from the field `private`.
 */
export function dispatchEvent(repository: string): string {
  const [owner = "", name = ""] = repository.split("/");
  return `${JSON.stringify({ repository: { full_name: repository, name, owner: { login: owner }, private: false } }, null, 2)}\n`;
}

/** This function gives the rules that skip in each repository with a result of both checks: the compare cannot read them. */
export function unreadRules(outcomes: readonly RepoOutcome[]): string[] {
  const read = outcomes.filter((each): each is Extract<RepoOutcome, Read> => "skipped" in each);
  if (read.length === 0) return [];
  const [first, ...rest] = read;
  return (first?.skipped ?? []).filter((id) => rest.every((each) => each.skipped.includes(id))).sort((a, b) => a.localeCompare(b));
}

/** The most gone failures that the summary lists for one repository. */
export const GONE_LIST = 50;

/** This function gives the lines of the summary: a table of the repositories, then each new failure and each gone failure. */
export function summaryLines(outcomes: readonly RepoOutcome[], tool: Tool = TOOLS.conventions): string[] {
  const count = (kind: RepoOutcome["kind"]): number => outcomes.filter((each) => each.kind === kind).length;
  const word: Record<RepoOutcome["kind"], string> = {
    same: "same failures",
    new: "**new failures**",
    once: "new in one pair only",
    "next-unread": "**no result of the pull request**",
    unread: "no read",
    off: "out of scope",
  };
  const examined = outcomes.filter((each) => each.kind !== "off");
  const unread = unreadRules(outcomes);
  const item = (failure: Failure): string => `- \`${failure.rule}\` ${escapeMarkdown(failure.place)}: ${escapeMarkdown(failure.message)}`;
  const lines = [
    `## The compare of ${tool.title}: ${String(outcomes.filter(fails).length)} of ${String(examined.length)} repositories fail`,
    "",
    `Same failures: ${String(count("same"))}. New in one pair only: ${String(count("once"))}. No read: ${String(count("unread"))}. Out of scope: ${String(count("off"))}.`,
    "",
    unread.length === 0 ? "Each rule starts in one or more repositories." : `These rules skip in each repository, so the compare cannot read them: ${unread.map((id) => `\`${id}\``).join(", ")}.`,
    "",
    "| Repository | Result | New failures | Changed texts | Gone failures |",
    "| --- | --- | ---: | ---: | ---: |",
    ...examined.map(
      (each) =>
        `| ${escapeMarkdown(each.repo)} | ${word[each.kind]} | ${"failures" in each ? String(each.failures.length) : "0"} | ${"retold" in each ? String(each.retold.length) : "0"} | ${"gone" in each ? String(each.gone.length) : "0"} |`,
    ),
  ];
  for (const each of examined) {
    if (each.kind === "new" || each.kind === "once") {
      lines.push("", `### ${escapeMarkdown(each.repo)}: ${word[each.kind]}`, "");
      for (const failure of each.failures) lines.push(item(failure));
    }
    if (each.kind === "next-unread" || each.kind === "unread") lines.push("", `### ${escapeMarkdown(each.repo)}: ${word[each.kind]}`, "", escapeMarkdown(each.reason));
    if ("gone" in each && each.gone.length > 0) {
      lines.push("", `### ${escapeMarkdown(each.repo)}: gone failures`, "", ...each.gone.slice(0, GONE_LIST).map(item));
      if (each.gone.length > GONE_LIST) lines.push(`- ${String(each.gone.length - GONE_LIST)} more, in the artifact`);
    }
  }
  return lines;
}

/** This function gives the workflow commands of the outcomes: an error for each fault, and a warning for each doubt. */
export function annotations(outcomes: readonly RepoOutcome[], tool: Tool = TOOLS.conventions): string[] {
  const lines: string[] = [];
  const say = (level: "error" | "warning", text: string): number => lines.push(`::${level} title=${tool.label}::${escapeWorkflowData(text)}`);
  for (const each of outcomes) {
    if (each.kind === "new" || each.kind === "once") {
      const why = each.kind === "new" ? "only the rules of the pull request give it, in two pairs of checks" : "only the rules of the pull request give it, in one pair of checks of two";
      for (const item of each.failures) say(each.kind === "new" ? "error" : "warning", `${each.repo} ${item.rule} ${item.place}: ${item.message} (${why})`);
    }
    if (each.kind === "next-unread") say("error", `${each.repo}: ${each.reason}`);
    if (each.kind === "unread") say("warning", `${each.repo}: no read, because ${each.reason}`);
  }
  return lines;
}

/** This function starts a command with no shell, and gives its exit code and its output. A start that fails gives the code -1. */
function start(command: string, args: readonly string[], options: { cwd?: string; env?: Record<string, string | undefined>; timeout: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(command, [...args], { ...options, encoding: "utf8", maxBuffer: 1 << 26, windowsHide: true }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
      done({ code, stdout, stderr: error !== null && code === -1 ? `${stderr}${error.message}\n` : stderr });
    });
  });
}

/** This function parses the JSON output of a check, or gives undefined when the output is not a result. */
export function parseResult(stdout: string): CheckResult | undefined {
  try {
    const value = JSON.parse(stdout) as Partial<CheckResult>;
    return Array.isArray(value.rules) ? (value as CheckResult) : undefined;
  } catch {
    return undefined;
  }
}

/** This function starts one check of the rules of a checkout in a clone, and keeps its output and its log in `file`. */
async function runCheck(checkout: string, clone: string, env: Record<string, string | undefined>, file: string): Promise<CheckResult | undefined> {
  const began = Date.now();
  const cli = join(checkout, "packages/conventions/src/cli.ts");
  const result = await start(process.execPath, [cli, "check", "--json", "--no-base", "--root", clone], { cwd: clone, env, timeout: 8 * 60_000 });
  writeFileSync(`${file}.json`, result.stdout);
  writeFileSync(`${file}.log`, `${result.stderr}\nexit ${String(result.code)} after ${String(Math.round((Date.now() - began) / 1000))} s\n`);
  // Exit code 0 is a pass and 1 is a failure, both with a result. Each other code is a check that gave no result.
  return result.code === 0 || result.code === 1 ? parseResult(result.stdout) : undefined;
}

/** The read of the public repositories of some owners: `publicRepos` of `scripts/lib/gh.ts`, or a fake one in a test. */
export type ReadRepos = (owners: readonly string[]) => Promise<readonly OwnedRepo[]>;

/**
 * This function gives the full names of the repositories of the compare, in order. A JSON list of `owner/name` gives those
 * repositories. With no list, the function reads the public repositories of each owner of `OWNERS` that are not archived.
 */
export async function repoList(named: string | undefined, read: ReadRepos = publicRepos): Promise<string[]> {
  const repos = named === undefined ? (await read(OWNERS.map((owner) => owner.login))).map((repo) => `${repo.owner}/${repo.name}`) : (JSON.parse(named) as string[]);
  return [...repos].sort((a, b) => a.localeCompare(b));
}

/** The options of the compare of one repository. */
interface Options {
  readonly base: string;
  readonly next: string;
  readonly out: string;
  readonly work: string;
  /** The full name of the repository of the run. */
  readonly self: string;
}

/** This function clones one repository, starts the pairs of checks in it, and gives its outcome. */
async function compareRepo(repo: string, options: Options): Promise<RepoOutcome> {
  if (repo === options.self) return { repo, kind: "off", reason: "the CI of the pull request examines this repository with the rules of the pull request" };
  const clone = join(options.work, repo);
  const cloned = await start("git", ["clone", "--quiet", "--depth", "1", "--no-tags", `https://github.com/${repo}.git`, clone], { timeout: 5 * 60_000 });
  if (cloned.code !== 0) return { repo, kind: "unread", reason: `the clone failed: ${cloned.stderr.trim().split("\n").at(-1) ?? ""}` };
  const manifest = join(clone, "package.json");
  const off = scopeOf(existsSync(manifest) ? readFileSync(manifest, "utf8") : undefined);
  if (off !== undefined) return { repo, kind: "off", reason: off };
  const dir = join(options.out, repo);
  mkdirSync(dir, { recursive: true });
  const eventFile = join(dir, "event.json");
  writeFileSync(eventFile, dispatchEvent(repo));
  const env = checkEnv(process.env, repo, eventFile);
  const pair = async (round: number): Promise<Pair> => ({
    base: await runCheck(options.base, clone, env, join(dir, `base-${String(round)}`)),
    next: await runCheck(options.next, clone, env, join(dir, `next-${String(round)}`)),
  });
  const first = await pair(1);
  const once = outcome(repo, first);
  return once.kind === "once" ? outcome(repo, first, await pair(2)) : once;
}

/**
 * This function gives the file of the command `depcruise` in an installed clone, from the field `bin` of
 * `dependency-cruiser`. Node starts the file, so no shell and no shim of `node_modules/.bin` is in the way.
 */
function depcruiseBin(clone: string): string | undefined {
  const dir = join(clone, "node_modules/dependency-cruiser");
  try {
    const bin = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { bin?: Record<string, string> }).bin?.["depcruise"];
    return bin === undefined ? undefined : join(dir, bin);
  } catch {
    return undefined;
  }
}

/**
 * This function starts one check of the import boundaries of a checkout in an installed clone. It links the package of
 * the checkout into the `node_modules` of the clone, and starts `depcruise`. It keeps the summary of the output, and the log, in `file`.
 */
async function runBoundaryCheck(checkout: string, clone: string, bin: string, args: readonly string[], outFile: string, file: string): Promise<CheckResult | undefined> {
  const began = Date.now();
  const link = join(clone, "node_modules", ...BOUNDARIES.split("/"));
  const old = lstatSync(link, { throwIfNoEntry: false });
  if (old?.isSymbolicLink() === true) unlinkSync(link);
  else if (old !== undefined) rmSync(link, { recursive: true, force: true });
  // A junction on Windows, and a link of a folder on each other system: the type is read only on Windows.
  symlinkSync(join(checkout, "packages/boundaries"), link, "junction");
  rmSync(outFile, { force: true });
  const result = await start(process.execPath, [bin, ...args], { cwd: clone, timeout: 8 * 60_000 });
  const text = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
  const parsed = boundaryResult(text);
  writeFileSync(`${file}.json`, `${JSON.stringify(parsed ?? null, null, 2)}\n`);
  writeFileSync(`${file}.log`, `${result.stdout}${result.stderr}\nexit ${String(result.code)} after ${String(Math.round((Date.now() - began) / 1000))} s\n`);
  // depcruise exits with the count of the errors, so each exit code with an output is a result. A start that fails gives -1.
  return result.code === -1 ? undefined : parsed;
}

/** This function clones and installs one repository, starts the pairs of checks of the import boundaries in it, and gives its outcome. */
async function compareBoundaries(repo: string, options: Options): Promise<RepoOutcome> {
  if (repo === options.self) return { repo, kind: "off", reason: "the CI of the pull request examines this repository with the boundaries of the pull request" };
  const clone = join(options.work, repo);
  const cloned = await start("git", ["clone", "--quiet", "--depth", "1", "--no-tags", `https://github.com/${repo}.git`, clone], { timeout: 5 * 60_000 });
  if (cloned.code !== 0) return { repo, kind: "unread", reason: `the clone failed: ${cloned.stderr.trim().split("\n").at(-1) ?? ""}` };
  const manifest = join(clone, "package.json");
  const outFile = join(options.work, `${repo.replace("/", "__")}.depcruise.json`);
  const scope = boundaryScope(existsSync(manifest) ? readFileSync(manifest, "utf8") : undefined, outFile);
  if (scope.kind !== "args") return { repo, kind: scope.kind, reason: scope.reason };
  const dir = join(options.out, repo);
  mkdirSync(dir, { recursive: true });
  // The scripts of the packages do not start: the check reads the files and their imports only.
  const installed = await start("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: clone, env: { ...process.env, CI: "true" }, timeout: 10 * 60_000 });
  writeFileSync(join(dir, "install.log"), `${installed.stdout}${installed.stderr}\nexit ${String(installed.code)}\n`);
  if (installed.code !== 0) return { repo, kind: "unread", reason: `the install failed: ${installed.stderr.trim().split("\n").at(-1) ?? ""}` };
  const bin = depcruiseBin(clone);
  if (bin === undefined) return { repo, kind: "unread", reason: "the install has no command depcruise of dependency-cruiser" };
  const pair = async (round: number): Promise<Pair> => ({
    base: await runBoundaryCheck(options.base, clone, bin, scope.args, outFile, join(dir, `base-${String(round)}`)),
    next: await runBoundaryCheck(options.next, clone, bin, scope.args, outFile, join(dir, `next-${String(round)}`)),
  });
  const first = await pair(1);
  const once = outcome(repo, first);
  return once.kind === "once" ? outcome(repo, first, await pair(2)) : once;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { repos: { type: "string" }, base: { type: "string" }, next: { type: "string" }, out: { type: "string" }, work: { type: "string" }, jobs: { type: "string" }, tool: { type: "string" } } });
  const jobs = Number(values.jobs ?? "4");
  const { base, next, out, work } = values;
  const tool = Object.values(TOOLS).find((each) => each.name === (values.tool ?? "conventions"));
  if (base === undefined || next === undefined || out === undefined || work === undefined || tool === undefined || !(Number.isInteger(jobs) && jobs >= 1)) {
    process.stderr.write(`rule-compare: give --base, --next, --out, --work, a --tool of ${Object.keys(TOOLS).join(" or ")}, and a --jobs of 1 or more\n`);
    return 2;
  }
  const repos = await repoList(values.repos);
  process.stdout.write(`${String(repos.length)} repositories, the compare of ${tool.title}\n`);
  const options: Options = { base: resolve(base), next: resolve(next), out: resolve(out), work: resolve(work), self: process.env["GITHUB_REPOSITORY"] ?? "" };
  mkdirSync(options.out, { recursive: true });
  mkdirSync(options.work, { recursive: true });
  const outcomes = await pool(repos, jobs, async (repo) => {
    const began = Date.now();
    const result = await (tool.name === "boundaries" ? compareBoundaries(repo, options) : compareRepo(repo, options)).catch((error: unknown): RepoOutcome => ({ repo, kind: "unread", reason: error instanceof Error ? error.message : String(error) }));
    process.stdout.write(`${repo}: ${result.kind} (${String(Math.round((Date.now() - began) / 1000))} s)\n`);
    return result;
  });
  writeFileSync(join(options.out, "rule-compare.json"), `${JSON.stringify({ date: new Date().toISOString(), tool: tool.name, repositories: outcomes }, null, 2)}\n`);
  const lines = summaryLines(outcomes, tool);
  if (process.env["GITHUB_STEP_SUMMARY"]) appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `${lines.join("\n")}\n`);
  process.stdout.write(`${[...lines, ...annotations(outcomes, tool)].join("\n")}\n`);
  return outcomes.some(fails) ? 1 : 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`rule-compare: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
