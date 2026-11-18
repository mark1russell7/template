/**
 * The commands `conventions pre-push` and `conventions hook install`. The hook `pre-push` of git starts the first
 * command before each push. It examines the new commits of the push with the private name list, which is outside
 * of the public repositories. It also lints the prose files of the push with the ste-lint of the repository. The second
 * command writes that hook.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseConfig } from "./config.ts";
import { matchesAny, type Break, type Manifest } from "./rule.ts";
import { RULES } from "./rules/index.ts";
import { repositoryOfRemote } from "./rules/runner-budget.ts";
import { mergePrivateNames, parsePrivateNames, PrivateNameListError, type PrivateNameList } from "./private-names.ts";
import {
  invalidPatternBreaks,
  PRIVATE_NAMES_FILE_CONFIG,
  PRIVATE_NAMES_FILE_VARIABLE,
  privateNamesFiles,
  privatePatterns,
  privateTextBreaks,
  type PrivateSources,
} from "./rules/no-local-paths.ts";
import type { CliIo } from "./run.ts";

/** The line of `conventions pre-push` when no setting names a private name list and no environment variable has a pattern. */
export const NO_READ_LINE: string = `conventions pre-push: No read: no private name list. Set ${PRIVATE_NAMES_FILE_VARIABLE} or the git config ${PRIVATE_NAMES_FILE_CONFIG}.`;

/** The options of `prePush`. */
export interface PrePushOptions {
  /** The name of the remote: the first argument of the hook. */
  readonly remote: string;
  /**
   * The URL of the remote: the second argument of the hook. The list `allow` of the private name list uses its repository.
   * With no URL, the command asks `git remote get-url`.
   */
  readonly url?: string;
  /** The standard input of the hook: a line `<local ref> <local sha> <remote ref> <remote sha>` for each ref of the push. */
  readonly input: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The root of the working tree. A relative path of the private name list starts at the root. */
  readonly root: string;
  /** This function starts git in the root, and gives its output, or undefined when git fails. */
  readonly git: (args: readonly string[]) => string | undefined;
  /** This function reads a file as text. The default reads it with `node:fs`. */
  readonly readFile?: (path: string) => string;
  /**
   * This function loads `@mark1russell7/ste-lint` for the root, or throws. The default loads the copy in the
   * `node_modules` of the root, so the hook uses the same version as the script `lint:ste`.
   */
  readonly loadSteLint?: (root: string) => unknown;
}

/** A sha of no commit: git gives it for a ref that the push deletes, or for a ref that the remote does not have. */
const ZERO = /^0+$/;

/** The form of a sha of a commit. */
const SHA = /^[0-9a-f]{40,64}$/;

/** The home folder settings of the rule `no-local-paths` in the root `package.json`. */
interface HomeSettings {
  readonly on: boolean;
  readonly allow: readonly string[];
  readonly ignore: readonly string[];
}

/**
 * This function reads the settings of the rule `no-local-paths` in the root `package.json`: the state, the permitted names
 * and the globs of `ignore` and `generated`. They apply only to the home folders. A private pattern always counts.
 */
function homeSettings(root: string, readFile: (path: string) => string): HomeSettings {
  try {
    const manifest = JSON.parse(readFile(join(root, "package.json"))) as Manifest;
    const config = parseConfig(manifest["conventions"], RULES).rules["no-local-paths"];
    if (config === undefined) return { on: true, allow: [], ignore: [] };
    const allow = config.options["allow"];
    return { on: config.off === undefined, allow: Array.isArray(allow) ? [...allow] : [], ignore: [...config.ignore, ...(config.generated ?? [])] };
  } catch {
    // The check of CI reports a configuration that does not parse. The hook uses the defaults
    return { on: true, allow: [], ignore: [] };
  }
}

/** This function gives the text of a path in a header of a patch, without the quotes of git. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const body = path.slice(1, -1);
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let index = 0; index < body.length; index++) {
    if (body.charAt(index) !== "\\") {
      // One code point, so a pair of surrogates stays one character
      const char = String.fromCodePoint(body.codePointAt(index) ?? 0);
      bytes.push(...Buffer.from(char, "utf8"));
      index += char.length - 1;
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
    if (octal !== null) {
      bytes.push(parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    const next = body.charAt(index + 1);
    bytes.push(escapes[next] ?? next.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** A run of added lines of one file that follow each other in the new file. */
interface AddedRun {
  readonly file: string;
  /** The line of the first line in the new file, from 1. */
  readonly first: number;
  readonly lines: string[];
}

/**
 * This function gives the added lines of a patch of `git show --unified=0`, in runs of lines that follow each other.
 * It reads the counts of each hunk, so an added line that starts with `+++` is a line, not a header. It also reads the
 * combined patch of a merge commit, with one column of marks for each parent.
 */
export function addedRuns(patch: string): readonly AddedRun[] {
  const runs: AddedRun[] = [];
  let file: string | undefined;
  let columns = 1;
  let parentLeft: number[] = [];
  let resultLeft = 0;
  let next = 0;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("\\")) continue;
    if (resultLeft > 0 || parentLeft.some((count) => count > 0)) {
      const marks = line.slice(0, columns);
      const removed = marks.includes("-");
      for (let column = 0; column < columns; column++) {
        const mark = marks.charAt(column);
        if (mark === "-" || (!removed && mark === " ")) parentLeft[column] = (parentLeft[column] ?? 0) - 1;
      }
      if (removed) continue;
      resultLeft -= 1;
      if (marks.includes("+") && file !== undefined) {
        const text = line.slice(columns);
        const last = runs.at(-1);
        if (last !== undefined && last.file === file && last.first + last.lines.length === next) last.lines.push(text);
        else runs.push({ file, first: next, lines: [text] });
      }
      next += 1;
      continue;
    }
    if (line.startsWith("diff ")) {
      file = undefined;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = unquote(line.slice(4));
      file = path === "/dev/null" ? undefined : path.replace(/^b\//, "");
      continue;
    }
    const hunk = /^(@{2,}) ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? \1/.exec(line);
    if (hunk === null) continue;
    columns = (hunk[1] ?? "@@").length - 1;
    parentLeft = (hunk[2] ?? "")
      .trim()
      .split(" ")
      .map((range) => {
        const count = /^-\d+(?:,(\d+))?$/.exec(range)?.[1];
        return count === undefined ? 1 : Number(count);
      });
    next = Number(hunk[3]);
    resultLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
  }
  return runs;
}

/** This function gives the place of a break as `file:line`. */
const placeOf = (item: Break): string => (item.line === undefined ? item.file : `${item.file}:${String(item.line)}`);

/** The result of the examination of one commit. */
interface CommitRead {
  readonly breaks: readonly Break[];
  readonly lines: number;
}

/**
 * This function gives a function that gives the paths that a commit adds or changes, or undefined when git fails. It
 * starts git one time for each commit. The combined diff of a merge commit gives only the paths that differ from each parent.
 */
function pathsOfCommits(git: PrePushOptions["git"]): (sha: string) => readonly string[] | undefined {
  const known = new Map<string, readonly string[] | undefined>();
  return (sha) => {
    if (known.has(sha)) return known.get(sha);
    const names = git(["show", "--format=", "--name-only", "--diff-filter=AMRC", "-z", "--no-ext-diff", sha]);
    // The empty format can put a line end before the first name
    const paths =
      names
        ?.replace(/^\n+/, "")
        .split("\0")
        .filter((path) => path !== "") ?? undefined;
    known.set(sha, paths);
    return paths;
  };
}

/** This function examines one commit: its message, the paths that it adds or changes, and each line that it adds. */
function readCommit(sha: string, privates: PrivateSources, home: HomeSettings, repo: string | undefined, git: PrePushOptions["git"], pathsOf: (sha: string) => readonly string[] | undefined): CommitRead | undefined {
  const short = sha.slice(0, 12);
  const message = git(["show", "-s", "--format=%B", sha]);
  const names = pathsOf(sha);
  const patch = git(["-c", "core.quotePath=false", "show", "--format=", "--no-color", "--unified=0", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", sha]);
  if (message === undefined || names === undefined || patch === undefined) return undefined;
  const breaks: Break[] = [];
  const add = (items: readonly Break[]): void => {
    for (const item of items) breaks.push(item);
  };
  const text = message.replace(/\s+$/, "");
  add(privateTextBreaks(`commit ${short} message`, text, privates, { allow: home.allow, homes: home.on }));
  let lines = text === "" ? 0 : text.split(/\r?\n/).length;
  const runs = addedRuns(patch);
  const paths = [...names];
  for (const run of runs) if (!paths.includes(run.file)) paths.push(run.file);
  // A break of a path does not show the path, because the path has the private text. The lines of that file do not show it either
  const shown = new Map<string, string>();
  paths.forEach((path, index) => {
    const homes = home.on && !matchesAny(path, home.ignore);
    const found = privateTextBreaks(`commit ${short} path ${String(index + 1)}`, path, privates, { allow: home.allow, homes, isPath: true });
    lines += 1;
    shown.set(path, found.length > 0 ? `commit ${short} path ${String(index + 1)}` : `commit ${short} ${path}`);
    for (const item of found) breaks.push({ file: item.file, message: item.message.replace(/^A text /, "The path "), ...(item.fix === undefined ? {} : { fix: item.fix }) });
  });
  for (const run of runs) {
    const homes = home.on && !matchesAny(run.file, home.ignore);
    const place = { ...(repo === undefined ? {} : { repo }), path: run.file };
    add(privateTextBreaks(shown.get(run.file) ?? `commit ${short} ${run.file}`, run.lines.join("\n"), privates, { allow: home.allow, homes, firstLine: run.first, rootPackage: run.file === "package.json", ...place }));
    lines += run.lines.length;
  }
  return { breaks, lines };
}

/** This function gives the reason of a read that failed, in words. */
function readReason(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "ENOENT") return "the file does not exist";
  if (code === "EISDIR") return "the path is a folder";
  if (code === "EACCES" || code === "EPERM") return "the file has no read permission";
  return error instanceof Error ? error.message : String(error);
}

/**
 * This function gives the repository `owner/name` of the push: from the URL of the hook, else from `git remote get-url`.
 * It gives undefined when neither URL is a URL of a GitHub repository.
 */
function repoOfPush(options: PrePushOptions): string | undefined {
  const fromHook = options.url === undefined ? undefined : repositoryOfRemote(options.url);
  return fromHook ?? repositoryOfRemote(options.git(["remote", "get-url", options.remote]) ?? "");
}

/** The new commits of a push. */
interface PushCommits {
  /** The new commits of each local sha of the push, the tip of a ref. */
  readonly tips: ReadonlyMap<string, readonly string[]>;
  /** The new commits of all refs, each one time. */
  readonly all: ReadonlySet<string>;
}

/**
 * This function lists the new commits of the push from the standard input of the hook. A commit is new when the remote
 * does not have it. On an input or a git error, it writes the reason and gives undefined: the push stops.
 */
function pushCommits(options: PrePushOptions, io: Pick<CliIo, "stderr">): PushCommits | undefined {
  const tips = new Map<string, string[]>();
  const all = new Set<string>();
  for (const line of options.input.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (localSha === undefined || remoteSha === undefined || !SHA.test(localSha) || !SHA.test(remoteSha)) {
      io.stderr(`conventions pre-push: The input line "${line.trim()}" does not have the form <local ref> <local sha> <remote ref> <remote sha>. The push stops.\n`);
      return undefined;
    }
    // The push deletes the ref, so it adds no commit
    if (ZERO.test(localSha)) continue;
    const others = ["rev-list", localSha, "--not", `--remotes=${options.remote}`];
    const listed = ZERO.test(remoteSha) ? options.git(others) : (options.git(["rev-list", localSha, `^${remoteSha}`]) ?? options.git(others));
    if (listed === undefined) {
      io.stderr(`conventions pre-push: git cannot list the new commits of ${localRef ?? localSha}. The push stops.\n`);
      return undefined;
    }
    const commits = tips.get(localSha) ?? [];
    tips.set(localSha, commits);
    for (const sha of listed.split(/\r?\n/)) {
      const commit = sha.trim();
      if (!SHA.test(commit)) continue;
      if (!commits.includes(commit)) commits.push(commit);
      all.add(commit);
    }
  }
  return { tips, all };
}

/**
 * This function is the command `conventions pre-push`. It has two steps, and each step reads the new commits of the push:
 *
 * - The private name step examines the message of each new commit, the paths that it adds or changes, and each line that
 *   it adds. With no private name list and no private pattern, it writes the line `NO_READ_LINE` and does not stop the push.
 *   The settings can name more than one list (`privateNamesFiles`). The step then examines the merge of the lists.
 * - The STE step lints the prose files that the new commits add or change, at the tip of the push (`steLint`). It starts
 *   only when the root `package.json` has the script `lint:ste`.
 *
 * The command writes the breaks to `stderr`, and gives the exit code: 1 when a step stops the push, 0 on a pass.
 */
export function prePush(options: PrePushOptions, io: Pick<CliIo, "stderr">): number {
  // Each step reads the list of commits. The command lists them one time, and only when a step needs them. Thus an input
  // error shows one time
  let pushed: { readonly commits: PushCommits | undefined } | undefined;
  const commitsOfPush = (): PushCommits | undefined => (pushed ??= { commits: pushCommits(options, io) }).commits;
  const pathsOf = pathsOfCommits(options.git);
  const names = privateNameStep(options, io, commitsOfPush, pathsOf);
  const ste = steLint(options, io, commitsOfPush, pathsOf);
  return names === 0 && ste === 0 ? 0 : 1;
}

/** The private name step of `prePush`. It gives 1 when it stops the push, and 0 otherwise. */
function privateNameStep(options: PrePushOptions, io: Pick<CliIo, "stderr">, commitsOfPush: () => PushCommits | undefined, pathsOf: (sha: string) => readonly string[] | undefined): number {
  const readFile = options.readFile ?? ((path: string): string => readFileSync(path, "utf8"));
  const files = privateNamesFiles(options.env, options.git);
  const patterns = privatePatterns(options.env);
  if (files.length === 0 && patterns.length === 0) {
    // A push with no read is not a pass, so the line tells it. It does not stop the push
    io.stderr(`${NO_READ_LINE}\n`);
    return 0;
  }
  let names: PrivateNameList | undefined;
  if (files.length > 0) {
    // A list that the settings name and that the gate cannot read or parse stops the push: the check fails closed
    const fromEnv = privateNamesFiles({ [PRIVATE_NAMES_FILE_VARIABLE]: options.env[PRIVATE_NAMES_FILE_VARIABLE] }, () => undefined).length > 0;
    const source = fromEnv ? PRIVATE_NAMES_FILE_VARIABLE : `the git config ${PRIVATE_NAMES_FILE_CONFIG}`;
    const lists: PrivateNameList[] = [];
    for (const [at, file] of files.entries()) {
      const which = files.length === 1 ? `the private name list that ${source} names` : `private name list ${String(at + 1)} of the ${String(files.length)} that ${source} names`;
      let text: string;
      try {
        text = readFile(resolve(options.root, file));
      } catch (error) {
        io.stderr(`conventions pre-push: Cannot read ${which}: ${readReason(error)}. Correct the setting or the file. The push stops.\n`);
        return 1;
      }
      try {
        lists.push(parsePrivateNames(text));
      } catch (error) {
        const reason = error instanceof PrivateNameListError ? error.reason : "the parse failed";
        io.stderr(`conventions pre-push: ${which.charAt(0).toUpperCase()}${which.slice(1)} is not valid: ${reason}. Correct the file. The push stops.\n`);
        return 1;
      }
    }
    try {
      names = mergePrivateNames(lists);
    } catch (error) {
      const reason = error instanceof PrivateNameListError ? error.reason : "the merge failed";
      io.stderr(`conventions pre-push: The private name lists that ${source} names are not valid together: ${reason}. Give each name its own id. The push stops.\n`);
      return 1;
    }
  }
  const privates: PrivateSources = { ...(names === undefined ? {} : { names }), patterns };
  const repo = names === undefined || names.allow.length === 0 ? undefined : repoOfPush(options);
  const home = homeSettings(options.root, readFile);
  const breaks: Break[] = invalidPatternBreaks(patterns);
  const pushed = commitsOfPush();
  if (pushed === undefined) return 1;
  const commits = pushed.all;
  let lines = 0;
  for (const sha of commits) {
    const read = readCommit(sha, privates, home, repo, options.git, pathsOf);
    if (read === undefined) {
      io.stderr(`conventions pre-push: git cannot show the commit ${sha.slice(0, 12)}. The push stops.\n`);
      return 1;
    }
    for (const item of read.breaks) breaks.push(item);
    lines += read.lines;
  }
  if (breaks.length === 0) {
    io.stderr(`conventions pre-push: ${String(commits.size)} commits, ${String(lines)} lines read, 0 breaks.\n`);
    return 0;
  }
  const out = [`conventions pre-push: ${String(commits.size)} commits, ${String(lines)} lines read, ${String(breaks.length)} breaks. The push stops.`];
  for (const item of breaks) {
    out.push(`  ${placeOf(item)}  ${item.message}`);
    if (item.fix !== undefined) out.push(`    fix: ${item.fix}`);
  }
  out.push("Change the commits (git commit --amend, or git rebase), and push again.");
  io.stderr(`${out.join("\n")}\n`);
  return 1;
}

/** The configuration of ste-lint after it reads `ste.config.json`. The hook reads these fields and keeps the other fields. */
interface SteConfig {
  /** The folder that `include` and `ignore` start at: the folder of `ste.config.json`. */
  readonly root: string;
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly dictionaryPath: string | null;
}

/** A finding of ste-lint. Lines and columns start at 1. */
interface SteFinding {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly ruleId: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

/** The functions of `@mark1russell7/ste-lint` that the STE step uses. Version 0.3.0 and later have them. */
interface SteLint {
  readonly loadConfig: (options: { readonly cwd: string; readonly configPath?: string; readonly env?: Readonly<Record<string, string | undefined>> }) => SteConfig;
  readonly parseArgs: (argv: readonly string[]) => { readonly patterns: readonly string[]; readonly maxWarnings: number | null; readonly configPath: string | null };
  readonly findFiles: (options: { readonly root: string; readonly include: readonly string[]; readonly ignore: readonly string[]; readonly ignoreRoot?: string }) => readonly string[];
  readonly fileKind: (path: string) => string | null;
  readonly loadDictionary: (path: string) => unknown;
  readonly buildLexicon: (config: SteConfig, dictionary: unknown) => unknown;
  readonly Linter: new (config: SteConfig, lexicon?: unknown) => { lintFile(path: string, displayPath?: string): readonly SteFinding[] };
}

/** The names of the functions of `SteLint`. */
const STE_FUNCTIONS = ["loadConfig", "parseArgs", "findFiles", "fileKind", "loadDictionary", "buildLexicon", "Linter"] as const;

/** The npm name of ste-lint. */
const STE_LINT = "@mark1russell7/ste-lint";

/** This function loads the ste-lint of the `node_modules` of `root`. It throws when the repository does not have it. */
function loadRepoSteLint(root: string): unknown {
  return createRequire(join(root, "package.json"))(STE_LINT);
}

/** This function gives the line of the STE step when it cannot lint. The line does not stop the push. */
const noSteRead = (reason: string): string => `conventions pre-push: No STE read: ${reason}\n`;

/** This function gives the message of a thrown value. */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * This function gives the arguments of a script `ste-lint <arguments>`. It gives undefined for a script of a different
 * form: a different command, more than one command, or a shell expansion. A word in single or double quotes is one argument.
 */
export function steLintArguments(script: string): readonly string[] | undefined {
  if (/[;&|<>`$()\\\n]/.test(script)) return undefined;
  const words: string[] = [];
  for (const match of script.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const word = match[1] ?? match[2] ?? match[3] ?? "";
    if (match[3] !== undefined && /["']/.test(word)) return undefined;
    words.push(word);
  }
  return words[0] === "ste-lint" ? words.slice(1) : undefined;
}

/** This function reads the script `lint:ste` of the root `package.json`, or gives undefined when it has none. */
function steScript(root: string, readFile: (path: string) => string): string | undefined {
  try {
    const manifest = JSON.parse(readFile(join(root, "package.json"))) as { readonly scripts?: Readonly<Record<string, unknown>> };
    const script = manifest.scripts?.["lint:ste"];
    return typeof script === "string" ? script : undefined;
  } catch {
    // The private name step and the check of CI report a package.json that does not parse
    return undefined;
  }
}

/**
 * The STE step of `prePush`. It lints the prose files that the new commits add or change, as the script `lint:ste` lints
 * them in CI. It uses the ste-lint of the repository, its `ste.config.json` and the arguments of the script. It lints the
 * text of each file at the tip of the push, not the text in the working tree.
 *
 * An error stops the push. A warning stops it
 * only when the warnings are more than the value of `--max-warnings`. When the step cannot lint, it writes a line
 * `conventions pre-push: No STE read` and does not stop the push. The step gives 1 when it stops the push, and 0 otherwise.
 */
function steLint(options: PrePushOptions, io: Pick<CliIo, "stderr">, commitsOfPush: () => PushCommits | undefined, pathsOf: (sha: string) => readonly string[] | undefined): number {
  const readFile = options.readFile ?? ((path: string): string => readFileSync(path, "utf8"));
  const script = steScript(options.root, readFile);
  // CI lints no prose without the script, so the hook does not lint either
  if (script === undefined) return 0;
  const argv = steLintArguments(script);
  if (argv === undefined) {
    io.stderr(noSteRead(`the script lint:ste is not one command ste-lint ("${script}").`));
    return 0;
  }
  let loaded: unknown;
  try {
    loaded = (options.loadSteLint ?? loadRepoSteLint)(options.root);
  } catch (error) {
    const missing = typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "MODULE_NOT_FOUND";
    io.stderr(noSteRead(missing ? `the node_modules of the repository do not have ${STE_LINT}. Install the dependencies.` : `${STE_LINT} does not load: ${messageOf(error)}`));
    return 0;
  }
  const absent = STE_FUNCTIONS.filter((name) => typeof (loaded as Record<string, unknown> | null)?.[name] !== "function");
  if (absent.length > 0) {
    io.stderr(noSteRead(`the ${STE_LINT} of the repository does not have ${absent.join(", ")}. Use version 0.3.0 or later.`));
    return 0;
  }
  const ste = loaded as SteLint;
  let cli: ReturnType<SteLint["parseArgs"]>;
  let config: SteConfig;
  let lexicon: unknown;
  try {
    cli = ste.parseArgs(argv);
  } catch (error) {
    io.stderr(noSteRead(`ste-lint refuses the arguments of the script lint:ste: ${messageOf(error)}`));
    return 0;
  }
  try {
    config = ste.loadConfig({ cwd: options.root, env: options.env, ...(cli.configPath === null ? {} : { configPath: cli.configPath }) });
    // As the CLI of ste-lint: a dictionary file that does not exist turns off the rule unknown-word
    const dictionary = config.dictionaryPath !== null && existsSync(config.dictionaryPath) ? ste.loadDictionary(config.dictionaryPath) : null;
    lexicon = ste.buildLexicon(config, dictionary);
  } catch (error) {
    io.stderr(noSteRead(`ste-lint cannot read its configuration: ${messageOf(error)}`));
    return 0;
  }
  // The copy of the repository in the temporary folder keeps the place of the root under the folder of ste.config.json
  const below = relative(config.root, options.root);
  if (below.startsWith("..") || isAbsolute(below)) {
    io.stderr(noSteRead(`the ste.config.json of ste-lint is not in the root of the repository or in a folder above it.`));
    return 0;
  }
  const pushed = commitsOfPush();
  if (pushed === undefined) return 1;
  const findings: SteFinding[] = [];
  let files = 0;
  for (const [tip, commits] of pushed.tips) {
    const paths = new Set<string>();
    for (const sha of commits) {
      const changed = pathsOf(sha);
      if (changed === undefined) {
        io.stderr(`conventions pre-push: git cannot show the commit ${sha.slice(0, 12)}. The push stops.\n`);
        return 1;
      }
      for (const path of changed) if (ste.fileKind(path) !== null) paths.add(path);
    }
    if (paths.size === 0) continue;
    // ste-lint selects the files with its own rules, from a copy of the changed files at the tip
    const temp = mkdtempSync(join(tmpdir(), "conventions-ste-"));
    try {
      const copy = join(temp, below);
      for (const path of paths) {
        // A later commit of the push can remove the file
        const text = options.git(["cat-file", "blob", `${tip}:${path}`]);
        if (text === undefined) continue;
        mkdirSync(dirname(join(copy, path)), { recursive: true });
        writeFileSync(join(copy, path), text);
      }
      // As the CLI of ste-lint: the patterns of the script start at the root, and the ignore patterns at the configuration
      const selected =
        cli.patterns.length > 0
          ? ste.findFiles({ root: copy, include: cli.patterns, ignore: config.ignore, ignoreRoot: temp })
          : ste.findFiles({ root: temp, include: config.include, ignore: config.ignore });
      const linter = new ste.Linter({ ...config, root: temp }, lexicon);
      for (const file of selected) {
        if (ste.fileKind(file) === null) continue;
        files += 1;
        for (const finding of linter.lintFile(file, relative(copy, file).split(sep).join("/"))) findings.push(finding);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  const tooMany = cli.maxWarnings !== null && warnings > cli.maxWarnings;
  const stop = errors > 0 || tooMany;
  const limit = tooMany ? `, more than the ${String(cli.maxWarnings)} of --max-warnings` : "";
  const out = [`conventions pre-push: STE: ${String(files)} files read, ${String(errors)} errors, ${String(warnings)} warnings${limit}.${stop ? " The push stops." : ""}`];
  for (const finding of findings) out.push(`  ${finding.file}:${String(finding.line)}:${String(finding.column)}  ${finding.severity}  ${finding.message}  ${finding.ruleId}`);
  if (stop) out.push("Correct the prose in a new commit, and push again.");
  io.stderr(`${out.join("\n")}\n`);
  return stop ? 1 : 0;
}

/** The marker line of the hook that `conventions hook install` writes. The command rewrites only a hook with this line. */
export const HOOK_MARKER = "# conventions hook: pre-push";

/** The first version of the package with the command `conventions pre-push`. */
export const FIRST_PRE_PUSH_VERSION = "0.37.1";

/** This function gives the version of this package, from its package.json, or FIRST_PRE_PUSH_VERSION when it cannot read it. */
function ownVersion(): string {
  try {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof version === "string" && /^\d+\.\d+\.\d+/.test(version) ? version : FIRST_PRE_PUSH_VERSION;
  } catch {
    return FIRST_PRE_PUSH_VERSION;
  }
}

/**
 * A Node program for the hook. Argument 1 is a package.json, and argument 2 is a version. The program exits 0 when the
 * version of the package.json is the same as or later than argument 2, and 1 otherwise. A pre-release counts as its release. It has no single quote, so the shell
 * gives it as one argument.
 */
const AT_LEAST =
  'let v;try{v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version}catch{process.exit(1)}' +
  'const a=String(v).split("-")[0].split(".").map(Number),b=process.argv[2].split(".").map(Number);' +
  "for(let i=0;i<3;i++)if(a[i]!==b[i])process.exit(a[i]>b[i]?0:1);process.exit(0)";

/**
 * The text of the hook `pre-push` that `conventions hook install` writes: a POSIX shell script.
 *
 * Git keeps one hooks folder for all worktrees of a repository, but each worktree has its own node_modules. A worktree
 * of an older branch can have a conventions with no pre-push command (before 0.37.1). Then the hook starts the
 * version that wrote it, with pnpm dlx. The hook stays closed: when no conventions can start, the push stops.
 */
export const PRE_PUSH_HOOK: string = `#!/bin/sh
${HOOK_MARKER}
# The command "conventions hook install" wrote this file, and each install writes it again.
# The hook examines the new commits of each push with the private name list, and lints their prose with ste-lint.
# All worktrees use this file. A worktree with a conventions older than ${FIRST_PRE_PUSH_VERSION} has no pre-push command,
# so then the hook starts the version that wrote it.
root="$(git rev-parse --show-toplevel)" || exit 1
bin="$root/node_modules/.bin/conventions"
pkg="$root/node_modules/@mark1russell7/conventions/package.json"
if [ -x "$bin" ] && node -e '${AT_LEAST}' "$pkg" ${FIRST_PRE_PUSH_VERSION} 2>/dev/null; then
  exec "$bin" pre-push "$@"
fi
exec pnpm dlx @mark1russell7/conventions@${ownVersion()} pre-push "$@"
`;

/** The options of `installHook`. */
export interface HookOptions {
  /** The folder of the command. A relative hooks folder of git starts here. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** This function starts git in `cwd`, and gives its output, or undefined when git fails. */
  readonly git: (args: readonly string[]) => string | undefined;
}

/** This function tells if the environment is a CI run. */
const isCi = (env: Readonly<Record<string, string | undefined>>): boolean => ["true", "1"].includes((env["CI"] ?? "").toLowerCase()) || env["GITHUB_ACTIONS"] === "true";

/**
 * This function is the command `conventions hook install`. It writes the hook `pre-push` into the hooks folder of git,
 * so it uses the folder of `core.hooksPath` and works in a worktree. It keeps a hook that does not have `HOOK_MARKER`, and writes a warning.
 * In CI or outside a git repository, it writes one line and does nothing.
 */
export function installHook(options: HookOptions, io: Pick<CliIo, "stdout" | "stderr">): number {
  if (isCi(options.env)) {
    io.stdout("conventions hook install: CI has no push hook, so the command does nothing.\n");
    return 0;
  }
  const hooks = options.git(["rev-parse", "--git-path", "hooks"])?.trim() ?? "";
  if (hooks === "") {
    io.stdout("conventions hook install: The folder is not in a git repository, so the command does nothing.\n");
    return 0;
  }
  const dir = resolve(options.cwd, hooks);
  const file = join(dir, "pre-push");
  const shown = `${hooks.replace(/[\\/]+$/, "")}/pre-push`;
  const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (before !== undefined && !before.includes(HOOK_MARKER)) {
    io.stderr(`conventions hook install: warning: ${shown} exists and conventions did not write it. The command keeps it. Add the line 'conventions pre-push "$@"' to it, or remove it and install again.\n`);
    return 0;
  }
  if (before === PRE_PUSH_HOOK) {
    io.stdout(`conventions hook install: ${shown} is current.\n`);
    return 0;
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, PRE_PUSH_HOOK, { mode: 0o755 });
    chmodSync(file, 0o755);
  } catch (error) {
    io.stderr(`conventions hook install: Cannot write ${shown}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  io.stdout(`conventions hook install: ${before === undefined ? "wrote" : "updated"} ${shown}.\n`);
  return 0;
}
