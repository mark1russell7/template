/**
 * The commands `check`, `fix` and `--list` of the bin `conventions`, as functions. `runChecks` starts the
 * rules, `runFix` writes the edits of the breaks, and `runCli` reads the arguments and writes the result.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseConfig, type ConventionsConfig } from "./config.ts";
import { matchesAny, runGit, type Break, type Manifest, type PackageInfo, type Rule, type RuleContext } from "./rule.ts";
import { RULES } from "./rules/index.ts";
import { packageFolders, relativePath } from "./workspace.ts";

/** The result of one rule. */
export interface RuleResult {
  readonly id: string;
  readonly title: string;
  readonly fix: string;
  /** `pass`: no break. `break`: one or more breaks. `off`: the configuration turns the rule off. `skipped`: the rule did not start. `error`: the rule threw. */
  readonly status: "pass" | "break" | "off" | "skipped" | "error";
  readonly breaks: readonly Break[];
  /** The number of breaks in the files of `ignore`. */
  readonly ignored: number;
  /** The reason of `off`, of `ignore`, of `skipped`, or the message of `error`. */
  readonly note?: string;
}

/** The result of `runChecks`. */
export interface CheckResult {
  readonly rules: readonly RuleResult[];
  /** True when a rule has a break or an error. */
  readonly failed: boolean;
}

/** The options of `runChecks`. */
export interface CheckOptions {
  /** The root of the repository. */
  readonly root: string;
  /** Only these rules. The default is each rule. */
  readonly only?: readonly string[];
  /** The base commit of the change, for the rules that examine a change. */
  readonly base?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The rules. The default is `RULES`. */
  readonly rules?: readonly Rule[];
}

/** This function reads a `package.json` file. */
function readPackage(root: string, dir: string): PackageInfo {
  const path = join(dir, "package.json");
  const text = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(text);
  const manifest = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Manifest;
  return { folder: relativePath(root, dir), dir, file: relativePath(root, path), text, manifest };
}

/** This function reads the configuration of the root `package.json` at `root`. */
export function readConfig(root: string, rules: readonly Rule[] = RULES): ConventionsConfig {
  const file = join(root, "package.json");
  if (!existsSync(file)) throw new Error(`No package.json in ${root}.`);
  return parseConfig((JSON.parse(readFileSync(file, "utf8")) as Manifest)["conventions"], rules);
}

/** This function gives the facts of the repository at `root` that the rules read. */
export function createContext(root: string, config: ConventionsConfig, options: Pick<CheckOptions, "base" | "env"> = {}): RuleContext {
  const rootPackage = readPackage(root, root);
  const packages = packageFolders(root, config.packages ?? undefined)
    .filter((dir) => resolve(dir) !== resolve(root))
    .map((dir) => readPackage(root, dir));
  let files: readonly string[] | undefined | null = null;
  return {
    root,
    rootPackage,
    packages,
    env: options.env ?? {},
    ...(options.base === undefined ? {} : { base: options.base }),
    gitFiles() {
      if (files === null) {
        const out = runGit(root, ["ls-files", "-z", "--cached"]);
        files = out === undefined ? undefined : out.split("\0").filter((file) => file !== "");
      }
      return files;
    },
    git: (args) => runGit(root, args),
  };
}

/** This function starts each rule on the repository at `options.root`, and gives the result of each rule. */
export function runChecks(options: CheckOptions): CheckResult {
  const root = resolve(options.root);
  const rules = options.rules ?? RULES;
  const unknown = (options.only ?? []).filter((id) => !rules.some((rule) => rule.id === id));
  if (unknown.length > 0) throw new Error(`Unknown rule: ${unknown.join(", ")}. The rules are: ${rules.map((rule) => rule.id).join(", ")}.`);
  const config = readConfig(root, rules);
  const context = createContext(root, config, options);
  const results: RuleResult[] = [];
  for (const rule of rules) {
    if (options.only !== undefined && options.only.length > 0 && !options.only.includes(rule.id)) continue;
    const ruleConfig = config.rules[rule.id] ?? { ignore: [], options: {} };
    const base = { id: rule.id, title: rule.title, fix: rule.fix };
    if (ruleConfig.off !== undefined) {
      results.push({ ...base, status: "off", breaks: [], ignored: 0, note: ruleConfig.off });
      continue;
    }
    let outcome: ReturnType<Rule["check"]>;
    try {
      outcome = rule.check(context, ruleConfig.options);
    } catch (error) {
      results.push({ ...base, status: "error", breaks: [], ignored: 0, note: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if ("skipped" in outcome) {
      results.push({ ...base, status: "skipped", breaks: [], ignored: 0, note: outcome.skipped });
      continue;
    }
    const breaks = outcome.filter((item) => !matchesAny(item.file, ruleConfig.ignore));
    const ignored = outcome.length - breaks.length;
    const note = ruleConfig.reason === undefined ? {} : { note: ruleConfig.reason };
    results.push({ ...base, status: breaks.length > 0 ? "break" : "pass", breaks, ignored, ...note });
  }
  return { rules: results, failed: results.some((result) => result.status === "break" || result.status === "error") };
}

/** The result of `runFix`. */
export interface FixResult {
  /** The files that the edits changed, relative to the root, with `/`, in the order of the first change. */
  readonly changed: readonly string[];
  /** The number of checks. */
  readonly passes: number;
  /** The result of the last check, after the edits. */
  readonly result: CheckResult;
}

/** The most checks of `runFix`. Each check writes at most one edit of each file. */
const MAX_PASSES = 20;

/**
 * This function writes the edits of the breaks, and checks again, until no edit applies. In each pass it writes the first
 * edit of each file whose `before` is the current text of the file. The other edits of that file wait for the next check,
 * which gives them again from the new text. Thus a fix does not write over a change that it did not see.
 */
export function runFix(options: CheckOptions): FixResult {
  const root = resolve(options.root);
  const changed: string[] = [];
  let result = runChecks(options);
  let passes = 1;
  while (passes < MAX_PASSES) {
    const written = new Set<string>();
    for (const rule of result.rules) {
      for (const edit of rule.breaks.flatMap((item) => item.edits ?? [])) {
        if (written.has(edit.file)) continue;
        const path = join(root, edit.file);
        if (!existsSync(path) || readFileSync(path, "utf8") !== edit.before) continue;
        writeFileSync(path, edit.after);
        written.add(edit.file);
        if (!changed.includes(edit.file)) changed.push(edit.file);
      }
    }
    if (written.size === 0) break;
    result = runChecks(options);
    passes += 1;
  }
  return { changed, passes, result };
}

/** This function gives a result for JSON: each break without the texts of its edits, and with `fixable`. */
function withoutEdits(result: CheckResult): object {
  return {
    ...result,
    rules: result.rules.map((rule) => ({ ...rule, breaks: rule.breaks.map(({ edits, ...item }) => ({ ...item, fixable: (edits ?? []).length > 0 })) })),
  };
}

/** The most breaks of one rule in the text output. The JSON output has each break. */
const MAX_SHOWN = 50;

/** This function gives the place of a break as `file:line`. */
const placeOf = (item: Break): string => (item.line === undefined ? item.file : `${item.file}:${item.line}`);

/** This function gives the text of a result for a terminal or a CI log. */
export function formatResult(result: CheckResult): string {
  const count = (status: RuleResult["status"]): number => result.rules.filter((rule) => rule.status === status).length;
  const breaks = result.rules.reduce((sum, rule) => sum + rule.breaks.length, 0);
  const out: string[] = [
    `conventions: ${result.rules.length} rules: ${count("pass")} pass, ${count("break")} with ${breaks} break(s), ${count("off")} off, ${count("skipped")} skipped, ${count("error")} error(s).`,
    "",
  ];
  const label: Record<RuleResult["status"], string> = { pass: "pass ", break: "BREAK", off: "off  ", skipped: "skip ", error: "ERROR" };
  for (const rule of result.rules) {
    const extra = rule.ignored > 0 ? ` (${rule.ignored} ignored: ${rule.note ?? ""})` : rule.note !== undefined && rule.status !== "pass" ? ` (${rule.note})` : "";
    out.push(`${label[rule.status]}  ${rule.id}${rule.breaks.length > 0 ? `: ${rule.breaks.length} break(s)` : ""}${extra}`);
    for (const item of rule.breaks.slice(0, MAX_SHOWN)) {
      out.push(`       ${placeOf(item)}  ${item.message}${(item.edits ?? []).length > 0 ? " (conventions fix writes the fix)" : ""}`);
      if (item.fix !== undefined) out.push(`         fix: ${item.fix}`);
    }
    if (rule.breaks.length > MAX_SHOWN) out.push(`       ... ${rule.breaks.length - MAX_SHOWN} more. Start \`conventions check --json\` for each break.`);
    if (rule.breaks.length > 0) out.push(`       rule: ${rule.title}`, `       fix: ${rule.fix}`);
  }
  if (result.failed) out.push("", "To turn a rule off or to keep an exception, add a reason in the field conventions of package.json (`conventions --list`).");
  return `${out.join("\n")}\n`;
}

/** This function escapes the text of a cell of a Markdown table: first each backslash, then each `|`. */
const cell = (text: string): string => text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** This function gives the result as Markdown for the summary of a GitHub Actions run. */
export function summaryMarkdown(result: CheckResult): string {
  const out = ["### Conventions", "", "| Rule | Result | Note |", "|---|---|---|"];
  for (const rule of result.rules) {
    const shown = rule.status === "break" ? `${rule.breaks.length} break(s)` : rule.status;
    const note = rule.ignored > 0 ? `${rule.ignored} ignored: ${rule.note ?? ""}` : (rule.note ?? "");
    out.push(`| \`${rule.id}\` | ${shown} | ${cell(note)} |`);
  }
  const broken = result.rules.filter((rule) => rule.breaks.length > 0);
  for (const rule of broken) {
    out.push("", `<details open><summary><code>${rule.id}</code>: ${rule.breaks.length} break(s)</summary>`, "", `${rule.title} Fix: ${rule.fix}`, "");
    for (const item of rule.breaks.slice(0, MAX_SHOWN)) out.push(`- \`${placeOf(item)}\`: ${item.message}${item.fix === undefined ? "" : ` Fix: ${item.fix}`}`);
    if (rule.breaks.length > MAX_SHOWN) out.push(`- ... ${rule.breaks.length - MAX_SHOWN} more`);
    out.push("", "</details>");
  }
  return `${out.join("\n")}\n`;
}

/** This function escapes a value of a workflow command of GitHub Actions. */
const escapeData = (text: string): string => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (text: string): string => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** This function gives an `::error` workflow command for each break, so that GitHub shows each break on its line in the pull request. */
export function annotations(result: CheckResult): string {
  const out: string[] = [];
  for (const rule of result.rules) {
    for (const item of rule.breaks) {
      const line = item.line === undefined ? "" : `,line=${item.line}`;
      out.push(`::error file=${escapeProperty(item.file)}${line},title=${escapeProperty(`conventions ${rule.id}`)}::${escapeData(`${item.message} Fix: ${item.fix ?? rule.fix}`)}`);
    }
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

/** This function gives the text of `--list`: each rule, its reason, its fix, its options, its state and its audit sources. */
export function listRules(config: ConventionsConfig | undefined, rules: readonly Rule[] = RULES): string {
  const out: string[] = [];
  for (const rule of rules) {
    const ruleConfig = config?.rules[rule.id];
    const state = ruleConfig?.off !== undefined ? `off: ${ruleConfig.off}` : "on";
    out.push(`${rule.id} (${state})`, `  ${rule.title}`, `  why: ${rule.reason}`, `  fix: ${rule.fix}`);
    for (const [name, spec] of Object.entries(rule.options)) {
      const value = ruleConfig?.options[name] ?? spec.default;
      out.push(`  option ${name} = ${JSON.stringify(value)}: ${spec.description}`);
    }
    if (ruleConfig !== undefined && ruleConfig.ignore.length > 0) out.push(`  ignore ${ruleConfig.ignore.join(", ")}: ${ruleConfig.reason ?? ""}`);
    else if (ruleConfig?.reason !== undefined) out.push(`  reason: ${ruleConfig.reason}`);
    out.push(`  from: ${rule.sources.map((source) => `${source.repo} ${source.rule} (${source.doc})`).join("; ")}`, "");
  }
  return `${out.join("\n")}`;
}

/** The input and output of `runCli`. */
export interface CliIo {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** The help text of the bin. */
export const USAGE: string = `Usage: conventions check [options]
       conventions fix [options]
       conventions --list

  check                 Start each rule. Exit code 1 when a rule has a break.
  fix                   Write the fixes of the breaks that have one, and check again. Exit code 1 when a break stays.
  --list                Show each rule: why, fix, options, state and the audit rows that it comes from.

  --root <folder>       The root of the repository. The default is the current folder.
  --rule <id>           Only this rule. Use it again for more rules.
  --base <ref>          The base commit of the change, for the rule release-files. On a pull request, the rule finds it.
  --json                Write the result as JSON.
  -h, --help            Show this text.

The field "conventions" of the root package.json turns a rule off with a reason, keeps an exception
with a reason, and sets the options of a rule with a reason:

  "conventions": { "rules": { "no-build-output": { "off": "<reason>" },
                              "cue-preset": { "ignore": ["packages/web/**"], "reason": "<reason>" },
                              "workspace-protocol": { "prefix": "workspace:*", "reason": "<reason>" } } }
`;

/** An error of the arguments: exit code 2 and the help text. */
class UsageError extends Error {}

/** This function starts the bin with the arguments `args`, and gives its exit code. */
export function runCli(args: readonly string[], io: CliIo): number {
  let check = false;
  let fix = false;
  let list = false;
  let json = false;
  let root = io.cwd;
  let base: string | undefined;
  const only: string[] = [];
  try {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index] ?? "";
      const value = (): string => {
        const next = args[++index];
        if (next === undefined || next.startsWith("-")) throw new UsageError(`The option ${arg} needs a value.`);
        return next;
      };
      if (arg === "check") check = true;
      else if (arg === "fix") fix = true;
      else if (arg === "--list" || arg === "list") list = true;
      else if (arg === "--json") json = true;
      else if (arg === "--root") root = resolve(io.cwd, value());
      else if (arg === "--rule") only.push(value());
      else if (arg === "--base") base = value();
      else if (arg === "--help" || arg === "-h") {
        io.stdout(USAGE);
        return 0;
      } else throw new UsageError(`An unknown argument: ${arg}`);
    }
    if (!check && !fix && !list) throw new UsageError("Give the command check or fix, or --list.");
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`conventions: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (list) {
    let config: ConventionsConfig | undefined;
    try {
      config = existsSync(join(root, "package.json")) ? readConfig(root) : undefined;
    } catch (error) {
      io.stderr(`conventions: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    io.stdout(listRules(config));
    return 0;
  }
  let result: CheckResult;
  let fixed: FixResult | undefined;
  try {
    const options = { root, only, env: io.env, ...(base === undefined ? {} : { base }) };
    if (fix) {
      fixed = runFix(options);
      result = fixed.result;
    } else result = runChecks(options);
  } catch (error) {
    io.stderr(`conventions: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (fixed !== undefined && !json) {
    const files = fixed.changed.map((file) => `  ${file}\n`).join("");
    io.stdout(fixed.changed.length === 0 ? "conventions fix: no break has a fix that applies.\n" : `conventions fix: changed ${fixed.changed.length} file(s) in ${fixed.passes} check(s):\n${files}\n`);
  }
  const shown = fixed === undefined ? withoutEdits(result) : { changed: fixed.changed, passes: fixed.passes, ...withoutEdits(result) };
  if (json) io.stdout(`${JSON.stringify(shown, null, 2)}\n`);
  else {
    if (io.env["GITHUB_ACTIONS"] === "true") io.stdout(annotations(result));
    io.stdout(formatResult(result));
  }
  const summary = io.env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, summaryMarkdown(result));
  return result.failed ? 1 : 0;
}
