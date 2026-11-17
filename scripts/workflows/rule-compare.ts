// The compare of the conventions rules of a pull request with the rules of its base, over the public repositories
// that use @mark1russell7/conventions (CI.md, "The compare of the conventions rules"). The job rules of
// ci.yml starts it:
//
//   node next/scripts/workflows/rule-compare.ts --repos <JSON list of owner/name> --base <dir> --next <dir> --out <dir> --work <dir> [--jobs <n>]
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
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { escapeMarkdown, escapeWorkflowData } from "@mark1russell7/text";

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

/** The difference of two checks: the new failures, and the failures with a changed text at the same place. */
export interface Difference {
  readonly fresh: readonly Failure[];
  readonly retold: readonly Failure[];
}

/**
 * This function compares the failures of `next` with the failures of `base` at each place. It keeps the failures of
 * `next` with no failure of the same text in `base`. They are new when their place has more failures in `next`.
 * Else they have a changed text.
 */
export function newFailures(base: CheckResult, next: CheckResult): Difference {
  const before = byPlace(failures(base));
  const fresh: Failure[] = [];
  const retold: Failure[] = [];
  for (const [key, items] of byPlace(failures(next))) {
    const old = before.get(key) ?? [];
    const left = new Map<string, number>();
    for (const item of old) left.set(item.message, (left.get(item.message) ?? 0) + 1);
    const unknown = items.filter((item) => {
      const count = left.get(item.message) ?? 0;
      if (count > 0) left.set(item.message, count - 1);
      return count === 0;
    });
    (items.length > old.length ? fresh : retold).push(...unknown);
  }
  return { fresh, retold };
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
  const { fresh, retold } = newFailures(first.base, first.next);
  if (fresh.length === 0) return { repo, kind: "same", rules: first.next.rules.length, skipped, retold };
  if (second?.base === undefined || second.next === undefined) return { repo, kind: "once", failures: fresh, skipped, retold };
  const both = confirmed(fresh, newFailures(second.base, second.next).fresh);
  return both.length > 0 ? { repo, kind: "new", failures: both, skipped, retold } : { repo, kind: "once", failures: fresh, skipped, retold };
}

/** This function tells if an outcome fails the compare: a confirmed new failure, or no result of the pull request only. */
export const fails = (each: RepoOutcome): boolean => each.kind === "new" || each.kind === "next-unread";

/** The name of the package of the rules. */
export const CONVENTIONS = "@mark1russell7/conventions";

/**
 * This function reads the text of the root `package.json` of a repository. It gives the reason that the repository is
 * out of scope, or undefined when the compare examines it. A file that does not parse is in scope: the two checks tell about it.
 */
export function scopeOf(text: string | undefined): string | undefined {
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
  return names.includes(CONVENTIONS) ? undefined : `its root package.json has no dependency on ${CONVENTIONS}`;
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

/** This function gives the lines of the summary: a table of the repositories, then each new failure. */
export function summaryLines(outcomes: readonly RepoOutcome[]): string[] {
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
  const lines = [
    `## The compare of the conventions rules: ${String(outcomes.filter(fails).length)} of ${String(examined.length)} repositories fail`,
    "",
    `Same failures: ${String(count("same"))}. New in one pair only: ${String(count("once"))}. No read: ${String(count("unread"))}. Out of scope: ${String(count("off"))}.`,
    "",
    unread.length === 0 ? "Each rule starts in one or more repositories." : `These rules skip in each repository, so the compare cannot read them: ${unread.map((id) => `\`${id}\``).join(", ")}.`,
    "",
    "| Repository | Result | New failures | Changed texts |",
    "| --- | --- | ---: | ---: |",
    ...examined.map((each) => `| ${escapeMarkdown(each.repo)} | ${word[each.kind]} | ${"failures" in each ? String(each.failures.length) : "0"} | ${"retold" in each ? String(each.retold.length) : "0"} |`),
  ];
  for (const each of examined) {
    if (each.kind === "new" || each.kind === "once") {
      lines.push("", `### ${escapeMarkdown(each.repo)}: ${word[each.kind]}`, "");
      for (const item of each.failures) lines.push(`- \`${item.rule}\` ${escapeMarkdown(item.place)}: ${escapeMarkdown(item.message)}`);
    }
    if (each.kind === "next-unread" || each.kind === "unread") lines.push("", `### ${escapeMarkdown(each.repo)}: ${word[each.kind]}`, "", escapeMarkdown(each.reason));
  }
  return lines;
}

/** This function gives the workflow commands of the outcomes: an error for each fault, and a warning for each doubt. */
export function annotations(outcomes: readonly RepoOutcome[]): string[] {
  const lines: string[] = [];
  const say = (level: "error" | "warning", text: string): number => lines.push(`::${level} title=Rule compare::${escapeWorkflowData(text)}`);
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

/** This function starts `task` for each item, with at most `limit` tasks at one time, and gives the results in the order of the items. */
export async function inPool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const at = next;
      next += 1;
      results[at] = await task(items[at] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
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

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { repos: { type: "string" }, base: { type: "string" }, next: { type: "string" }, out: { type: "string" }, work: { type: "string" }, jobs: { type: "string" } } });
  const jobs = Number(values.jobs ?? "4");
  const { base, next, out, work } = values;
  if (base === undefined || next === undefined || out === undefined || work === undefined || !(Number.isInteger(jobs) && jobs >= 1)) {
    process.stderr.write("rule-compare: give --base, --next, --out, --work, and a --jobs of 1 or more\n");
    return 2;
  }
  const repos = [...(JSON.parse(values.repos ?? "[]") as string[])].sort((a, b) => a.localeCompare(b));
  const options: Options = { base: resolve(base), next: resolve(next), out: resolve(out), work: resolve(work), self: process.env["GITHUB_REPOSITORY"] ?? "" };
  mkdirSync(options.out, { recursive: true });
  mkdirSync(options.work, { recursive: true });
  const outcomes = await inPool(repos, jobs, async (repo) => {
    const began = Date.now();
    const result = await compareRepo(repo, options).catch((error: unknown): RepoOutcome => ({ repo, kind: "unread", reason: error instanceof Error ? error.message : String(error) }));
    process.stdout.write(`${repo}: ${result.kind} (${String(Math.round((Date.now() - began) / 1000))} s)\n`);
    return result;
  });
  writeFileSync(join(options.out, "rule-compare.json"), `${JSON.stringify({ date: new Date().toISOString(), repositories: outcomes }, null, 2)}\n`);
  const lines = summaryLines(outcomes);
  if (process.env["GITHUB_STEP_SUMMARY"]) appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `${lines.join("\n")}\n`);
  process.stdout.write(`${[...lines, ...annotations(outcomes)].join("\n")}\n`);
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
