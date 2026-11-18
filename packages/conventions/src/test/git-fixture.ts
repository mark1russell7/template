// The fixture repositories of the tests, with few git starts. Each start of a process costs time, and on Windows also
// kernel memory, so a suite that starts thousands of git processes can stop the computer.
//
// - A test file makes one empty repository (one `git init`). Each case copies its `.git` folder, with no git start.
// - `stageAll` puts each file in the index with one git start: enough for a rule that reads only `git ls-files`.
// - `commitAll` commits each file with two git starts: for a rule that reads the history.
// - `copy` copies a repository with its work tree, with no git start: for a case that changes a shared repository.
// - `shared` builds each fixture repository one time, and gives each case its own copy.
//
// This module is a copy of a test helper. Its home is @mark1russell7/rigor-testkit, and the copy goes when that
// package exports it. The end: conventions then imports it from there.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The identity of the commits of the tests, with no signature and no hooks. */
const GIT_OPTIONS: readonly string[] = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

/**
 * The environment of the git of the fixtures. A git hook sets variables, for example `GIT_DIR`, and with them git writes to
 * the repository of the hook, not to the fixture.
 */
function fixtureEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX"]) delete env[name];
  return env;
}

/** The fixture repositories of one test file. */
export interface GitFixtures {
  /** The temporary folder of the test file. */
  readonly temp: string;
  /** This function makes a new empty folder in the temporary folder, and gives its path. */
  folder(): string;
  /** This function writes each file in `root`. An object becomes JSON. */
  write(root: string, files: Readonly<Record<string, unknown>>): void;
  /** This function writes each file in a new folder, and gives its path. The folder is not a repository. */
  fixture(files: Readonly<Record<string, unknown>>): string;
  /** This function starts git in `root` with the identity of the tests, and gives its output. It throws when git fails. */
  git(root: string, ...args: string[]): string;
  /** This function makes `root` a repository with the branch `main` and no commit. It starts no git. */
  init(root: string): void;
  /** This function makes `root` a repository, and puts each of its files in the index with one git start. */
  stageAll(root: string): void;
  /** This function makes `root` a repository, and commits each of its files with two git starts. */
  commitAll(root: string, message?: string): void;
  /**
   * This function gives the commit of `HEAD` or of the branch `branch` from the files of `.git`, with no git start. It
   * starts `git rev-parse` only for a packed ref.
   */
  commitOf(root: string, branch?: string): string;
  /** This function copies the repository `root` with its work tree to a new folder, and gives its path. */
  copy(root: string): string;
  /**
   * This function gives a new copy of the repository that `build` makes. It starts `build` one time for each key, and
   * copies its repository for each call, with no git start. Thus the cases of a file share each fixture repository.
   */
  shared(key: string, build: () => string): string;
  /** This function removes the temporary folder. */
  remove(): void;
}

/** This function writes a file, and makes its folder. An object becomes JSON with a new line at the end. */
function writeFile(root: string, file: string, text: unknown): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), typeof text === "string" ? text : `${JSON.stringify(text, null, 2)}\n`);
}

/** This function gives the fixture repositories of one test file, in a new temporary folder with the prefix `prefix`. */
export function gitFixtures(prefix: string): GitFixtures {
  const temp = mkdtempSync(join(tmpdir(), prefix));
  let folders = 0;
  let template: string | undefined;
  const built = new Map<string, string>();
  const env = fixtureEnv();

  const git = (root: string, ...args: string[]): string => {
    const result = spawnSync("git", [...GIT_OPTIONS, ...args], { cwd: root, encoding: "utf8", env, windowsHide: true });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  const folder = (): string => {
    const root = join(temp, String(folders++));
    mkdirSync(root, { recursive: true });
    return root;
  };
  const init = (root: string): void => {
    if (existsSync(join(root, ".git"))) return;
    if (template === undefined) {
      template = join(temp, "template");
      mkdirSync(template, { recursive: true });
      // An empty template folder gives a .git folder with no sample hooks: fewer files to copy.
      git(template, "init", "-q", "-b", "main", "--template=");
    }
    cpSync(join(template, ".git"), join(root, ".git"), { recursive: true });
  };

  const commitOf = (root: string, branch?: string): string => {
    const dir = join(root, ".git");
    let ref = branch === undefined ? readFileSync(join(dir, "HEAD"), "utf8").trim() : `ref: refs/heads/${branch}`;
    if (!ref.startsWith("ref: ")) return ref;
    ref = ref.slice("ref: ".length);
    const file = join(dir, ...ref.split("/"));
    return existsSync(file) ? readFileSync(file, "utf8").trim() : git(root, "rev-parse", "--verify", ref).trim();
  };
  const copy = (root: string): string => {
    const to = join(temp, String(folders++));
    cpSync(root, to, { recursive: true });
    return to;
  };

  return {
    temp,
    folder,
    write(root, files) {
      for (const [file, text] of Object.entries(files)) writeFile(root, file, text);
    },
    fixture(files) {
      const root = folder();
      for (const [file, text] of Object.entries(files)) writeFile(root, file, text);
      return root;
    },
    git,
    init,
    stageAll(root) {
      init(root);
      git(root, "add", "-A");
    },
    commitAll(root, message = "first") {
      init(root);
      git(root, "add", "-A");
      git(root, "commit", "-q", "--allow-empty", "-m", message);
    },
    commitOf,
    copy,
    shared(key, build) {
      let root = built.get(key);
      if (root === undefined) {
        root = build();
        built.set(key, root);
      }
      return copy(root);
    },
    remove() {
      rmSync(temp, { recursive: true, force: true });
    },
  };
}
