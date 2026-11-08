// The private pattern file, the command pre-push and the command hook install, on fixture repositories.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  HOOK_MARKER,
  installHook,
  invalidPatternBreaks,
  NO_READ_LINE,
  PRE_PUSH_HOOK,
  prePush,
  privatePatternFile,
  privateTextBreaks,
  readPrivatePatterns,
  runCli,
  type CliIo,
} from "./index.ts";
import { addedRuns } from "./pre-push.ts";

/** The private pattern of each test. No real name is private here. */
const PROBE = "zz-test-pattern-7316";
const ZEROS = "0".repeat(40);

const temp = mkdtempSync(join(tmpdir(), "conventions-pre-push-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

// The tests do not read the git configuration of the computer: a global core.hooksPath or a pattern file there changes the result
const emptyConfig = join(temp, "empty.gitconfig");
writeFileSync(emptyConfig, "");
const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1" };
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete gitEnv[name];

/** This function gives a git function for `root`, as the CLI gives it, without the configuration of the computer. */
function gitIn(root: string): (args: readonly string[]) => string | undefined {
  return (args) => {
    const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8", env: gitEnv });
    return result.error || result.status !== 0 ? undefined : result.stdout;
  };
}

/** This function starts git in `root` for a test step, and gives its output. */
function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", env: gitEnv });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** This function writes the files in `root`. */
function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

/** A repository with a first commit, which `origin/main` has. It gives the root and the sha of the first commit. */
function repository(): { root: string; base: string } {
  const root = join(temp, String(fixtures++));
  mkdirSync(root, { recursive: true });
  write(root, { "package.json": `${JSON.stringify({ name: "one" })}\n`, "notes.md": "1\n" });
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  return { root, base };
}

/** This function makes a commit of `files` with `message`, and gives its sha. */
function commit(root: string, files: Record<string, string>, message: string): string {
  write(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

/** This function writes a private pattern file, and gives its path. */
function patternFile(text = `${PROBE}\n`): string {
  const file = join(temp, `patterns-${String(fixtures++)}.txt`);
  writeFileSync(file, text);
  return file;
}

/** This function starts prePush, and gives the exit code and the text of stderr. */
function push(root: string, input: string, env: Record<string, string> = { CONVENTIONS_PRIVATE_PATTERNS_FILE: patternFile() }): { code: number; stderr: string } {
  let stderr = "";
  const code = prePush({ remote: "origin", input, env, root, git: gitIn(root) }, { stderr: (text) => (stderr += text) });
  return { code, stderr };
}

/** This function starts installHook in `cwd`, and gives the exit code and the output. */
function install(cwd: string, env: Record<string, string> = {}, git = gitIn(cwd)): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = installHook({ cwd, env, git }, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { code, stdout, stderr };
}

describe("the private pattern core", () => {
  it("gives a break with no text and no pattern for a match", () => {
    const breaks = privateTextBreaks("notes.md", `clean\nthe ${PROBE} line\n`, readPrivatePatterns(`${PROBE}\n`));
    expect(breaks).toEqual([
      { file: "notes.md", line: 2, message: "A text matches the private pattern on line 1 of the private pattern file.", fix: "Remove the text. The check does not show the text, because the pattern is private." },
    ]);
    expect(JSON.stringify(breaks)).not.toContain(PROBE);
  });

  it("makes a pattern that is not a regular expression a break of its own, not an error", () => {
    const patterns = readPrivatePatterns(`${PROBE}\n(qx-unclosed\n`);
    const invalid = invalidPatternBreaks(patterns);
    expect(invalid).toEqual([
      { file: "the private pattern file", line: 2, message: "Line 2 of the private pattern file is not a valid regular expression.", fix: "Correct the regular expression. The check does not show the pattern, because it is private." },
    ]);
    expect(JSON.stringify(invalid)).not.toContain("qx-unclosed");
    // The valid patterns still count
    expect(privateTextBreaks("notes.md", PROBE, patterns).map((item) => item.line)).toEqual([1]);
  });

  it("merges the file and the environment variable, and a break names the source", () => {
    const patterns = readPrivatePatterns(`\n  ${PROBE}  \n`, { CONVENTIONS_PRIVATE_PATTERNS: "qx-probe-other" });
    expect(patterns).toEqual([
      { source: PROBE, line: 2, label: "the private pattern file" },
      { source: "qx-probe-other", line: 1, label: "CONVENTIONS_PRIVATE_PATTERNS" },
    ]);
    const messages = privateTextBreaks("a commit", `${PROBE} and qx-probe-other`, patterns).map((item) => item.message);
    expect(messages).toEqual([
      "A text matches the private pattern on line 2 of the private pattern file.",
      "A text matches the private pattern on line 1 of CONVENTIONS_PRIVATE_PATTERNS.",
    ]);
    expect(readPrivatePatterns(undefined, {})).toEqual([]);
  });

  it("reports the home folder of a user, and not an allowed name, with the first line of the text", () => {
    const home = ["", "home", "alice", "x"].join("/");
    const runner = ["", "home", "runner", "work"].join("/");
    const breaks = privateTextBreaks("notes.md", `${home}\n${runner}`, [], { firstLine: 10 });
    expect(breaks).toEqual([{ file: "notes.md", line: 10, message: `The text "${["", "home", "alice"].join("/")}" is the home folder of a user.` }]);
    expect(privateTextBreaks("notes.md", home, [], { allow: ["alice"] })).toEqual([]);
    expect(privateTextBreaks("notes.md", home, [], { homes: false })).toEqual([]);
  });

  it("finds the path of the file in the environment, else in the git configuration", () => {
    const asked: (readonly string[])[] = [];
    const fake = (args: readonly string[]): string | undefined => {
      asked.push(args);
      return "/patterns/from-git.txt\n";
    };
    expect(privatePatternFile({ CONVENTIONS_PRIVATE_PATTERNS_FILE: "/patterns/from-env.txt" }, fake)).toBe("/patterns/from-env.txt");
    expect(asked).toEqual([]);
    expect(privatePatternFile({}, fake)).toBe("/patterns/from-git.txt");
    expect(asked).toEqual([["config", "--type=path", "--get", "conventions.privatePatternsFile"]]);
    expect(privatePatternFile({ CONVENTIONS_PRIVATE_PATTERNS_FILE: " " }, () => undefined)).toBeUndefined();
  });

  it("reads the added lines of a patch by the counts of the hunks", () => {
    const patch = ["diff --git a/x.md b/x.md", "--- a/x.md", "+++ b/x.md", "@@ -2,1 +2,3 @@", "-old", "+new", "+++ not a header", "+three", "@@ -9 +11 @@", "-a", "+b"].join("\n");
    expect(addedRuns(patch)).toEqual([
      { file: "x.md", first: 2, lines: ["new", "++ not a header", "three"] },
      { file: "x.md", first: 11, lines: ["b"] },
    ]);
  });
});

describe("conventions pre-push", () => {
  it("stops a push with the private pattern in a commit message, and does not show it", () => {
    const { root, base } = repository();
    const head = commit(root, { "notes.md": "2\n" }, `second\n\nthe ${PROBE} note`);
    const { code, stderr } = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain(`commit ${head.slice(0, 12)} message:3  A text matches the private pattern on line 1 of the private pattern file.`);
    expect(stderr).toMatch(/^conventions pre-push: 1 commits, \d+ lines read, 1 breaks\. The push stops\./);
    expect(stderr).not.toContain(PROBE);
  });

  it("stops a push with the private pattern on an added line, with the line of the new file", () => {
    const { root, base } = repository();
    const head = commit(root, { "notes.md": `1\nthe ${PROBE}\n` }, "second");
    const { code, stderr } = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain(`commit ${head.slice(0, 12)} notes.md:2  A text matches the private pattern`);
    expect(stderr).not.toContain(PROBE);
  });

  it("stops a push with the private pattern in a path, and does not show the path", () => {
    const { root, base } = repository();
    const head = commit(root, { [`docs/${PROBE}.md`]: "clean\n" }, "second");
    const { code, stderr } = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain(`commit ${head.slice(0, 12)} path 1  The path matches the private pattern on line 1 of the private pattern file.`);
    expect(stderr).not.toContain(PROBE);
  });

  it("passes a clean push with a summary line", () => {
    const { root, base } = repository();
    const head = commit(root, { "notes.md": "1\n2\n" }, "a clean change");
    const { code, stderr } = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(0);
    expect(stderr).toMatch(/^conventions pre-push: 1 commits, [1-9]\d* lines read, 0 breaks\.\n$/);
  });

  it("reads only the commits that no remote branch has, for a new branch", () => {
    const { root } = repository();
    git(root, "checkout", "-q", "-b", "feature");
    const head = commit(root, { "notes.md": "1\nfeature\n" }, `the ${PROBE} branch`);
    const { code, stderr } = push(root, `refs/heads/feature ${head} refs/heads/feature ${ZEROS}\n`);
    expect(code).toBe(1);
    expect(stderr).toMatch(/^conventions pre-push: 1 commits,/);
    expect(stderr).toContain(`commit ${head.slice(0, 12)} message:1`);
  });

  it("does not read the history that a remote branch has, for a new branch", () => {
    const { root } = repository();
    // The remote has a commit with the pattern. The push does not change that commit, so the gate does not read it
    const old = commit(root, { "old.md": `${PROBE}\n` }, `an old ${PROBE} commit`);
    git(root, "update-ref", "refs/remotes/origin/main", old);
    git(root, "checkout", "-q", "-b", "feature");
    const head = commit(root, { "notes.md": "1\nfeature\n" }, "a clean feature");
    const { code, stderr } = push(root, `refs/heads/feature ${head} refs/heads/feature ${ZEROS}\n`);
    expect(code).toBe(0);
    expect(stderr).toMatch(/^conventions pre-push: 1 commits, \d+ lines read, 0 breaks\.\n$/);
  });

  it("skips a deleted ref", () => {
    const { root, base } = repository();
    const { code, stderr } = push(root, `(delete) ${ZEROS} refs/heads/old ${base}\n`);
    expect(code).toBe(0);
    expect(stderr).toBe("conventions pre-push: 0 commits, 0 lines read, 0 breaks.\n");
  });

  it("writes the No read line and does not stop the push when no file is set", () => {
    const { root, base } = repository();
    const head = commit(root, { "notes.md": `${PROBE}\n` }, "second");
    const { code, stderr } = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`, {});
    expect(code).toBe(0);
    expect(stderr).toBe(`${NO_READ_LINE}\n`);
    expect(stderr).toBe("conventions pre-push: No read: no private pattern file. Set CONVENTIONS_PRIVATE_PATTERNS_FILE or the git config conventions.privatePatternsFile.\n");
  });

  it("reads the file of the git configuration", () => {
    const { root, base } = repository();
    git(root, "config", "conventions.privatePatternsFile", patternFile());
    const head = commit(root, { "notes.md": `${PROBE}\n` }, "second");
    expect(push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`, {}).code).toBe(1);
  });

  it("stops the push when the file that the settings name does not exist", () => {
    const { root, base } = repository();
    const head = commit(root, { "notes.md": "2\n" }, "second");
    const { code, stderr } = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`, { CONVENTIONS_PRIVATE_PATTERNS_FILE: join(temp, "missing.txt") });
    expect(code).toBe(1);
    expect(stderr).toBe(
      "conventions pre-push: Cannot read the private pattern file that CONVENTIONS_PRIVATE_PATTERNS_FILE names: the file does not exist. Correct the setting or the file. The push stops.\n",
    );
  });

  it("stops the push when the file of the git configuration does not exist, or is a folder", () => {
    const { root, base } = repository();
    const head = commit(root, { "notes.md": "2\n" }, "second");
    git(root, "config", "conventions.privatePatternsFile", join(temp, "missing-too.txt"));
    const missing = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`, {});
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("that the git config conventions.privatePatternsFile names: the file does not exist.");
    git(root, "config", "conventions.privatePatternsFile", temp);
    const folder = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`, {});
    expect(folder.code).toBe(1);
    expect(folder.stderr).toContain("names: the path is a folder.");
  });

  it("stops the push on a pattern that is not valid, and keeps the home folder exceptions of package.json", () => {
    const { root, base } = repository();
    const home = ["", "home", "alice", "x"].join("/");
    const conventions = { rules: { "no-local-paths": { ignore: ["fixtures/**"], reason: "test fixtures" } } };
    const head = commit(root, { "package.json": `${JSON.stringify({ name: "one", conventions })}\n`, "fixtures/a.txt": `${home}\n` }, "second");
    const clean = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(clean.code).toBe(0);
    const { code, stderr } = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`, { CONVENTIONS_PRIVATE_PATTERNS_FILE: patternFile(`${PROBE}\n(qx-unclosed\n`) });
    expect(code).toBe(1);
    expect(stderr).toContain("the private pattern file:2  Line 2 of the private pattern file is not a valid regular expression.");
    expect(stderr).not.toContain("qx-unclosed");
  });

  it("starts from the bin with the standard input, and gives exit code 2 without a remote", () => {
    const { root, base } = repository();
    const head = commit(root, { "notes.md": "2\n" }, "second");
    let stderr = "";
    const io: CliIo = { cwd: root, env: { CONVENTIONS_PRIVATE_PATTERNS_FILE: join(temp, "missing.txt") }, stdout: () => undefined, stderr: (text) => (stderr += text), stdin: `refs/heads/main ${head} refs/heads/main ${base}\n` };
    expect(runCli(["pre-push", "origin", "https://example.com/one.git"], io)).toBe(1);
    expect(stderr).toMatch(/Cannot read the private pattern file/);
    expect(runCli(["pre-push"], io)).toBe(2);
  });
});

describe("conventions hook install", () => {
  it("writes the hook into the hooks folder of git", () => {
    const { root } = repository();
    const { code, stdout } = install(root);
    expect(code).toBe(0);
    expect(stdout).toBe("conventions hook install: wrote .git/hooks/pre-push.\n");
    const file = join(root, ".git", "hooks", "pre-push");
    expect(readFileSync(file, "utf8")).toBe(PRE_PUSH_HOOK);
    expect(PRE_PUSH_HOOK).toMatch(/^#!\/bin\/sh\n/);
    expect(PRE_PUSH_HOOK).toContain(HOOK_MARKER);
    expect(PRE_PUSH_HOOK).toContain('pre-push "$@"');
    if (process.platform !== "win32") expect(statSync(file).mode & 0o111).not.toBe(0);
    expect(install(root).stdout).toBe("conventions hook install: .git/hooks/pre-push is current.\n");
  });

  it("honors core.hooksPath", () => {
    const { root } = repository();
    git(root, "config", "core.hooksPath", ".githooks");
    expect(install(root).code).toBe(0);
    expect(readFileSync(join(root, ".githooks", "pre-push"), "utf8")).toBe(PRE_PUSH_HOOK);
  });

  it("updates its own hook", () => {
    const { root } = repository();
    const file = join(root, ".git", "hooks", "pre-push");
    write(root, { ".git/hooks/pre-push": `#!/bin/sh\n${HOOK_MARKER}\necho old\n` });
    expect(install(root).stdout).toBe("conventions hook install: updated .git/hooks/pre-push.\n");
    expect(readFileSync(file, "utf8")).toBe(PRE_PUSH_HOOK);
  });

  it("keeps a hook that it did not write, and warns", () => {
    const { root } = repository();
    const foreign = "#!/bin/sh\necho acme-secret-app\n";
    write(root, { ".git/hooks/pre-push": foreign });
    const { code, stderr } = install(root);
    expect(code).toBe(0);
    expect(stderr).toMatch(/^conventions hook install: warning: \.git\/hooks\/pre-push exists and conventions did not write it\./);
    expect(readFileSync(join(root, ".git", "hooks", "pre-push"), "utf8")).toBe(foreign);
  });

  it("does nothing in CI or outside a git repository", () => {
    const { root } = repository();
    expect(install(root, { CI: "true" })).toEqual({ code: 0, stdout: "conventions hook install: CI has no push hook, so the command does nothing.\n", stderr: "" });
    expect(install(root, { GITHUB_ACTIONS: "true" }).code).toBe(0);
    expect(existsSync(join(root, ".git", "hooks", "pre-push"))).toBe(false);
    expect(install(root, {}, () => undefined)).toEqual({ code: 0, stdout: "conventions hook install: The folder is not in a git repository, so the command does nothing.\n", stderr: "" });
    // The bin in CI writes no hook either
    const io: CliIo = { cwd: root, env: { CI: "true" }, stdout: () => undefined, stderr: () => undefined };
    expect(runCli(["hook", "install"], io)).toBe(0);
    expect(existsSync(join(root, ".git", "hooks", "pre-push"))).toBe(false);
    expect(runCli(["hook"], io)).toBe(2);
  });
});
