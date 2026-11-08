// The private name list, the command pre-push and the command hook install, on fixture repositories.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  firstNameMatch,
  HOOK_MARKER,
  installHook,
  invalidPatternBreaks,
  isAllowedHit,
  isCommonUse,
  lineNameHit,
  lineNameHits,
  nameMatches,
  NO_READ_LINE,
  parsePrivateNames,
  pathNameHit,
  PRE_PUSH_HOOK,
  prePush,
  PrivateNameListError,
  privateNamesFile,
  privatePatterns,
  privateTextBreaks,
  runCli,
  type CliIo,
  type NameRule,
} from "./index.ts";
import { addedRuns } from "./pre-push.ts";

/** The private probe of each test. No real name is private here. */
const PROBE = "zz-test-pattern-7316";
const ZEROS = "0".repeat(40);

/** A made-up private name list: a name with a common word, and the probe. The allow list permits the probe in one file. */
const LIST = {
  $comment: "A made-up list for the tests.",
  names: [
    { id: "acme-app", project: "The made-up Acme app", seeds: ["acme-app", "Acme"], patterns: ["\\bacme-app\\b"], word: "Acme", commonAfter: ["corp"] },
    { id: "probe", project: "The probe", seeds: [PROBE], patterns: [PROBE] },
  ],
  allow: [
    { repo: "site", path: "docs/allowed.md", name: "probe", why: "The file tells how the probe works." },
    { repo: "acme-labs/site", path: "docs/any.md", why: "Each name is permitted in this file." },
  ],
};
const LIST_TEXT = JSON.stringify(LIST);
const list = parsePrivateNames(LIST_TEXT);

/** The repository of the push in the tests, in the forms of a remote URL. */
const HTTPS = "https://github.com/acme-labs/site.git";
const SSH = "git@github.com:acme-labs/site.git";

const temp = mkdtempSync(join(tmpdir(), "conventions-pre-push-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

// The tests do not read the git configuration of the computer: a global core.hooksPath or a list file there changes the result
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

/** This function writes a private name list, and gives its path. */
function listFile(text = LIST_TEXT): string {
  const file = join(temp, `names-${String(fixtures++)}.json`);
  writeFileSync(file, text);
  return file;
}

/** This function starts prePush, and gives the exit code and the text of stderr. */
function push(root: string, input: string, env: Record<string, string> = { CONVENTIONS_PRIVATE_NAMES_FILE: listFile() }, url?: string): { code: number; stderr: string } {
  let stderr = "";
  const code = prePush({ remote: "origin", ...(url === undefined ? {} : { url }), input, env, root, git: gitIn(root) }, { stderr: (text) => (stderr += text) });
  return { code, stderr };
}

/** This function starts installHook in `cwd`, and gives the exit code and the output. */
function install(cwd: string, env: Record<string, string> = {}, git = gitIn(cwd)): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = installHook({ cwd, env, git }, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { code, stdout, stderr };
}

/** This function gives the reason of the error of a parse, or undefined when the parse passes. */
function parseReason(text: string): string | undefined {
  try {
    parsePrivateNames(text);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(PrivateNameListError);
    return (error as PrivateNameListError).reason;
  }
}

/** The break message of name `n` of the list. */
const named = (n: number): string => `A text names name ${String(n)} of the private name list.`;

describe("the private name list", () => {
  it("parses a list, and the schema has the fields that the parse reads", () => {
    expect(list.names.map((rule) => rule.id)).toEqual(["acme-app", "probe"]);
    expect(list.allow).toHaveLength(2);
    expect(parsePrivateNames(JSON.stringify({ names: [] }))).toEqual({ names: [], allow: [] });
    const schema = JSON.parse(readFileSync(new URL("../schema/private-names.schema.json", import.meta.url), "utf8")) as {
      properties: Record<string, unknown>;
      $defs: { name: { properties: Record<string, unknown>; required: string[] }; allowed: { properties: Record<string, unknown>; required: string[] } };
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["$comment", "$schema", "allow", "names"]);
    expect(Object.keys(schema.$defs.name.properties).sort()).toEqual(["commonAfter", "id", "patterns", "project", "seeds", "word"]);
    expect(schema.$defs.name.required.sort()).toEqual(["id", "patterns", "project", "seeds"]);
    expect(Object.keys(schema.$defs.allowed.properties).sort()).toEqual(["name", "path", "repo", "why"]);
    expect(schema.$defs.allowed.required.sort()).toEqual(["path", "repo", "why"]);
  });

  it("gives a typed error for a bad list, and the reason shows no value of the list", () => {
    const rule = LIST.names[1];
    const variants: [unknown, string][] = [
      [`{"names": [{"id": "${PROBE}"`, "the text is not valid JSON"],
      [[], "the text is not a JSON object"],
      [{ names: [rule], other: PROBE }, "the object has a field that the schema does not have"],
      [{ allow: [] }, "the field names is not a list"],
      [{ names: [{ ...rule, seeds: [] }] }, "name 1 of the private name list: the field seeds is not a list of one or more texts"],
      [{ names: [rule, { ...rule, id: "other", patterns: [PROBE, "(qx-unclosed"] }] }, "name 2 of the private name list: pattern 2 is not a valid regular expression"],
      [{ names: [{ ...rule, word: "two words" }] }, "name 1 of the private name list: the field word is not one word of letters, digits, _ and -"],
      [{ names: [{ ...rule, commonAfter: ["corp"] }] }, "name 1 of the private name list: the field commonAfter has no field word"],
      [{ names: [{ ...rule, commonAfter: ["Corp"], word: "Acme" }] }, "name 1 of the private name list: the field commonAfter is not a list of lower-case words"],
      [{ names: [{ ...rule, extra: 1 }] }, "name 1 of the private name list: the entry has a field that the schema does not have"],
      [{ names: [rule, rule] }, "name 2 of the private name list: the id is also the id of an earlier name"],
      [{ names: [rule], allow: [{ repo: "site", path: "a.md", name: "acme-app", why: "x" }] }, "allow entry 1 of the private name list: the field name is not the id of a name of the list"],
      [{ names: [rule], allow: [{ repo: "site", path: "a.md" }] }, "allow entry 1 of the private name list: the field why is not a text"],
    ];
    for (const [value, reason] of variants) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      const found = parseReason(text);
      expect(found).toBe(reason);
      expect(found).not.toContain(PROBE);
      expect(found).not.toContain("qx-unclosed");
    }
    expect(new PrivateNameListError("x").message).toBe("The private name list is not valid: x.");
  });

  it("does not count the word in code, in a title, after an article or before a word of commonAfter", () => {
    const acme = list.names[0] as NameRule;
    const hit = (line: string): boolean => firstNameMatch(line, [acme]) !== undefined;
    for (const line of ["We ship the Acme team build.", "For Acme, this is a break.","the acme-app repository"]) expect(hit(line), line).toBe(true);
    for (const line of ["Acme corp builds it.", "the Acme Corp office", "class Acme {", "const a = new Acme();", "import { Acme } from './acme';", "a Acme of the data", "## Big Acme layout", "the `Acme` type", "Acme-based tools"]) {
      expect(hit(line), line).toBe(false);
    }
    expect(isCommonUse("the Acme corp", 4, acme)).toBe(true);
    expect(isCommonUse("the Acme team", 4, acme)).toBe(false);
    // The word of commonAfter makes a common word only for the name that lists it
    expect(isCommonUse("the Acme corp", 4, { ...acme, commonAfter: [] })).toBe(false);
  });

  it("gives the first name of a line with a seed, and the index of the name from 1", () => {
    expect(lineNameHit(list, `the ${PROBE} and the Acme team`)).toMatchObject({ name: 1, index: 33 });
    expect(lineNameHit(list, `only the ${PROBE}`)).toMatchObject({ name: 2, index: 9 });
    expect(lineNameHit(list, "a clean line")).toBeUndefined();
    // A line with no seed of the list is no hit, also when a pattern matches
    const seeded = parsePrivateNames(JSON.stringify({ names: [{ id: "x", project: "x", seeds: ["qx-seed"], patterns: ["qx-\\d+"] }] }));
    expect(firstNameMatch("qx-42", seeded.names)).toMatchObject({ name: 1 });
    expect(lineNameHit(seeded, "qx-42")).toBeUndefined();
    expect(lineNameHit(seeded, "qx-seed qx-42")).toMatchObject({ name: 1, index: 8 });
  });

  it("permits a hit by repository and path, and only the name of the entry", () => {
    const line = `the ${PROBE} note`;
    expect(lineNameHit(list, line, { repo: "acme-labs/site", path: "docs/allowed.md" })).toBeUndefined();
    expect(lineNameHit(list, line, { repo: "Acme-Labs/SITE", path: "docs/allowed.md" })).toBeUndefined();
    expect(lineNameHit(list, line, { repo: "acme-labs/site", path: "docs/other.md" })).toMatchObject({ name: 2 });
    expect(lineNameHit(list, line, { repo: "acme-labs/other", path: "docs/allowed.md" })).toMatchObject({ name: 2 });
    expect(lineNameHit(list, line, { path: "docs/allowed.md" })).toMatchObject({ name: 2 });
    // The entry names the probe, so the other name is still a hit in that file
    expect(lineNameHit(list, "the acme-app note", { repo: "acme-labs/site", path: "docs/allowed.md" })).toMatchObject({ name: 1 });
    // An entry with no name permits each name, and an entry owner/name matches only that owner
    expect(isAllowedHit(list.allow, "acme-labs/site", "docs/any.md", "acme-app")).toBe(true);
    expect(isAllowedHit(list.allow, "other-owner/site", "docs/any.md", "acme-app")).toBe(false);
  });

  it("gives each name of a line once, and a permitted hit does not hide another name", () => {
    const line = `the ${PROBE} and the Acme team, and the acme-app repository`;
    expect(nameMatches(line, list.names).map((hit) => hit.name)).toEqual([1, 2]);
    expect(lineNameHits(list, line).map((hit) => [hit.name, hit.index])).toEqual([
      [1, 52],
      [2, 4],
    ]);
    expect(lineNameHits(list, "a clean line")).toEqual([]);
    // The entry of docs/allowed.md permits the probe only: the name 1 stays a hit, and lineNameHit gives it
    const place = { repo: "acme-labs/site", path: "docs/allowed.md" };
    expect(lineNameHits(list, line, place).map((hit) => hit.name)).toEqual([1]);
    expect(lineNameHit(list, `the ${PROBE} and the Acme team`, place)).toMatchObject({ name: 1 });
    expect(lineNameHits(list, line, { repo: "acme-labs/site", path: "docs/any.md" })).toEqual([]);
  });

  it("finds a name in a path by the patterns only", () => {
    expect(pathNameHit(list, `docs/${PROBE}.md`)).toMatchObject({ name: 2, index: 5 });
    expect(pathNameHit(list, "src/acme-app/index.ts")).toMatchObject({ name: 1 });
    expect(pathNameHit(list, "docs/Acme notes.md")).toBeUndefined();
  });
});

describe("the private text core", () => {
  it("gives a break with no text and no name for a match", () => {
    const breaks = privateTextBreaks("notes.md", `clean\nthe ${PROBE} line\n`, { names: list });
    expect(breaks).toEqual([{ file: "notes.md", line: 2, message: named(2), fix: "Remove the text. The check does not show the text, because the name is private." }]);
    expect(JSON.stringify(breaks)).not.toContain(PROBE);
    expect(JSON.stringify(breaks)).not.toContain("probe");
    // One break for a line, at the first name of the line
    expect(privateTextBreaks("notes.md", `${PROBE} ${PROBE} acme-app`, { names: list }).map((item) => item.message)).toEqual([named(1)]);
  });

  it("uses the allow list with the repository and the path, and the patterns only for a path", () => {
    const text = `the ${PROBE} note`;
    expect(privateTextBreaks("a", text, { names: list }, { repo: "acme-labs/site", path: "docs/allowed.md" })).toEqual([]);
    expect(privateTextBreaks("a", text, { names: list }, { repo: "acme-labs/site", path: "docs/b.md" })).toHaveLength(1);
    expect(privateTextBreaks("a", "docs/the Acme team.md", { names: list }, { isPath: true })).toEqual([]);
    expect(privateTextBreaks("a", "docs/the Acme team.md", { names: list })).toHaveLength(1);
  });

  it("makes a pattern of the environment variable that is not a regular expression a break of its own, not an error", () => {
    const patterns = privatePatterns({ CONVENTIONS_PRIVATE_PATTERNS: `${PROBE}\n(qx-unclosed\n` });
    const invalid = invalidPatternBreaks(patterns);
    expect(invalid).toEqual([
      {
        file: "CONVENTIONS_PRIVATE_PATTERNS",
        line: 2,
        message: "Line 2 of CONVENTIONS_PRIVATE_PATTERNS is not a valid regular expression.",
        fix: "Correct the regular expression. The check does not show the pattern, because it is private.",
      },
    ]);
    expect(JSON.stringify(invalid)).not.toContain("qx-unclosed");
    // The valid patterns still count
    expect(privateTextBreaks("notes.md", PROBE, { patterns }).map((item) => item.line)).toEqual([1]);
  });

  it("reads the list and the environment variable together, and a break names the source", () => {
    const patterns = privatePatterns({ CONVENTIONS_PRIVATE_PATTERNS: "\n  qx-probe-other  \n" });
    expect(patterns).toEqual([{ source: "qx-probe-other", line: 2, label: "CONVENTIONS_PRIVATE_PATTERNS" }]);
    const messages = privateTextBreaks("a commit", `${PROBE} and qx-probe-other`, { names: list, patterns }).map((item) => item.message);
    expect(messages).toEqual([named(2), "A text matches the private pattern on line 2 of CONVENTIONS_PRIVATE_PATTERNS."]);
    expect(privatePatterns({})).toEqual([]);
  });

  it("reports the home folder of a user, and not an allowed name, with the first line of the text", () => {
    const home = ["", "home", "alice", "x"].join("/");
    const runner = ["", "home", "runner", "work"].join("/");
    const breaks = privateTextBreaks("notes.md", `${home}\n${runner}`, {}, { firstLine: 10 });
    expect(breaks).toEqual([{ file: "notes.md", line: 10, message: `The text "${["", "home", "alice"].join("/")}" is the home folder of a user.` }]);
    expect(privateTextBreaks("notes.md", home, {}, { allow: ["alice"] })).toEqual([]);
    expect(privateTextBreaks("notes.md", home, {}, { homes: false })).toEqual([]);
  });

  it("finds the path of the list in the environment, else in the git configuration", () => {
    const asked: (readonly string[])[] = [];
    const fake = (args: readonly string[]): string | undefined => {
      asked.push(args);
      return "/names/from-git.json\n";
    };
    expect(privateNamesFile({ CONVENTIONS_PRIVATE_NAMES_FILE: "/names/from-env.json" }, fake)).toBe("/names/from-env.json");
    expect(asked).toEqual([]);
    expect(privateNamesFile({}, fake)).toBe("/names/from-git.json");
    expect(asked).toEqual([["config", "--type=path", "--get", "conventions.privateNamesFile"]]);
    expect(privateNamesFile({ CONVENTIONS_PRIVATE_NAMES_FILE: " " }, () => undefined)).toBeUndefined();
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
  it("stops a push with a private name in a commit message, and does not show it", () => {
    const { root, base } = repository();
    const head = commit(root, { "notes.md": "2\n" }, `second\n\nthe ${PROBE} note`);
    const { code, stderr } = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain(`commit ${head.slice(0, 12)} message:3  ${named(2)}`);
    expect(stderr).toMatch(/^conventions pre-push: 1 commits, \d+ lines read, 1 breaks\. The push stops\./);
    expect(stderr).not.toContain(PROBE);
  });

  it("stops a push with a private name on an added line, with the line of the new file, and keeps the common word", () => {
    const { root, base } = repository();
    const head = commit(root, { "notes.md": `1\nAcme corp builds it.\nthe Acme team\nthe ${PROBE}\n` }, "second");
    const { code, stderr } = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain(`commit ${head.slice(0, 12)} notes.md:3  ${named(1)}`);
    expect(stderr).toContain(`commit ${head.slice(0, 12)} notes.md:4  ${named(2)}`);
    expect(stderr).toMatch(/ 2 breaks\. The push stops\./);
    expect(stderr).not.toContain(PROBE);
    expect(stderr).not.toContain("Acme");
  });

  it("stops a push with a private name in a path, and does not show the path", () => {
    const { root, base } = repository();
    const head = commit(root, { [`docs/${PROBE}.md`]: "clean\n" }, "second");
    const { code, stderr } = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain(`commit ${head.slice(0, 12)} path 1  The path names name 2 of the private name list.`);
    expect(stderr).not.toContain(PROBE);
  });

  it("permits the allowed file of the repository of the URL argument, in the https and ssh forms", () => {
    const { root, base } = repository();
    const head = commit(root, { "docs/allowed.md": `${PROBE}\n`, "docs/other.md": `${PROBE}\n` }, "second");
    const input = `refs/heads/main ${head} refs/heads/main ${base}\n`;
    for (const url of [HTTPS, SSH]) {
      const { code, stderr } = push(root, input, undefined, url);
      expect(code, url).toBe(1);
      expect(stderr).toContain(`commit ${head.slice(0, 12)} docs/other.md:1  ${named(2)}`);
      expect(stderr).not.toContain("docs/allowed.md");
      expect(stderr).toMatch(/ 1 breaks\. The push stops\./);
    }
    // The URL of another repository permits nothing
    expect(push(root, input, undefined, "https://github.com/acme-labs/other.git").stderr).toMatch(/ 2 breaks\. The push stops\./);
  });

  it("finds the repository with git remote get-url when the hook gives no URL", () => {
    const { root, base } = repository();
    const head = commit(root, { "docs/allowed.md": `${PROBE}\n` }, "second");
    const input = `refs/heads/main ${head} refs/heads/main ${base}\n`;
    // No remote: no repository, so the allow list permits nothing
    expect(push(root, input).code).toBe(1);
    git(root, "remote", "add", "origin", SSH);
    const { code, stderr } = push(root, input);
    expect(code).toBe(0);
    expect(stderr).toMatch(/^conventions pre-push: 1 commits, \d+ lines read, 0 breaks\.\n$/);
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
    // The remote has a commit with the probe. The push does not change that commit, so the gate does not read it
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

  it("writes the No read line and does not stop the push when no list and no pattern is set", () => {
    const { root, base } = repository();
    const head = commit(root, { "notes.md": `${PROBE}\n` }, "second");
    const { code, stderr } = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`, {});
    expect(code).toBe(0);
    expect(stderr).toBe(`${NO_READ_LINE}\n`);
    expect(stderr).toBe("conventions pre-push: No read: no private name list. Set CONVENTIONS_PRIVATE_NAMES_FILE or the git config conventions.privateNamesFile.\n");
  });

  it("reads the patterns of the environment variable with no list", () => {
    const { root, base } = repository();
    const head = commit(root, { "notes.md": `${PROBE}\n` }, "second");
    const { code, stderr } = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`, { CONVENTIONS_PRIVATE_PATTERNS: PROBE });
    expect(code).toBe(1);
    expect(stderr).toContain(`commit ${head.slice(0, 12)} notes.md:1  A text matches the private pattern on line 1 of CONVENTIONS_PRIVATE_PATTERNS.`);
    expect(stderr).not.toContain(PROBE);
  });

  it("reads the list of the git configuration", () => {
    const { root, base } = repository();
    git(root, "config", "conventions.privateNamesFile", listFile());
    const head = commit(root, { "notes.md": `${PROBE}\n` }, "second");
    expect(push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`, {}).code).toBe(1);
  });

  it("stops the push when the list that the settings name does not exist", () => {
    const { root, base } = repository();
    const head = commit(root, { "notes.md": "2\n" }, "second");
    const { code, stderr } = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`, { CONVENTIONS_PRIVATE_NAMES_FILE: join(temp, "missing.json") });
    expect(code).toBe(1);
    expect(stderr).toBe("conventions pre-push: Cannot read the private name list that CONVENTIONS_PRIVATE_NAMES_FILE names: the file does not exist. Correct the setting or the file. The push stops.\n");
  });

  it("stops the push when the list of the git configuration does not exist, or is a folder", () => {
    const { root, base } = repository();
    const head = commit(root, { "notes.md": "2\n" }, "second");
    git(root, "config", "conventions.privateNamesFile", join(temp, "missing-too.json"));
    const missing = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`, {});
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("that the git config conventions.privateNamesFile names: the file does not exist.");
    git(root, "config", "conventions.privateNamesFile", temp);
    const folder = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`, {});
    expect(folder.code).toBe(1);
    expect(folder.stderr).toContain("names: the path is a folder.");
  });

  it("stops the push on a list that is not JSON, breaks the schema or has a bad regular expression, with the reason", () => {
    const { root, base } = repository();
    const head = commit(root, { "notes.md": "2\n" }, "second");
    const input = `refs/heads/main ${head} refs/heads/main ${base}\n`;
    const rule = LIST.names[1];
    const cases: [string, string][] = [
      [`${PROBE} is not JSON`, "the text is not valid JSON"],
      [JSON.stringify({ names: [{ ...rule, seeds: PROBE }] }), "name 1 of the private name list: the field seeds is not a list of one or more texts"],
      [JSON.stringify({ names: [{ ...rule, patterns: [`(${PROBE}`] }] }), "name 1 of the private name list: pattern 1 is not a valid regular expression"],
    ];
    for (const [text, reason] of cases) {
      const { code, stderr } = push(root, input, { CONVENTIONS_PRIVATE_NAMES_FILE: listFile(text) });
      expect(code).toBe(1);
      expect(stderr).toBe(`conventions pre-push: The private name list that CONVENTIONS_PRIVATE_NAMES_FILE names is not valid: ${reason}. Correct the file. The push stops.\n`);
      expect(stderr).not.toContain(PROBE);
    }
  });

  it("stops the push on a pattern of the environment variable that is not valid, and keeps the home folder exceptions of package.json", () => {
    const { root, base } = repository();
    const home = ["", "home", "alice", "x"].join("/");
    const conventions = { rules: { "no-local-paths": { ignore: ["fixtures/**"], reason: "test fixtures" } } };
    const head = commit(root, { "package.json": `${JSON.stringify({ name: "one", conventions })}\n`, "fixtures/a.txt": `${home}\n` }, "second");
    const clean = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(clean.code).toBe(0);
    const { code, stderr } = push(root, `refs/heads/main ${head} refs/heads/main ${base}\n`, { CONVENTIONS_PRIVATE_NAMES_FILE: listFile(), CONVENTIONS_PRIVATE_PATTERNS: `${PROBE}\n(qx-unclosed\n` });
    expect(code).toBe(1);
    expect(stderr).toContain("CONVENTIONS_PRIVATE_PATTERNS:2  Line 2 of CONVENTIONS_PRIVATE_PATTERNS is not a valid regular expression.");
    expect(stderr).not.toContain("qx-unclosed");
  });

  it("starts from the bin with the standard input and the URL, and gives exit code 2 without a remote", () => {
    const { root, base } = repository();
    const head = commit(root, { "docs/allowed.md": `${PROBE}\n` }, "second");
    let stderr = "";
    const stdin = `refs/heads/main ${head} refs/heads/main ${base}\n`;
    const io: CliIo = { cwd: root, env: { CONVENTIONS_PRIVATE_NAMES_FILE: join(temp, "missing.json") }, stdout: () => undefined, stderr: (text) => (stderr += text), stdin };
    expect(runCli(["pre-push", "origin", HTTPS], io)).toBe(1);
    expect(stderr).toMatch(/Cannot read the private name list/);
    expect(runCli(["pre-push"], io)).toBe(2);
    // The second argument of the hook is the URL, so the allow list permits the file
    const listed: CliIo = { ...io, env: { CONVENTIONS_PRIVATE_NAMES_FILE: listFile() } };
    expect(runCli(["pre-push", "origin", HTTPS], listed)).toBe(0);
    expect(runCli(["pre-push", "origin", "https://github.com/acme-labs/other.git"], listed)).toBe(1);
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
