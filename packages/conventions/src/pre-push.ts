/**
 * The commands `conventions pre-push` and `conventions hook install`. The hook `pre-push` of git starts the first
 * command before each push. It examines the new commits of the push with the private name list, which is outside
 * of the public repositories. The second command writes that hook.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseConfig } from "./config.ts";
import { matchesAny, type Break, type Manifest } from "./rule.ts";
import { RULES } from "./rules/index.ts";
import { repositoryOfRemote } from "./rules/runner-budget.ts";
import { parsePrivateNames, PrivateNameListError, type PrivateNameList } from "./private-names.ts";
import {
  invalidPatternBreaks,
  PRIVATE_NAMES_FILE_CONFIG,
  PRIVATE_NAMES_FILE_VARIABLE,
  privateNamesFile,
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

/** This function examines one commit: its message, the paths that it adds or changes, and each line that it adds. */
function readCommit(sha: string, privates: PrivateSources, home: HomeSettings, repo: string | undefined, git: PrePushOptions["git"]): CommitRead | undefined {
  const short = sha.slice(0, 12);
  const message = git(["show", "-s", "--format=%B", sha]);
  const names = git(["show", "--format=", "--name-only", "--diff-filter=AMRC", "-z", "--no-ext-diff", sha]);
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
  // The empty format can put a line end before the first name
  const paths = names
    .replace(/^\n+/, "")
    .split("\0")
    .filter((path) => path !== "");
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

/**
 * This function is the command `conventions pre-push`. It examines each new commit of the push: its message, the paths
 * that it adds or changes, and each line that it adds. It writes the breaks to `stderr`, and gives the exit code: 1 on a
 * break, 0 on a pass. With no private name list and no private pattern, it writes the line `NO_READ_LINE` and gives 0.
 */
export function prePush(options: PrePushOptions, io: Pick<CliIo, "stderr">): number {
  const readFile = options.readFile ?? ((path: string): string => readFileSync(path, "utf8"));
  const file = privateNamesFile(options.env, options.git);
  const patterns = privatePatterns(options.env);
  if (file === undefined && patterns.length === 0) {
    // A push with no read is not a pass, so the line tells it. It does not stop the push
    io.stderr(`${NO_READ_LINE}\n`);
    return 0;
  }
  let names: PrivateNameList | undefined;
  if (file !== undefined) {
    // A list that the settings name and that the gate cannot read or parse stops the push: the check fails closed
    const source = (options.env[PRIVATE_NAMES_FILE_VARIABLE]?.trim() ?? "") !== "" ? PRIVATE_NAMES_FILE_VARIABLE : `the git config ${PRIVATE_NAMES_FILE_CONFIG}`;
    let text: string;
    try {
      text = readFile(resolve(options.root, file));
    } catch (error) {
      io.stderr(`conventions pre-push: Cannot read the private name list that ${source} names: ${readReason(error)}. Correct the setting or the file. The push stops.\n`);
      return 1;
    }
    try {
      names = parsePrivateNames(text);
    } catch (error) {
      const reason = error instanceof PrivateNameListError ? error.reason : "the parse failed";
      io.stderr(`conventions pre-push: The private name list that ${source} names is not valid: ${reason}. Correct the file. The push stops.\n`);
      return 1;
    }
  }
  const privates: PrivateSources = { ...(names === undefined ? {} : { names }), patterns };
  const repo = names === undefined || names.allow.length === 0 ? undefined : repoOfPush(options);
  const home = homeSettings(options.root, readFile);
  const breaks: Break[] = invalidPatternBreaks(patterns);
  const commits = new Set<string>();
  for (const line of options.input.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (localSha === undefined || remoteSha === undefined || !SHA.test(localSha) || !SHA.test(remoteSha)) {
      io.stderr(`conventions pre-push: The input line "${line.trim()}" does not have the form <local ref> <local sha> <remote ref> <remote sha>. The push stops.\n`);
      return 1;
    }
    // The push deletes the ref, so it adds no commit
    if (ZERO.test(localSha)) continue;
    const others = ["rev-list", localSha, "--not", `--remotes=${options.remote}`];
    const listed = ZERO.test(remoteSha) ? options.git(others) : (options.git(["rev-list", localSha, `^${remoteSha}`]) ?? options.git(others));
    if (listed === undefined) {
      io.stderr(`conventions pre-push: git cannot list the new commits of ${localRef ?? localSha}. The push stops.\n`);
      return 1;
    }
    for (const sha of listed.split(/\r?\n/)) if (SHA.test(sha.trim())) commits.add(sha.trim());
  }
  let lines = 0;
  for (const sha of commits) {
    const read = readCommit(sha, privates, home, repo, options.git);
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

/** The marker line of the hook that `conventions hook install` writes. The command rewrites only a hook with this line. */
export const HOOK_MARKER = "# conventions hook: pre-push";

/** The text of the hook `pre-push` that `conventions hook install` writes: a POSIX shell script. */
export const PRE_PUSH_HOOK: string = `#!/bin/sh
${HOOK_MARKER}
# The command "conventions hook install" wrote this file, and each install writes it again.
# The hook examines the new commits of each push with the private name list.
root="$(git rev-parse --show-toplevel)" || exit 1
bin="$root/node_modules/.bin/conventions"
if [ -x "$bin" ]; then
  exec "$bin" pre-push "$@"
fi
exec pnpm exec conventions pre-push "$@"
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
