// Each rule on fixture repositories: a case that passes and a case that breaks.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { blockHash, sharedDocsRule, type HomeFetch } from "./rules/shared-docs.ts";
import { lockedVersions, minorOf, publishedMinorRule, reachOf } from "./rules/published-minor.ts";
import type { RegistryLookup } from "./rules/unreleased-change.ts";
import { authorOf, convertGate, declaredName, hasTests, HOMES, mitText, pagesCalls, signaturesOf, isGitSpecifier, isPinned, isSourcePath, parseJsonc, prPathFilters, repositoryOfRemote, roadmapOfLine, runChecks, runFix, scheduleMinute, summaryName, unreleasedChangeRule, type CheckOptions, type RegistryAnswer, type RuleResult } from "./index.ts";
import { API_REPORT_RANGE } from "./rules/api-report-script.ts";
import { minuteField } from "./rules/runner-budget.ts";
import { runsOnMain, startsOnPush } from "./rules/main-runs-finish.ts";
import { localBase, runCli } from "./run.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-rules-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** This function writes the files of a fixture repository, and gives its root. */
function fixture(files: Record<string, unknown>): string {
  const root = join(temp, String(fixtures++));
  mkdirSync(root, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof text === "string" ? text : `${JSON.stringify(text, null, 2)}\n`);
  }
  return root;
}

/** This function starts git in `root`, and gives its output. */
function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** This function makes `root` a git repository with one commit of each file. */
function commitAll(root: string, message = "first"): void {
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

/** This function starts one rule on `root`, and gives its result. */
function rule(root: string, id: string, options: Omit<CheckOptions, "root" | "only"> = {}): RuleResult {
  const result = runChecks({ root, only: [id], ...options }).rules[0];
  if (result === undefined) throw new Error(`no result for ${id}`);
  return result;
}

/** A workspace with the packages `packages`. */
const workspace = (rootManifest: Record<string, unknown>, packages: Record<string, unknown> = {}): string =>
  fixture({ "package.json": { name: "root", private: true, ...rootManifest }, "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n', ...packages });

describe("pinned-git-deps", () => {
  it("knows the forms of a git specifier", () => {
    for (const spec of ["github:a/b", "git+https://github.com/a/b.git", "git+ssh://git@github.com/a/b.git", "git@github.com:a/b.git", "a/b", "a/b#main", "https://github.com/a/b/tarball/main"]) {
      expect(isGitSpecifier(spec), spec).toBe(true);
    }
    for (const spec of ["^1.2.3", "workspace:*", "npm:@a/b@1", "file:../b", "link:../b", "@a/b", "latest", "catalog:", "https://registry.example.com/b.tgz"]) {
      expect(isGitSpecifier(spec), spec).toBe(false);
    }
  });

  it("knows a commit SHA after # or in a tarball path", () => {
    expect(isPinned(`github:a/b#${SHA}`, true)).toBe(true);
    expect(isPinned(`github:a/b#commit=${SHA}`, true)).toBe(true);
    expect(isPinned(`https://codeload.github.com/a/b/tar.gz/${SHA}`, true)).toBe(true);
    expect(isPinned("github:a/b#main", true)).toBe(false);
    expect(isPinned("github:a/b#v1.2.3", true)).toBe(false);
    expect(isPinned("github:a/b#0123abc", true)).toBe(false);
    expect(isPinned("github:a/b#0123abc", false)).toBe(true);
    expect(isPinned("github:a/b", true)).toBe(false);
  });

  it("reports each git dependency without a commit, with its file and line", () => {
    const root = workspace(
      { devDependencies: { pinned: `github:a/pinned#${SHA}`, loose: "github:a/loose", npm: "^1.0.0" }, pnpm: { overrides: { over: "git+https://github.com/a/over.git" } } },
      { "packages/a/package.json": { name: "a", main: "./src/index.ts", dependencies: { short: "a/short#main" } } },
    );
    const result = rule(root, "pinned-git-deps");
    expect(result.status).toBe("break");
    expect(result.breaks.map((item) => [item.file, item.line])).toEqual([
      ["package.json", 6],
      ["package.json", 11],
      ["packages/a/package.json", 5],
    ]);
    expect(result.breaks[0]?.message).toMatch(/"loose" is "github:a\/loose"/);
  });

  it("accepts a short SHA when the option fullSha is false", () => {
    const root = workspace({ devDependencies: { x: "github:a/x#0123abc" }, conventions: { rules: { "pinned-git-deps": { fullSha: false, reason: "a short SHA is enough here" } } } });
    expect(rule(root, "pinned-git-deps").status).toBe("pass");
  });
});

describe("workspace-protocol", () => {
  const packages = (spec: string): Record<string, unknown> => ({
    "packages/a/package.json": { name: "a", main: "./src/index.ts" },
    "packages/b/package.json": { name: "b", main: "./src/index.ts", dependencies: { a: spec }, peerDependencies: { a: "^1.0.0" } },
  });

  it("reports a range of a package of the workspace, and not a peer dependency", () => {
    const result = rule(workspace({}, packages("^1.0.0")), "workspace-protocol");
    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]).toMatchObject({ file: "packages/b/package.json", line: 5 });
  });

  it("accepts workspace:, and the option prefix makes it stricter", () => {
    expect(rule(workspace({}, packages("workspace:^")), "workspace-protocol").status).toBe("pass");
    const strict = workspace({ conventions: { rules: { "workspace-protocol": { prefix: "workspace:*", reason: "each dependency is exact" } } } }, packages("workspace:^"));
    expect(rule(strict, "workspace-protocol").status).toBe("break");
  });
});

describe("source-main", () => {
  const published = { main: "./build/index.js", types: "./build/index.d.ts", bin: { x: "./build/cli.js" } };

  it("accepts a source package, a private package and a CLI package", () => {
    const root = workspace(
      {},
      {
        "packages/a/package.json": { name: "a", main: "./src/index.ts", bin: { x: "./src/cli.ts" }, publishConfig: published },
        "packages/b/package.json": { name: "b", private: true, main: "src/index.ts", types: "src/index.ts" },
        "packages/c/package.json": { name: "c", bin: { c: "./src/index.ts" }, publishConfig: { bin: { c: "./build/index.js" } } },
        "packages/site/package.json": { name: "site", private: true, scripts: { build: "astro build" } },
      },
    );
    expect(rule(root, "source-main")).toMatchObject({ status: "pass" });
  });

  it("reports a main that is not the source, a package with no main, and a public package with source entries", () => {
    const root = workspace(
      {},
      {
        "packages/a/package.json": { name: "a", main: "./build/index.js" },
        "packages/b/package.json": { name: "b", exports: { ".": "./build/index.js" } },
        "packages/c/package.json": { name: "c", main: "./src/index.ts", types: "./src/index.ts", publishConfig: { main: "./src/index.ts" } },
      },
    );
    const messages = rule(root, "source-main").breaks.map((item) => `${item.file}: ${item.message}`);
    expect(messages).toEqual([
      'packages/a/package.json: "main" is "./build/index.js", not "./src/index.ts".',
      'packages/b/package.json: The package has no "main". A source package has "main": "./src/index.ts".',
      "packages/c/package.json: publishConfig.main points at the source (./src/index.ts).",
      'packages/c/package.json: "types" points at the source (./src/index.ts), and publishConfig has no "types": npm users get the source.',
    ]);
  });

  it("examines only the publishConfig of a repository of one package, and knows a source path", () => {
    expect(rule(fixture({ "package.json": { name: "one", main: "build/index.js" } }), "source-main").status).toBe("pass");
    expect(rule(fixture({ "package.json": { name: "one", main: "./src/index.ts" } }), "source-main").breaks.map((item) => item.file)).toEqual(["package.json"]);
    expect(isSourcePath("./src/x.css")).toBe(true);
    expect(isSourcePath("./lib/x.mts")).toBe(true);
    expect(isSourcePath("./build/x.d.ts")).toBe(false);
    expect(isSourcePath("./build/x.js")).toBe(false);
  });
});

describe("tsconfig-test", () => {
  it("reports a package with no tsconfig.test.json and a typecheck that does not examine it", () => {
    const root = workspace(
      {},
      {
        "packages/a/package.json": { name: "a", scripts: { typecheck: "tsc -p tsconfig.json && tsc -p tsconfig.test.json" } },
        "packages/a/tsconfig.json": {},
        "packages/a/tsconfig.test.json": {},
        "packages/b/package.json": { name: "b" },
        "packages/b/tsconfig.json": {},
        "packages/c/package.json": { name: "c", scripts: { typecheck: "tsc --noEmit" } },
        "packages/c/tsconfig.json": {},
        "packages/c/tsconfig.test.json": {},
        "packages/d/package.json": { name: "d" },
      },
    );
    const result = rule(root, "tsconfig-test");
    expect(result.breaks.map((item) => item.file)).toEqual(["packages/b/tsconfig.test.json", "packages/c/package.json"]);
    expect(result.breaks[1]?.message).toMatch(/does not examine tsconfig\.test\.json/);
  });

  it("skips a package with no test file in git, and knows the forms of a test file", () => {
    const root = fixture({ "package.json": { name: "one" }, "tsconfig.json": {}, "src/index.ts": "export {};\n" });
    commitAll(root);
    expect(rule(root, "tsconfig-test").status).toBe("pass");
    expect(hasTests(["packages/a/src/x.test.ts"], "packages/a")).toBe(true);
    expect(hasTests(["src/__tests__/x.ts", "README.md"], "")).toBe(true);
    expect(hasTests(["test/x.spec.mjs"], "")).toBe(true);
    expect(hasTests(["packages/b/src/x.test.ts", "packages/a/src/x.ts"], "packages/a")).toBe(false);
    expect(hasTests(["test/api/public-api.txt"], "")).toBe(false);
  });

  it("finds a test file as the old regular expression did, in linear time", () => {
    const old = /(?:^|\/)(?:[^/]+\.(?:test|spec)\.[cm]?[jt]sx?|__tests__\/.+)$/;
    const paths = ["x.test.ts", "a/b.spec.mjs", "a/.test.ts", ".test.ts", "x.test.tsx", "x.test.cjs", "x.tests.ts", "x.test.py", "__tests__/a", "a/__tests__/b/c.md", "__tests__", "a/__tests__/", "x.test.ts/", "a/b.spec.jsx", "test.ts", "x.Test.ts"];
    for (const path of paths) expect(hasTests([path], ""), path).toBe(old.test(path));
    const start = performance.now();
    expect(hasTests([`${"/".repeat(100_000)}x.test.tss`, `${"a.".repeat(100_000)}`], "")).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("examines the root of a repository of one package", () => {
    const root = fixture({ "package.json": { name: "one" }, "pnpm-workspace.yaml": "allowBuilds: {}\n", "tsconfig.json": {} });
    expect(rule(root, "tsconfig-test").breaks.map((item) => item.file)).toEqual(["tsconfig.test.json"]);
    expect(rule(root, "cue-preset").breaks.map((item) => item.file)).toEqual(["tsconfig.json"]);
  });
});

describe("cue-preset", () => {
  const preset = { compilerOptions: { strict: true, noUncheckedIndexedAccess: true, erasableSyntaxOnly: true, exactOptionalPropertyTypes: false } };

  it("accepts a package that extends a preset, and an option that the preset also turns off", () => {
    const root = workspace(
      {},
      {
        "node_modules/@mark1russell7/cue/package.json": { name: "@mark1russell7/cue" },
        "node_modules/@mark1russell7/cue/ts/config/node.json": preset,
        "packages/a/package.json": { name: "a" },
        "packages/a/tsconfig.json": '{\n  // a comment\n  "extends": "@mark1russell7/cue/ts/config/node.json",\n  "compilerOptions": { "exactOptionalPropertyTypes": false, },\n}\n',
        "packages/a/tsconfig.test.json": { extends: "./tsconfig.json", compilerOptions: { noEmit: true } },
      },
    );
    expect(rule(root, "cue-preset").status).toBe("pass");
  });

  it("reports a config by hand and a strict option turned off", () => {
    const root = workspace(
      {},
      {
        "node_modules/@mark1russell7/cue/package.json": { name: "@mark1russell7/cue" },
        "node_modules/@mark1russell7/cue/ts/config/node.json": preset,
        "packages/a/package.json": { name: "a" },
        "packages/a/tsconfig.json": { compilerOptions: { strict: true } },
        "packages/b/package.json": { name: "b" },
        "packages/b/tsconfig.json": { extends: "@mark1russell7/cue/ts/config/node.json" },
        "packages/b/tsconfig.test.json": { extends: "./tsconfig.json", compilerOptions: { strictNullChecks: false, noUncheckedIndexedAccess: false, erasableSyntaxOnly: false } },
      },
    );
    expect(rule(root, "cue-preset").breaks.map((item) => `${item.file}: ${item.message}`)).toEqual([
      "packages/a/tsconfig.json: tsconfig.json does not extend a preset of @mark1russell7/cue.",
      "packages/b/tsconfig.test.json: tsconfig.test.json turns off the strict option strictNullChecks.",
      "packages/b/tsconfig.test.json: tsconfig.test.json turns off the strict option noUncheckedIndexedAccess.",
      "packages/b/tsconfig.test.json: tsconfig.test.json turns off the strict option erasableSyntaxOnly.",
    ]);
  });

  it("does not examine extends when the option extends is false, and still reports a strict option turned off", () => {
    const root = workspace(
      { conventions: { rules: { "cue-preset": { extends: false, reason: "the package publishes its own presets" } } } },
      {
        "packages/a/package.json": { name: "a" },
        "packages/a/tsconfig.json": { extends: "./tsconfig/lib.json", compilerOptions: { strict: false } },
      },
    );
    expect(rule(root, "cue-preset").breaks.map((item) => item.message)).toEqual(["tsconfig.json turns off the strict option strict."]);
  });

  it("reads JSON with comments and commas at the end", () => {
    expect(parseJsonc('{ "a": "x // y", /* c */ "b": [1, 2,], }')).toEqual({ a: "x // y", b: [1, 2] });
  });
});

describe("required-scripts", () => {
  it("reports each missing script, and the option scripts sets the list", () => {
    const result = rule(workspace({ scripts: { "lint:ste": "ste-lint" } }), "required-scripts");
    expect(result.breaks).toEqual([
      expect.objectContaining({ message: 'The root package.json has no script "typecheck".', fix: 'Add the script, for example "typecheck": "pnpm -r run typecheck".' }),
    ]);
    const custom = workspace({ scripts: { test: "vitest" }, conventions: { rules: { "required-scripts": { scripts: ["test"], reason: "this repository has no TypeScript" } } } });
    expect(rule(custom, "required-scripts").status).toBe("pass");
    const unknown = workspace({ conventions: { rules: { "required-scripts": { scripts: ["test"], reason: "the tests are the gate" } } } });
    expect(rule(unknown, "required-scripts").breaks.map((item) => item.fix)).toEqual(['Add the script "test".']);
  });

  it("asks for lint:ste only when the repository uses ste-lint", () => {
    expect(rule(workspace({ scripts: { typecheck: "tsc" } }), "required-scripts").status).toBe("pass");
    const steBreak = {
      message: 'The root package.json has no script "lint:ste". The repository uses ste-lint.',
      fix: 'Add the script, for example "lint:ste": "ste-lint".',
    };
    const dependency = workspace({ scripts: { typecheck: "tsc" }, devDependencies: { "@mark1russell7/ste-lint": "^0.1.1" } });
    expect(rule(dependency, "required-scripts").breaks).toEqual([expect.objectContaining(steBreak)]);
    const config = fixture({ "package.json": { name: "one", scripts: { typecheck: "tsc" } }, "ste.config.json": {} });
    expect(rule(config, "required-scripts").breaks).toEqual([expect.objectContaining(steBreak)]);
    const both = workspace({ scripts: { typecheck: "tsc", "lint:ste": "ste-lint" }, devDependencies: { "@mark1russell7/ste-lint": "^0.1.1" } });
    expect(rule(both, "required-scripts").status).toBe("pass");
  });
});

describe("no-build-output", () => {
  it("reports each folder of build output that git keeps, and skips a folder that is not git", () => {
    const files = { "package.json": { name: "one" }, "packages/a/dist/index.js": "", "packages/a/dist/index.d.ts": "", "build/x.js": "", "src/builder/x.ts": "" };
    expect(rule(fixture(files), "no-build-output").status).toBe("skipped");
    const root = fixture(files);
    commitAll(root);
    expect(rule(root, "no-build-output").breaks.map((item) => item.message)).toEqual(["Git keeps 1 file(s) in build/.", "Git keeps 2 file(s) in packages/a/dist/."]);
  });

  it("is off with a reason in the configuration", () => {
    const root = fixture({ "package.json": { name: "one", conventions: { rules: { "no-build-output": { off: "git installs need dist" } } } }, "dist/x.js": "" });
    commitAll(root);
    expect(rule(root, "no-build-output")).toMatchObject({ status: "off", note: "git installs need dist" });
  });
});

describe("no-local-paths", () => {
  const windows = ["C:", "Users", "alice", "repo"].join("\\");
  const linux = ["", "home", "bob", "x"].join("/");

  it("reports a home folder of a user, and not a placeholder or a CI user", () => {
    const root = fixture({
      "package.json": { name: "one" },
      "notes.md": `one ${windows}\ntwo ${linux}\nthree ${["C:", "Users", "<you>"].join("\\")} ${["", "home", "u"].join("/")} and ${["", "home", "runner", "work"].join("/")}\nfour https://example.com${linux}\n`,
      "data.json": JSON.stringify({ path: windows }),
      "image.png": windows,
    });
    commitAll(root);
    const result = rule(root, "no-local-paths");
    expect(result.breaks.map((item) => `${item.file}:${item.line ?? 0}`)).toEqual(["data.json:1", "notes.md:1", "notes.md:2"]);
  });

  it("knows a Windows path in lower case, and not a home folder in the reason of an exception", () => {
    const root = fixture({
      "package.json": { name: "one", conventions: { rules: { "no-local-paths": { ignore: ["fixtures/**"], reason: `fixtures such as ${linux}`, patterns: ["secret-project"] } } } },
      "notes.md": `${["c:", "users", "alice", "repo"].join("/")}\n`,
      "fixtures/a.txt": linux,
    });
    commitAll(root);
    expect(rule(root, "no-local-paths").breaks.map((item) => `${item.file}:${item.line ?? 0}`)).toEqual(["notes.md:1"]);
  });

  it("takes more allowed names and more patterns", () => {
    const root = fixture({
      "package.json": { name: "one", conventions: { rules: { "no-local-paths": { allow: ["bob"], patterns: ["secret-project"], reason: "bob is a test user" } } } },
      "notes.md": `${linux}\nthe secret-project\n`,
    });
    commitAll(root);
    expect(rule(root, "no-local-paths").breaks.map((item) => `${item.file}: ${item.message}`)).toEqual(['notes.md: The text "secret-project" matches the pattern secret-project.']);
    const env = { CONVENTIONS_PRIVATE_PATTERNS: "\nthe secret\n" };
    expect(rule(root, "no-local-paths", { env }).breaks.map((item) => item.message)).toEqual([
      'The text "secret-project" matches the pattern secret-project.',
      'The text "the secret" matches the pattern the secret.',
    ]);
  });
});

describe("release-files", () => {
  /** A repository with a first commit, and a second commit that changes `file` with `message`. */
  function changed(file: string, message: string, author = "test"): string {
    const root = fixture({ "package.json": { name: "one" }, "scripts/release/x.mjs": "1\n", "README.md": "1\n" });
    commitAll(root);
    git(root, "tag", "base");
    writeFileSync(join(root, file), "2\n");
    git(root, "-c", `user.name=${author}`, "commit", "-q", "-am", message);
    return root;
  }

  it("skips when there is no base", () => {
    expect(rule(changed("scripts/release/x.mjs", "change"), "release-files").status).toBe("skipped");
  });

  it("reports a change of a release file with no reason", () => {
    const result = rule(changed("scripts/release/x.mjs", "change"), "release-files", { base: "base" });
    expect(result.breaks.map((item) => item.file)).toEqual(["scripts/release/x.mjs"]);
  });

  it("accepts a change with the line Release-Edit in a commit or in the body of the pull request", () => {
    expect(rule(changed("scripts/release/x.mjs", "change\n\nRelease-Edit: the owner asked for it"), "release-files", { base: "base" }).status).toBe("pass");
    expect(rule(changed("README.md", "docs"), "release-files", { base: "base" }).status).toBe("pass");
    expect(rule(changed("scripts/release/x.mjs", "sync", "mark1russell7-release-train[bot]"), "release-files", { base: "base" }).status).toBe("pass");
    const root = changed("scripts/release/x.mjs", "change");
    const event = join(root, "..", `event-${fixtures++}.json`);
    writeFileSync(event, JSON.stringify({ pull_request: { body: "Text\n\nRelease-Edit: the release session asked for it\n" } }));
    expect(rule(root, "release-files", { base: "base", env: { GITHUB_EVENT_PATH: event } }).status).toBe("pass");
  });

  it("finds the base in the merge commit of a pull request", () => {
    const root = changed("scripts/release/x.mjs", "change");
    git(root, "switch", "-q", "-c", "pr");
    git(root, "switch", "-q", "--detach", "base");
    writeFileSync(join(root, "README.md"), "other\n");
    git(root, "commit", "-q", "-am", "main moves");
    git(root, "merge", "-q", "--no-ff", "-m", "merge", "pr");
    const result = rule(root, "release-files", { env: { GITHUB_EVENT_NAME: "pull_request" } });
    expect(result.breaks.map((item) => item.file)).toEqual(["scripts/release/x.mjs"]);
  });

  it("does not trust a shallow checkout that ends inside the change, and passes when the checkout has the merge base", () => {
    /** A pull request with the commits `commits` (an author and a file each), as the merge commit of a checkout with depth 2. */
    function shallow(commits: readonly (readonly [string, string])[], mergeMain: boolean): string {
      const root = fixture({ "package.json": { name: "one" }, "scripts/release/x.mjs": "1\n", "README.md": "1\n" });
      commitAll(root);
      git(root, "switch", "-q", "-c", "pr");
      commits.forEach(([author, file], index) => {
        writeFileSync(join(root, file), `pr ${String(index)}\n`);
        git(root, "-c", `user.name=${author}`, "commit", "-q", "-am", `pr ${String(index)}`);
      });
      git(root, "switch", "-q", "main");
      writeFileSync(join(root, "other.md"), "1\n");
      git(root, "add", "other.md");
      git(root, "commit", "-q", "-m", "main moves");
      if (mergeMain) {
        git(root, "switch", "-q", "pr");
        git(root, "merge", "-q", "--no-ff", "-m", "merge main", "main");
        git(root, "switch", "-q", "main");
        writeFileSync(join(root, "other.md"), "2\n");
        git(root, "commit", "-q", "-am", "main moves again");
      }
      git(root, "switch", "-q", "-c", "checkout");
      git(root, "merge", "-q", "--no-ff", "-m", "merge pr", "pr");
      const clone = join(temp, String(fixtures++));
      git(temp, "clone", "-q", "--depth", "2", "--branch", "checkout", pathToFileURL(root).href, clone);
      return clone;
    }
    const bot = "mark1russell7-release-train[bot]";
    const env = (commits: number): Record<string, string> => {
      const event = join(temp, `event-${String(fixtures++)}.json`);
      writeFileSync(event, JSON.stringify({ pull_request: { body: "", commits } }));
      return { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event };
    };
    // A person changes a release file, and the train adds a commit on top: the end of the checkout hides the person
    const hidden = rule(shallow([["a person", "scripts/release/x.mjs"], [bot, "README.md"]], false), "release-files", { env: env(2) });
    expect(hidden.status).toBe("error");
    expect(hidden.note).toMatch(/does not have the merge base of HEAD\^1 and HEAD\^2/);
    // The train changes a release file, and a person takes main in a merge: the commit of the train is under the end
    const merged = shallow([[bot, "scripts/release/x.mjs"]], true);
    expect(rule(merged, "release-files", { env: env(2) }).status).toBe("error");
    git(merged, "fetch", "-q", "--unshallow", "origin");
    expect(rule(merged, "release-files", { env: env(2) }).status).toBe("pass");
    // A pull request of one commit is the whole change at depth 2
    expect(rule(shallow([[bot, "scripts/release/x.mjs"]], false), "release-files", { env: env(1) }).status).toBe("pass");
    expect(rule(shallow([["a person", "scripts/release/x.mjs"]], false), "release-files", { env: env(1) }).breaks.map((item) => item.file)).toEqual(["scripts/release/x.mjs"]);
  });
});

describe("typed-scripts", () => {
  it("reports JavaScript source and shell scripts with logic, and not a launcher of one line", () => {
    const root = fixture({
      "package.json": { name: "one" },
      "scripts/a.mjs": "export {};\n",
      "scripts/b.cjs": "module.exports = 1;\n",
      "src/c.js": "1;\n",
      "src/d.ts": "export const d = 1;\n",
      "bin/run": "#!/usr/bin/env node\nconsole.log(1);\n",
      "bin/notes": "plain text\n",
      "go.sh": "#!/bin/sh\n# start the script\n\nnode scripts/go.ts \"$@\"\n",
      "build.sh": "#!/usr/bin/env bash\nset -e\npnpm build\n",
      "tools/x.ps1": "$a = 1\n$b = 2\n",
    });
    expect(rule(root, "typed-scripts").status).toBe("skipped");
    commitAll(root);
    expect(rule(root, "typed-scripts").breaks.map((item) => item.file)).toEqual(["bin/run", "build.sh", "scripts/a.mjs", "scripts/b.cjs", "src/c.js", "tools/x.ps1"]);
  });

  it("keeps a file of ignore with a reason, and takes a higher shell limit", () => {
    const root = fixture({
      "package.json": {
        name: "one",
        conventions: { rules: { "typed-scripts": { ignore: [".dependency-cruiser.mjs"], reason: "dependency-cruiser reads its configuration only as JavaScript", shellLines: 2 } } },
      },
      ".dependency-cruiser.mjs": "export default {};\n",
      "build.sh": "set -e\npnpm build\n",
    });
    commitAll(root);
    expect(rule(root, "typed-scripts").breaks).toEqual([]);
  });

  it("counts only the lines of code of a shell script", async () => {
    const { codeLines } = await import("./rules/typed-scripts.ts");
    expect(codeLines("#!/bin/sh\n\n# a comment\n  # another\nnode x.ts\r\n")).toBe(1);
  });
});

describe("typed-files", () => {
  it("reports each TypeScript file that no tsconfig of a typecheck holds, and not a declaration file", () => {
    const root = fixture({
      "package.json": { name: "one", scripts: { typecheck: "tsc -p tsconfig.json" } },
      "tsconfig.json": { compilerOptions: { noEmit: true }, include: ["src"] },
      "src/a.ts": "export const a = 1;\n",
      "scripts/b.ts": "export const b = 1;\n",
      "vitest.config.ts": "export default {};\n",
      "types/c.d.ts": "export declare const c: number;\n",
    });
    expect(rule(root, "typed-files").status).toBe("skipped");
    commitAll(root);
    expect(rule(root, "typed-files").breaks.map((item) => item.file)).toEqual(["scripts/b.ts", "vitest.config.ts"]);
  });

  it("follows the references of a config, and counts a file that a covered file imports", () => {
    const root = fixture({
      "package.json": { name: "one", scripts: { typecheck: "tsc -b" } },
      "tsconfig.json": { files: [], references: [{ path: "./tsconfig.test.json" }] },
      "tsconfig.test.json": { compilerOptions: { noEmit: true, allowImportingTsExtensions: true, module: "nodenext" }, include: ["src", "*.config.ts"] },
      "src/a.ts": 'export { b } from "../lib/b.ts";\n',
      "lib/b.ts": "export const b = 1;\n",
      "vitest.config.ts": "export default {};\n",
    });
    commitAll(root);
    expect(rule(root, "typed-files").breaks).toEqual([]);
  });

  it("fails closed: a typecheck that names a missing config, and a repository with no typecheck", () => {
    const missing = fixture({ "package.json": { name: "one", scripts: { typecheck: "tsc -p tsconfig.test.json" } }, "src/a.ts": "export {};\n" });
    commitAll(missing);
    const breaks = rule(missing, "typed-files").breaks;
    expect(breaks[0]?.message).toMatch(/names tsconfig\.test\.json, and that file does not exist/);
    expect(breaks.map((item) => item.file)).toContain("src/a.ts");
    const none = fixture({ "package.json": { name: "one" }, "src/a.ts": "export {};\n" });
    commitAll(none);
    expect(rule(none, "typed-files").breaks.map((item) => item.message)).toEqual([expect.stringMatching(/No typecheck script names a tsconfig/), "src/a.ts is in no tsconfig that a typecheck script examines."]);
  });

  it("follows the scripts that a typecheck starts in the same package, and not those of other packages", async () => {
    const { scriptsOf } = await import("./index.ts");
    const scripts = { typecheck: "pnpm -r run typecheck && pnpm run typecheck:scripts", "typecheck:scripts": "tsc -p tsconfig.scripts.json && npm run loop", loop: "pnpm typecheck" };
    expect(scriptsOf(scripts, "typecheck")).toEqual([scripts.typecheck, scripts["typecheck:scripts"], scripts.loop]);
    expect(scriptsOf(scripts, "missing")).toEqual([]);
  });

  it("reads the configs of a typecheck script", async () => {
    const { configsOfScript } = await import("./index.ts");
    expect(configsOfScript("tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json")).toEqual(["tsconfig.json", "tsconfig.test.json"]);
    expect(configsOfScript("tsc --noEmit")).toEqual(["tsconfig.json"]);
    expect(configsOfScript("tsc --project=e2e/tsconfig.json; vue-tsc -b a b --verbose")).toEqual(["e2e/tsconfig.json", "a", "b"]);
    expect(configsOfScript("node_modules/.bin/tsgo -p x.json")).toEqual(["x.json"]);
    expect(configsOfScript("svelte-check --tsconfig ./tsconfig.json")).toEqual(["./tsconfig.json"]);
    expect(configsOfScript("pnpm -r typecheck")).toEqual([]);
    expect(configsOfScript("tsc-alias && echo tsconfig")).toEqual([]);
  });
});

describe("tests-required", () => {
  it("reports passWithNoTests in a config and in a script, and not the option set to false", () => {
    const root = fixture({
      "package.json": { name: "one", scripts: { test: "vitest run --passWithNoTests" } },
      "packages/a/vitest.config.ts": "export default { test: { passWithNoTests: true } };\n",
      "packages/b/vitest.config.ts": "export default { test: { passWithNoTests: false } };\n",
      "packages/c/playwright.e2e.config.ts": "export default {};\n",
      "notes.md": "passWithNoTests: true\n",
    });
    expect(rule(root, "tests-required").status).toBe("skipped");
    commitAll(root);
    expect(rule(root, "tests-required").breaks.map((item) => `${item.file}:${String(item.line)}`)).toEqual(["package.json:4", "packages/a/vitest.config.ts:1"]);
  });
});

describe("roadmap-parses", () => {
  const roadmap = "# Roadmap\n\n| ID | Item | Status |\n| --- | --- | --- |\n| a1 | First | done |\n";
  const pages = "jobs:\n  pages:\n    uses: o/template/.github/workflows/reusable-pages.yml@0123abc\n    with:\n      roadmap: docs/ROADMAP.md # the Status page\n";

  it("passes a roadmap that a workflow names and that parses, and skips with no named roadmap", () => {
    const root = fixture({ "package.json": { name: "one" }, ".github/workflows/pages.yml": pages, "docs/ROADMAP.md": roadmap });
    commitAll(root);
    expect(rule(root, "roadmap-parses").breaks).toEqual([]);
    const none = fixture({ "package.json": { name: "one" }, ".github/workflows/ci.yml": "jobs:\n  a:\n    with:\n      roadmap: ${{ inputs.roadmap }}\n", "docs/ROADMAP.md": roadmap });
    commitAll(none);
    expect(rule(none, "roadmap-parses").status).toBe("skipped");
  });

  it("reports a bad row, a roadmap with no item and a missing file, with their lines", () => {
    const root = fixture({
      "package.json": { name: "one", conventions: { rules: { "roadmap-parses": { roadmaps: ["docs/EMPTY.md"], reason: "a second roadmap" } } } },
      ".github/workflows/pages.yml": `${pages}      other: x\n  later:\n    with:\n      roadmap: "docs/GONE.md"\n`,
      "docs/ROADMAP.md": `${roadmap}| a2 | Second |\n`,
      "docs/EMPTY.md": "# Nothing\n",
    });
    commitAll(root);
    expect(rule(root, "roadmap-parses").breaks.map((item) => `${item.file}:${String(item.line)}: ${item.message}`)).toEqual([
      "docs/ROADMAP.md:6: docs/ROADMAP.md: the row has 2 cells, and the header has 3",
      ".github/workflows/pages.yml:9: .github/workflows/pages.yml names the roadmap docs/GONE.md, and the file does not exist.",
      expect.stringMatching(/^docs\/EMPTY\.md:undefined: docs\/EMPTY\.md: no table with an ID column/),
    ]);
  });

  it("reports a call of the Pages workflow that gives no roadmap, in its own job", () => {
    const root = fixture({
      "package.json": { name: "one" },
      ".github/workflows/pages.yml": `jobs:\n  site:\n    permissions:\n      contents: read\n    uses: ./.github/workflows/reusable-pages.yml\n    with:\n      out: site\n${pages.slice("jobs:\n".length)}`,
      ".github/workflows/other.yml": "jobs:\n  a:\n    with:\n      roadmap: ${{ inputs.roadmap }}\n    uses: o/template/.github/workflows/reusable-pages.yml@0123abc # main\n",
      "docs/ROADMAP.md": roadmap,
    });
    commitAll(root);
    expect(rule(root, "roadmap-parses").breaks.map((item) => `${item.file}:${String(item.line)}: ${item.message}`)).toEqual([
      ".github/workflows/pages.yml:5: .github/workflows/pages.yml builds the site with the Pages workflow and gives no roadmap, so the Status page shows no roadmap item.",
    ]);
    const plain = fixture({ "package.json": { name: "one" }, ".github/workflows/pages.yml": "jobs:\n  site:\n    uses: o/t/.github/workflows/reusable-pages.yml@0123abc\n    with:\n      site-pages: false # no Status page\n" });
    commitAll(plain);
    expect(rule(plain, "roadmap-parses").status).toBe("skipped");
    const only = fixture({ "package.json": { name: "one" }, ".github/workflows/pages.yml": "jobs:\n  site:\n    uses: o/t/.github/workflows/reusable-pages.yml@0123abc\n" });
    commitAll(only);
    expect(rule(only, "roadmap-parses").status).not.toBe("skipped");
    expect(rule(only, "roadmap-parses").breaks).toHaveLength(1);
  });

  it("reads the value of a roadmap key", () => {
    expect(["  roadmap: docs/R.md", "roadmap: './R.md' # x", "roadmap:", "roadmap: ${{ inputs.roadmap }}", "  roadmaps: x", "# roadmap: x"].map(roadmapOfLine)).toEqual(["docs/R.md", "R.md", undefined, undefined, undefined, undefined]);
  });
});

describe("runner-budget", () => {
  const env = { GITHUB_REPOSITORY: "o/one" };
  const minute = scheduleMinute("o/one", ".github/workflows/scan.yml");
  const other = minute === 59 ? 1 : minute + 1;
  const show = (root: string): string[] => rule(root, "runner-budget", { env }).breaks.map((item) => `${item.file}:${String(item.line)}: ${item.message}`);

  it("gives a minute from 1 to 59 that depends on the repository and the file", () => {
    expect(minute).toBeGreaterThanOrEqual(1);
    expect(minute).toBeLessThanOrEqual(59);
    expect(scheduleMinute("O/One", ".github/workflows/scan.yml")).toBe(minute);
    const minutes = new Set(Array.from({ length: 60 }, (_, index) => scheduleMinute(`o/repo-${String(index)}`, ".github/workflows/security.yml")));
    expect(minutes.size).toBeGreaterThan(30);
  });

  it("passes the workflows that keep the budget", () => {
    const scan = ["on:", "  schedule:", `    - cron: "${String(minute)} 5 * * 1" # weekly`, "concurrency:", "  group: scan", "jobs:", "  a:", "    strategy:", "      max-parallel: 3", "      matrix:", "        node: [24, 26]", "    runs-on: ubuntu-latest", ""];
    const each = ["on: push", "jobs:", "  a:", "    concurrency: a", "    runs-on: ubuntu-latest", "  b:", "    runs-on: ubuntu-latest", "    concurrency:", "      group: b", ""];
    const root = fixture({
      "package.json": { name: "one" },
      ".github/workflows/scan.yml": scan.join("\n"),
      ".github/workflows/shared.yml": "on:\n  workflow_call:\njobs:\n  a:\n    runs-on: ubuntu-latest\n",
      ".github/workflows/each.yml": each.join("\n"),
    });
    commitAll(root);
    expect(show(root)).toEqual([]);
  });

  it("reports a matrix with no max-parallel or too large a one, a job with no group, and a schedule at another minute", () => {
    const scan = [
      "on:",
      "  schedule:",
      `    - cron: '${String(other)} 5 * * 1'`,
      "# concurrency:",
      "jobs:",
      "  a:",
      "    strategy:",
      "      matrix:",
      "        node: [24, 26]",
      "    runs-on: ubuntu-latest",
      "  b:",
      "    strategy:",
      "      fail-fast: false",
      "      max-parallel: 8",
      "      matrix: ${{ fromJSON(inputs.cells) }}",
      "",
    ];
    const root = fixture({ "package.json": { name: "one" }, ".github/workflows/scan.yml": scan.join("\n") });
    commitAll(root);
    expect(show(root)).toEqual([
      ".github/workflows/scan.yml:7: .github/workflows/scan.yml: a matrix has no max-parallel.",
      ".github/workflows/scan.yml:12: .github/workflows/scan.yml: a matrix has max-parallel 8, and the most is 3.",
      ".github/workflows/scan.yml:6: .github/workflows/scan.yml: the job a has no concurrency group, and the workflow has none.",
      ".github/workflows/scan.yml:11: .github/workflows/scan.yml: the job b has no concurrency group, and the workflow has none.",
      `.github/workflows/scan.yml:3: .github/workflows/scan.yml: the schedule "${String(other)} 5 * * 1" starts at minute ${String(other)}, and the minute of this repository and file is ${String(minute)}.`,
    ]);
    expect(rule(root, "runner-budget", { env }).breaks.at(-1)?.fix).toBe(`cron: "${String(minute)} 5 * * 1"`);
  });

  it("lets a schedule start more than once in each hour, at equal steps from the minute", () => {
    expect(minuteField(18, 1)).toBe("18");
    expect(minuteField(18, 2)).toBe("18,48");
    expect(minuteField(50, 4)).toBe("5,20,35,50");
    const cron = (field: string): string => {
      const root = fixture({ "package.json": { name: "one" }, ".github/workflows/scan.yml": `on:\n  schedule:\n    - cron: "${field} * * * *"\nconcurrency: scan\njobs: {}\n` });
      commitAll(root);
      return root;
    };
    expect(show(cron(minuteField(minute, 2)))).toEqual([]);
    const each30 = cron("*/30");
    expect(rule(each30, "runner-budget", { env }).breaks.map((item) => item.fix)).toEqual([`cron: "${minuteField(minute, 2)} * * * *"`]);
    // A list at the wrong minutes keeps its number of starts, and a list that does not divide the hour becomes one start.
    expect(rule(cron(minuteField(other, 3)), "runner-budget", { env }).breaks.map((item) => item.fix)).toEqual([`cron: "${minuteField(minute, 3)} * * * *"`]);
    expect(rule(cron("1,2,3,4,5,6,7"), "runner-budget", { env }).breaks.map((item) => item.fix)).toEqual([`cron: "${String(minute)} * * * *"`]);
  });

  it("reports a schedule when the repository is not known, and skips with no workflow", () => {
    const root = fixture({ "package.json": { name: "one" }, ".github/workflows/scan.yml": 'on:\n  schedule:\n    - cron: "1 5 * * 1"\nconcurrency: scan\njobs: {}\n' });
    commitAll(root);
    expect(rule(root, "runner-budget").breaks.map((item) => item.message)).toEqual([expect.stringContaining("cannot find the repository")]);
    const none = fixture({ "package.json": { name: "one" } });
    commitAll(none);
    expect(rule(none, "runner-budget").status).toBe("skipped");
  });

  it("lets a job call a shared workflow of grouped, and examines the jobs of that workflow", () => {
    const caller = "on: pull_request\njobs:\n  review:\n    uses: ./.github/workflows/reusable-ai-review.yml\n  other:\n    uses: o/template/.github/workflows/reusable-ci.yml@0123abc # main\n";
    const shared = "on:\n  workflow_call:\njobs:\n  review:\n    concurrency:\n      group: r\n    runs-on: ubuntu-latest\n  post:\n    runs-on: ubuntu-latest\n";
    const root = fixture({ "package.json": { name: "one" }, ".github/workflows/ai.yml": caller, ".github/workflows/reusable-ai-review.yml": shared, ".github/workflows/reusable-ci.yml": "on: workflow_call\njobs:\n  a:\n    runs-on: ubuntu-latest\n" });
    commitAll(root);
    expect(show(root)).toEqual([
      ".github/workflows/ai.yml:5: .github/workflows/ai.yml: the job other has no concurrency group, and the workflow has none.",
      ".github/workflows/reusable-ai-review.yml:8: .github/workflows/reusable-ai-review.yml: the job post has no concurrency group, and its callers rely on it (the option grouped).",
    ]);
  });

  it("reads the repository of a remote URL", () => {
    expect(["git@github.com:o/r.git", "https://github.com/o/r", "https://github.com/o/r.git/", "https://gitlab.com/o/r", "https://github.com/o"].map(repositoryOfRemote)).toEqual(["o/r", "o/r", "o/r", undefined, undefined]);
  });
});

describe("gate-trigger", () => {
  const show = (root: string, options: Omit<CheckOptions, "root" | "only"> = {}): string[] =>
    rule(root, "gate-trigger", options).breaks.map((item) => `${item.file}:${String(item.line)}: ${(item.edits ?? []).length > 0 ? "fix " : ""}${item.message}`);
  const bench = [
    "name: Speed gate",
    "on:",
    "  push:",
    "    branches: [main]",
    '    paths: ["src/**"]',
    "  pull_request:",
    "    types: [opened, synchronize]",
    "    paths:",
    '      - "src/**"',
    "      # the workflow itself",
    "      - .github/workflows/bench.yml",
    "  workflow_dispatch:",
    "concurrency:",
    "  group: bench",
    "jobs:",
    "  plan:",
    "    if: ${{ inputs.plan }}",
    "    runs-on: ubuntu-latest",
    "  bench:",
    "    needs: plan",
    "    runs-on: ubuntu-latest",
    "  report:",
    "    needs:",
    "      - bench",
    "    if: ${{ !cancelled() }}",
    "    runs-on: ubuntu-latest",
    "  other:",
    "    runs-on: ubuntu-latest",
    "",
  ];

  it("finds the path filters of the pull request triggers, and only those", () => {
    expect(prPathFilters(bench.join("\n"))).toEqual([{ line: 8, trigger: "pull_request", key: "paths" }]);
    expect(prPathFilters('"on":\n  pull_request_target: { paths-ignore: [docs/**] }\njobs: {}\n')).toEqual([{ line: 2, trigger: "pull_request_target", key: "paths-ignore" }]);
    for (const text of ["on: pull_request\n", "on: [push, pull_request]\n", "on:\n  push:\n    paths: [a]\n  pull_request:\n", "on:\n  pull_request:\n    # paths: [a]\n    branches: [main]\n"]) {
      expect(prPathFilters(text), text).toEqual([]);
    }
  });

  it("converts a gate: the trigger loses the filter, each job needs changes, and a summary needs each job", () => {
    const converted = convertGate(bench.join("\n"), ".github/workflows/bench.yml", SHA);
    if (!("text" in converted)) throw new Error(converted.reason);
    expect(converted.text.split("\n")).toEqual([
      "name: Speed gate",
      "on:",
      "  push:",
      "    branches: [main]",
      '    paths: ["src/**"]',
      "  # Each pull request starts this workflow, so its summary check is always there. The job changes skips the",
      '  # work when the pull request changes no file of the gate (CI.md of the template, "A gate with paths").',
      "  pull_request:",
      "    types: [opened, synchronize]",
      "  workflow_dispatch:",
      "concurrency:",
      "  group: bench",
      "jobs:",
      "  changes:",
      "    runs-on: ubuntu-latest",
      "    timeout-minutes: 5",
      "    permissions:",
      "      contents: read",
      "      pull-requests: read",
      "    outputs:",
      "      match: ${{ steps.changes.outputs.match }}",
      "    steps:",
      "      - id: changes",
      `        uses: mark1russell7/template/.github/actions/changes@${SHA} # main`,
      "        with:",
      "          paths: |",
      "            src/**",
      "            .github/workflows/bench.yml",
      "",
      "  plan:",
      "    needs: changes",
      "    if: ${{ needs.changes.outputs.match == 'true' && (inputs.plan) }}",
      "    runs-on: ubuntu-latest",
      "  bench:",
      "    if: needs.changes.outputs.match == 'true'",
      "    needs: [changes, plan]",
      "    runs-on: ubuntu-latest",
      "  report:",
      "    needs:",
      "      - changes",
      "      - bench",
      "    if: ${{ needs.changes.outputs.match == 'true' && (!cancelled()) }}",
      "    runs-on: ubuntu-latest",
      "  other:",
      "    needs: changes",
      "    if: needs.changes.outputs.match == 'true'",
      "    runs-on: ubuntu-latest",
      "",
      "  speed-gate-ok:",
      "    name: Speed gate OK",
      "    if: ${{ !cancelled() }}",
      "    needs: [changes, plan, bench, report, other]",
      "    runs-on: ubuntu-latest",
      "    timeout-minutes: 2",
      "    permissions: {}",
      "    steps:",
      `      - uses: mark1russell7/template/.github/actions/gate-summary@${SHA} # main`,
      "        with:",
      "          needs: ${{ toJSON(needs) }}",
      "          allow-skip: plan bench report",
      "",
    ]);
    expect(prPathFilters(converted.text)).toEqual([]);
  });

  it("gives paths-ignore to changes, a group to each new job of a workflow with no group, and the name of the file when the workflow has none", () => {
    const converted = convertGate("on:\n  pull_request:\n    paths-ignore: [docs/**]\njobs:\n  a:\n    concurrency: a\n    runs-on: ubuntu-latest\n", ".github/workflows/text-bench.yml", SHA);
    if (!("text" in converted)) throw new Error(converted.reason);
    expect(converted.text).toContain("          paths: |\n            **\n          paths-ignore: |\n            docs/**\n");
    expect(converted.text).toContain("  text-bench-ok:\n    name: Text bench OK\n");
    expect(converted.text).toContain("    concurrency:\n      group: ${{ github.workflow }}-changes-${{ github.event_name == 'pull_request' && github.ref || github.sha }}\n");
    expect(converted.text).toContain("    concurrency:\n      group: ${{ github.workflow }}-text-bench-ok-${{ github.event_name == 'pull_request' && github.ref || github.sha }}\n");
    expect(["HTTP", "search objective", "Harness (cells)", "", "- x -"].map(summaryName)).toEqual(["HTTP OK", "Search objective OK", "Harness cells OK", "Gate OK", "X OK"]);
  });

  it("leaves to a person a workflow that it cannot convert with certainty", () => {
    const head = "on:\n  pull_request:\n    paths: [a]\njobs:\n";
    const reasons = [
      `${head}  changes:\n    runs-on: ubuntu-latest\n`,
      `${head}  a:\n    if: >-\n      inputs.x\n    runs-on: ubuntu-latest\n`,
      `${head}  a:\n    if: \${{ a }} && \${{ b }}\n    runs-on: ubuntu-latest\n`,
      "on:\n  pull_request: { paths: [a] }\njobs:\n  a:\n    runs-on: ubuntu-latest\n",
      "on:\n  pull_request:\n    paths: [a]\n  pull_request_target:\n    paths: [b]\njobs:\n  a:\n    runs-on: ubuntu-latest\n",
    ].map((text) => {
      const converted = convertGate(text, ".github/workflows/x.yml", SHA);
      return "reason" in converted ? converted.reason : "converted";
    });
    expect(reasons).toEqual([
      "the workflow already has a job changes",
      "the if of the job a has more than one line",
      "the if of the job a has a part in ${{ }}",
      "on.pull_request has the flow form",
      "the triggers have different paths",
    ]);
  });

  it("reports each filtered workflow once with its fix, skips the option allow, and passes after conventions fix", () => {
    const root = fixture({
      "package.json": { name: "one" },
      ".github/workflows/bench.yml": bench.join("\n"),
      ".github/workflows/preview.yml": "on:\n  pull_request:\n    paths: [site/**]\njobs:\n  a:\n    runs-on: ubuntu-latest\n",
      ".github/workflows/odd.yml": "on:\n  pull_request: { paths: [a] }\njobs:\n  a:\n    runs-on: ubuntu-latest\n",
      ".github/workflows/ci.yml": "on:\n  pull_request:\n  push:\n    paths: [src/**]\njobs:\n  a:\n    runs-on: ubuntu-latest\n",
    });
    commitAll(root);
    expect(show(root)).toEqual([
      ".github/workflows/bench.yml:8: fix .github/workflows/bench.yml: on.pull_request.paths, so the workflow does not start on each pull request, and the ruleset cannot ask for its summary check.",
      ".github/workflows/odd.yml:2: .github/workflows/odd.yml: on.pull_request.paths, so the workflow does not start on each pull request, and the ruleset cannot ask for its summary check.",
      ".github/workflows/preview.yml:3: fix .github/workflows/preview.yml: on.pull_request.paths, so the workflow does not start on each pull request, and the ruleset cannot ask for its summary check.",
    ]);
    const odd = rule(root, "gate-trigger").breaks.find((item) => item.file.endsWith("odd.yml"));
    expect(odd?.fix).toMatch(/^A person must convert it, because on.pull_request has the flow form\. /);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "one", conventions: { rules: { "gate-trigger": { allow: ["preview.yml", "odd.yml"], reason: "a preview and a test" } } } }));
    expect(show(root).map((line) => line.split(":")[0])).toEqual([".github/workflows/bench.yml"]);
    const fixed = runFix({ root, only: ["gate-trigger"] });
    expect(fixed.changed).toEqual([".github/workflows/bench.yml"]);
    expect(fixed.result.failed).toBe(false);
  });

  it("skips a repository with no workflow", () => {
    const root = fixture({ "package.json": { name: "one" } });
    commitAll(root);
    expect(rule(root, "gate-trigger")).toMatchObject({ status: "skipped", note: "the repository has no workflow" });
  });
});

describe("home-package", () => {
  /** A repository of `repo` with a first commit, and a second commit that adds `added` to src/a.ts. */
  function changed(added: string, repo = "mark1russell7/other"): string {
    const root = fixture({ "package.json": { name: "one" }, "src/a.ts": "export function median(values: number[]): number {\n  return values[0] ?? 0;\n}\n" });
    commitAll(root);
    git(root, "remote", "add", "origin", `https://github.com/${repo}.git`);
    git(root, "tag", "base");
    writeFileSync(join(root, "src/a.ts"), `export function median(values: number[]): number {\n  return values[0] ?? 0;\n}\n${added}`);
    git(root, "commit", "-q", "-am", "change");
    return root;
  }

  it("runs in a plain local check, with the default branch of origin as the base", () => {
    const root = changed("function medianOf(xs: number[]): number {\n  return xs[0] ?? 0;\n}\n");
    git(root, "update-ref", "refs/remotes/origin/main", "base");
    const code = (args: string[], env: Record<string, string> = {}): number =>
      runCli(["check", "--rule", "home-package", ...args], { cwd: root, env, stdout: () => undefined, stderr: () => undefined });
    expect(localBase(root, {})).toBe("origin/main");
    expect(code([])).toBe(1);
    expect(code(["--no-base"])).toBe(0);
    expect(localBase(root, { CI: "true" })).toBeUndefined();
    expect(code([], { CI: "true" })).toBe(0);
    expect(localBase(fixture({ "package.json": { name: "two" } }), {})).toBeUndefined();
  });

  it("knows the forms of a declaration", () => {
    expect(declaredName("export async function quantile(xs: number[], q: number) {")).toBe("quantile");
    expect(declaredName("function* draws(seed: number) {")).toBe("draws");
    // A long line with no declaration does not backtrack for a long time (CodeQL js/polynomial-redos)
    const start = performance.now();
    expect(declaredName(`function${" ".repeat(50_000)}(`)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(500);
    expect(declaredName("const medianOf = (values: readonly number[]): number => 0;")).toBe("medianOf");
    expect(declaredName("export const mulberry32 = function (seed: number) {")).toBe("mulberry32");
    expect(declaredName("const total = values.length;")).toBeUndefined();
    expect(declaredName("  return median(values);")).toBeUndefined();
  });

  it("breaks on an added function of another home, and not on the copy that exists", () => {
    const result = rule(changed("const quantile = (xs: number[], q: number): number => xs[0] ?? q;\nfunction total(xs: number[]): number {\n  return xs.length;\n}\n"), "home-package", { base: "base", env: {} });
    expect(result.status).toBe("break");
    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]).toMatchObject({ file: "src/a.ts", line: 4 });
    expect(result.breaks[0]?.message).toContain("Import `quantile` from `@mark1russell7/rigor-statistics`");
  });

  it("says when the home does not export the name yet, and passes in the home itself", () => {
    const message = rule(changed("function medianOf(xs: number[]): number {\n  return xs[0] ?? 0;\n}\n"), "home-package", { base: "base", env: {} }).breaks[0]?.message;
    expect(message).toContain("does not export `medianOf` yet: add it to the home in a pull request of mark1russell7/rigor");
    expect(rule(changed("function medianOf(xs: number[]): number {\n  return xs[0] ?? 0;\n}\n", "mark1russell7/rigor"), "home-package", { base: "base", env: {} }).status).toBe("pass");
  });

  it("skips with no change, and examines each line with the option scope all", () => {
    const root = changed("// the end\n");
    expect(rule(root, "home-package", { env: {} }).status).toBe("skipped");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "one", conventions: { rules: { "home-package": { scope: "all", reason: "a sweep of the copies" } } } }));
    expect(rule(root, "home-package", { env: {} }).breaks.map((item) => item.line)).toEqual([1]);
  });

  it("has signatures that compile, and no name that two homes claim", () => {
    const signatures = signaturesOf(HOMES);
    expect(signatures.length).toBeGreaterThan(40);
    const names = ["quantile", "median", "medianOf", "mulberry32", "fnv1a32", "orient2d", "writeFileAtomic", "topoSort", "segmentsIntersect", "exponentialBackoff"];
    for (const name of names) expect(new Set(signatures.filter((item) => item.pattern.test(name)).map((item) => item.home.area)).size, name).toBe(1);
    for (const name of ["record", "run", "parse", "mean", "seconds", "connect", "measure"]) expect(signatures.some((item) => item.pattern.test(name)), name).toBe(false);
    // A word of another area after a statistics prefix: bootstrapRepo is the npm bootstrap of the release scripts (codeatlas, 2026-11-02)
    for (const name of ["bootstrapRepo", "bootstrapApp", "wilsonInterval", "bootstrapMedian", "bootstrap"]) expect(signatures.some((item) => item.pattern.test(name)), name).toBe(!name.endsWith("Repo") && !name.endsWith("App"));
    // A planned home has no package to import yet, so its signatures do not break
    for (const name of ["graphemes", "parseArgs"]) expect(signatures.some((item) => item.pattern.test(name)), name).toBe(false);
  });
});

describe("api-report-script", () => {
  const SCRIPTS = { typecheck: "tsc" };
  const publicPackage = { "packages/a/package.json": { name: "a" } };

  it("passes with the script, and with no public package", () => {
    expect(rule(workspace({ scripts: { "check:api": "api-report check" } }, publicPackage), "api-report-script").status).toBe("pass");
    expect(rule(workspace({}, { "packages/b/package.json": { name: "b", private: true } }), "api-report-script").status).toBe("pass");
    expect(rule(fixture({ "package.json": { name: "one", private: true } }), "api-report-script").status).toBe("pass");
  });

  it("asks a repository with one public package for the script", () => {
    const result = rule(workspace({ scripts: SCRIPTS }, publicPackage), "api-report-script");
    expect(result.status).toBe("break");
    expect(result.breaks[0]?.message).toContain('no script "check:api"');
    expect(result.breaks[0]?.message).toContain("public package: a.");
    expect(rule(fixture({ "package.json": { name: "one" } }), "api-report-script").status).toBe("break");
  });

  it("adds the script and the dependency, with the form of the file", () => {
    const root = fixture({
      "package.json": '{\r\n  "name": "root",\r\n  "private": true,\r\n  "files": ["a", "b"],\r\n  "scripts": {\r\n    "test": "vitest"\r\n  },\r\n  "devDependencies": {\r\n    "@mark1russell7/conventions": "^0.29.0",\r\n    "typescript": "^6.0.0"\r\n  }\r\n}\r\n',
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      ...publicPackage,
    });
    expect(runFix({ root, only: ["api-report-script"] }).changed).toEqual(["package.json"]);
    const text = readFileSync(join(root, "package.json"), "utf8");
    expect(text).toContain('"files": ["a", "b"],\r\n');
    expect(text).toContain('    "test": "vitest",\r\n    "check:api": "api-report check"\r\n  },\r\n');
    expect(text).toContain(`    "@mark1russell7/api-report": "${API_REPORT_RANGE}",\r\n    "@mark1russell7/conventions": "^0.29.0",\r\n`);
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
    expect(rule(root, "api-report-script").status).toBe("pass");
  });

  it("keeps a dependency that exists, and adds a block that does not exist", () => {
    const root = workspace({ devDependencies: { "@mark1russell7/api-report": "workspace:*" } }, publicPackage);
    runFix({ root, only: ["api-report-script"] });
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(manifest.scripts["check:api"]).toBe("api-report check");
    expect(manifest.devDependencies["@mark1russell7/api-report"]).toBe("workspace:*");
  });

  it("gives a break with no edit for a manifest that the fix cannot read", () => {
    const root = fixture({ "package.json": '{ "name": "one", "scripts": { "test": "vitest" } }\n' });
    expect(rule(root, "api-report-script").status).toBe("break");
    expect(runFix({ root, only: ["api-report-script"] }).changed).toEqual([]);
  });
});

describe("license-file", () => {
  const MIT = mitText(2026, "Mark Russell");

  it("passes with a license file in each public package and at the root, and with no public package", () => {
    const root = workspace({ license: "MIT" }, { LICENSE: MIT, "packages/a/package.json": { name: "a", license: "MIT" }, "packages/a/LICENSE": MIT, "packages/b/package.json": { name: "b", private: true } });
    expect(rule(root, "license-file").status).toBe("pass");
    expect(rule(workspace({}, { "packages/b/package.json": { name: "b", private: true } }), "license-file").status).toBe("pass");
    expect(rule(fixture({ "package.json": { name: "one", license: "MIT" }, "LICENSE.md": MIT }), "license-file").status).toBe("pass");
  });

  it("breaks on a missing field, a missing file and a text of another license, and fix copies the license of the repository", () => {
    const root = workspace({}, {
      LICENSE: MIT,
      "packages/a/package.json": { name: "a", license: "MIT" },
      "packages/b/package.json": { name: "b" },
      "packages/c/package.json": { name: "c", license: "MIT" },
      "packages/c/LICENSE": "Apache License, Version 2.0\n",
    });
    const result = rule(root, "license-file");
    expect(result.breaks.map((item) => item.file)).toEqual(["packages/a/LICENSE", "packages/b/package.json", "packages/c/LICENSE"]);
    expect(result.breaks.map((item) => (item.edits ?? []).length)).toEqual([1, 0, 0]);
    runFix({ root, only: ["license-file"] });
    expect(readFileSync(join(root, "packages/a/LICENSE"), "utf8")).toBe(MIT);
  });

  it("writes the MIT text with the author when the repository has no license file", () => {
    const root = workspace({}, { "packages/a/package.json": { name: "a", license: "MIT", author: "Mark Russell (https://github.com/mark1russell7)" } });
    expect(rule(root, "license-file").breaks.map((item) => item.file)).toEqual(["packages/a/LICENSE", "LICENSE"]);
    runFix({ root, only: ["license-file"] });
    for (const file of ["LICENSE", "packages/a/LICENSE"]) expect(readFileSync(join(root, file), "utf8")).toMatch(/^MIT License\n\nCopyright \(c\) \d{4} Mark Russell\n/);
    expect(rule(root, "license-file").status).toBe("pass");
    expect([authorOf("A B <a@b.c> (https://x)"), authorOf({ name: "C" }), authorOf(""), authorOf(3)]).toEqual(["A B", "C", undefined, undefined]);
  });

  it("asks a public repository with no public package for a root license file, from the event file of the run", () => {
    const root = workspace({ author: "Mark Russell" }, { "packages/b/package.json": { name: "b", private: true } });
    const event = (repository: Record<string, unknown>): Record<string, string> => {
      const file = join(root, "..", `event-${fixtures++}.json`);
      writeFileSync(file, JSON.stringify({ repository }));
      return { GITHUB_EVENT_PATH: file };
    };
    expect(rule(root, "license-file", { env: event({ private: true }) }).status).toBe("pass");
    expect(rule(root, "license-file", { env: event({}) }).status).toBe("pass");
    const env = event({ private: false });
    expect(rule(root, "license-file", { env }).breaks.map((item) => item.file)).toEqual(["LICENSE"]);
    runFix({ root, only: ["license-file"], env });
    expect(readFileSync(join(root, "LICENSE"), "utf8")).toMatch(/^MIT License\n\nCopyright \(c\) \d{4} Mark Russell\n/);
    expect(rule(root, "license-file", { env }).status).toBe("pass");
  });
});

describe("pages-site", () => {
  const pages = "jobs:\n  pages:\n    uses: mark1russell7/template/.github/workflows/reusable-pages.yml@0123abc # main\n    with:\n      roadmap: docs/ROADMAP.md\n";
  const test = "jobs:\n  pages:\n    uses: ./.github/workflows/reusable-pages.yml\n    with:\n      out: test-site\n      deploy: false\n  other:\n    runs-on: ubuntu-latest\n";
  /** This function writes an event file of a run, and gives the environment that names it. */
  const event = (repository: Record<string, unknown>): Record<string, string> => {
    const file = join(temp, `event-${fixtures++}.json`);
    writeFileSync(file, JSON.stringify({ repository }));
    return { GITHUB_EVENT_PATH: file };
  };

  it("finds each call of the Pages workflow with any ref, and the calls that do not deploy", () => {
    expect(pagesCalls(pages)).toEqual([{ line: 3, deploys: true }]);
    expect(pagesCalls(test)).toEqual([{ line: 3, deploys: false }]);
    expect(pagesCalls("jobs:\n  a:\n    uses: 'Mark1Russell7/Template/.github/workflows/reusable-pages.yml@v1'\n  b:\n    # uses: ./.github/workflows/reusable-pages.yml\n    uses: o/t/.github/workflows/reusable-pages.yml@main\n")).toEqual([{ line: 3, deploys: true }]);
    expect(pagesCalls("jobs:\n  b:\n    uses: o/t/.github/workflows/reusable-pages.yml@main\n", ["o/t/.github/workflows/reusable-pages.yml"])).toEqual([{ line: 3, deploys: true }]);
  });

  it("passes a public repository that deploys a site, and a private repository with no site", () => {
    const root = fixture({ "package.json": { name: "one" }, ".github/workflows/pages.yml": pages });
    commitAll(root);
    expect(rule(root, "pages-site", { env: event({ private: false }) }).status).toBe("pass");
    const none = fixture({ "package.json": { name: "one" }, ".github/workflows/ci.yml": "jobs:\n  a:\n    runs-on: ubuntu-latest\n" });
    commitAll(none);
    expect(rule(none, "pages-site", { env: event({ private: true }) }).status).toBe("pass");
  });

  it("skips outside a run, and breaks on a public repository with no site or with a test site only", () => {
    const root = fixture({ "package.json": { name: "one" }, ".github/workflows/actions-test.yml": test });
    commitAll(root);
    expect(rule(root, "pages-site", { env: {} }).status).toBe("skipped");
    expect(rule(root, "pages-site", { env: event({}) }).status).toBe("skipped");
    const result = rule(root, "pages-site", { env: event({ private: false }) });
    expect(result.breaks.map((item) => `${item.file}: ${item.message}`)).toEqual([
      ".github/workflows/pages.yml: The repository is public, and no workflow deploys its site with the Pages workflow of the template. The calls in .github/workflows/actions-test.yml have deploy: false.",
    ]);
    const none = fixture({ "package.json": { name: "one" } });
    commitAll(none);
    expect(rule(none, "pages-site", { env: event({ private: false }) }).breaks.map((item) => item.message)).toEqual(["The repository is public, and no workflow deploys its site with the Pages workflow of the template."]);
  });
});

describe("unreleased-change", () => {
  /** The versions of a package on the fake registry: a list, the publish time of each version, or an error. */
  type Fake = readonly string[] | Readonly<Record<string, string>> | Error;
  /** A fake registry: the versions of each name, or an error. It keeps the names of each lookup. */
  function registry(answers: Record<string, Fake>): { lookup: (names: readonly string[]) => ReadonlyMap<string, RegistryAnswer>; asked: string[][] } {
    const asked: string[][] = [];
    const lookup = (names: readonly string[]): ReadonlyMap<string, RegistryAnswer> => {
      asked.push([...names]);
      return new Map(
        names.map((name): [string, RegistryAnswer] => {
          const answer = answers[name] ?? [];
          if (answer instanceof Error) return [name, { error: answer.message }];
          if (Array.isArray(answer)) return [name, { versions: answer as readonly string[] }];
          const times = answer as Readonly<Record<string, string>>;
          return [name, { versions: Object.keys(times), times }];
        }),
      );
    };
    return { lookup, asked };
  }
  /** A workspace with one published package `@x/a` at `version`, committed and tagged `base`. The option sets the mode. */
  function repo(version: string, extra: Record<string, unknown> = {}, manifest: Record<string, unknown> = {}, strict = true): string {
    const conventions = strict ? { conventions: { rules: { "unreleased-change": { versionEachChange: true, reason: "each pull request sets its version" } } } } : {};
    const root = workspace(conventions, {
      "packages/a/package.json": { name: "@x/a", version, ...manifest },
      "packages/a/src/index.ts": "export const a = 1;\n",
      "packages/a/src/index.test.ts": "test\n",
      "packages/a/README.md": "# a\n",
      "packages/b/package.json": { name: "@x/b", private: true, version: "1.0.0" },
      "packages/b/src/index.ts": "export const b = 1;\n",
      ...extra,
    });
    commitAll(root);
    git(root, "tag", "base");
    return root;
  }
  /** This function writes each file and commits the change. */
  function change(root: string, files: Record<string, unknown>, message = "change"): void {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), typeof text === "string" ? text : `${JSON.stringify(text, null, 2)}\n`);
    }
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", message);
  }
  /** This function starts the rule with a fake registry. */
  const check = (root: string, answers: Record<string, Fake>, options: Omit<CheckOptions, "root" | "only" | "rules"> = { base: "base" }): RuleResult =>
    rule(root, "unreleased-change", { rules: [unreleasedChangeRule(registry(answers).lookup)], ...options });
  /** This function writes the event file of a push, and gives its environment. */
  const pushed = (before: string, ref = "refs/heads/main", pushedAt = 1_800_000_000): Record<string, string> => {
    const event = join(temp, `event-${String(fixtures++)}.json`);
    writeFileSync(event, JSON.stringify({ before, ref, repository: { default_branch: "main", pushed_at: pushedAt } }));
    return { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event };
  };
  /** The ISO time `seconds` after the push of `pushed`. */
  const after = (seconds: number): string => new Date((1_800_000_000 + seconds) * 1000).toISOString();
  /** This function makes the checkout of a pull request of GitHub. main moves after the branch `pr`, and HEAD is the merge commit of `pr`. */
  function mergeRef(root: string, mainFiles: Record<string, unknown>): void {
    git(root, "switch", "-q", "main");
    if (Object.keys(mainFiles).length > 0) change(root, mainFiles, "main moves");
    git(root, "switch", "-q", "--detach", "main");
    git(root, "merge", "-q", "--no-ff", "-m", "merge pr", "pr");
  }

  describe("with versionEachChange", () => {
    it("breaks when a shipped file changes and npm has the version, and names the files", () => {
      const root = repo("1.0.0");
      change(root, { "packages/a/src/index.ts": "export const a = 2;\n", "packages/b/src/index.ts": "export const b = 2;\n" });
      const fake = registry({ "@x/a": ["0.9.0", "1.0.0"] });
      const result = rule(root, "unreleased-change", { rules: [unreleasedChangeRule(fake.lookup)], base: "base" });
      expect(result.status).toBe("break");
      expect(result.breaks.map((item) => `${item.file}:${String(item.line)}: ${item.message}`)).toEqual([
        "packages/a/package.json:3: @x/a: the change is not released, because 1.0.0 is on npm already. Raise the version (SemVer) in a pull request. The change ships packages/a/src/index.ts.",
      ]);
      // The private package is not a question for the registry
      expect(fake.asked).toEqual([["@x/a"]]);
    });

    it("passes a change of only tests, docs, configs and dependencies, and does not ask the registry", () => {
      const root = repo("1.0.0");
      change(root, {
        "packages/a/src/index.test.ts": "test 2\n",
        "packages/a/README.md": "# a 2\n",
        "packages/a/test/fixtures/x.json": "{}\n",
        "packages/a/tsconfig.json": "{}\n",
        "packages/a/vitest.config.ts": "export default {};\n",
        "packages/a/package.json": { name: "@x/a", version: "1.0.0", devDependencies: { vitest: "^5.0.0" }, dependencies: { other: "^1.0.0" } },
        ".github/workflows/ci.yml": "on: push\n",
        "docs/ROADMAP.md": "x\n",
      });
      const fake = registry({ "@x/a": ["1.0.0"] });
      expect(rule(root, "unreleased-change", { rules: [unreleasedChangeRule(fake.lookup)], base: "base" }).status).toBe("pass");
      expect(fake.asked).toEqual([]);
    });

    it("breaks on a change of a shipped field of package.json", () => {
      const root = repo("1.0.0");
      change(root, { "packages/a/package.json": { name: "@x/a", version: "1.0.0", exports: { ".": "./src/index.ts" } } });
      expect(check(root, { "@x/a": ["1.0.0"] }).breaks.map((item) => item.message)).toEqual([
        "@x/a: the change is not released, because 1.0.0 is on npm already. Raise the version (SemVer) in a pull request. The change ships packages/a/package.json.",
      ]);
    });

    it("passes a version that npm does not have, and breaks a raised version that npm has", () => {
      const root = repo("1.0.0");
      change(root, { "packages/a/src/index.ts": "export const a = 2;\n", "packages/a/package.json": { name: "@x/a", version: "1.1.0" } });
      expect(check(root, { "@x/a": ["1.0.0"] }).status).toBe("pass");
      expect(check(root, { "@x/a": ["1.0.0", "1.1.0"] }).breaks.map((item) => item.message)).toEqual([
        "@x/a: the change sets the version 1.1.0, but 1.1.0 is on npm already. Raise the version (SemVer) in a pull request.",
      ]);
      // A new package: npm has no version
      expect(check(root, {}).status).toBe("pass");
    });

    it("uses the field files when git tracks its entries, and else counts each source file", () => {
      const listed = repo("1.0.0", { "packages/a/tools/gen.ts": "1\n" }, { files: ["src", "!src/internal"] });
      change(listed, { "packages/a/tools/gen.ts": "2\n" });
      expect(check(listed, { "@x/a": ["1.0.0"] }).status).toBe("pass");
      change(listed, { "packages/a/src/internal/x.ts": "2\n" });
      expect(check(listed, { "@x/a": ["1.0.0"] }).status).toBe("pass");
      const built = repo("1.0.0", { "packages/a/tools/gen.ts": "1\n" }, { files: ["build"] });
      change(built, { "packages/a/tools/gen.ts": "2\n" });
      expect(check(built, { "@x/a": ["1.0.0"] }).breaks.map((item) => item.file)).toEqual(["packages/a/package.json"]);
    });

    it("skips a Changesets repository, a placeholder version, a registry error and a run with no change", () => {
      const changesets = repo("1.0.0", { ".changeset/config.json": "{}\n" });
      change(changesets, { "packages/a/src/index.ts": "export const a = 2;\n" });
      expect(check(changesets, { "@x/a": ["1.0.0"] }).status).toBe("skipped");

      const placeholder = repo("0.0.0-stage");
      change(placeholder, { "packages/a/src/index.ts": "export const a = 2;\n" });
      const fake = registry({ "@x/a": ["0.0.0-stage"] });
      expect(rule(placeholder, "unreleased-change", { rules: [unreleasedChangeRule(fake.lookup)], base: "base" }).status).toBe("skipped");
      expect(fake.asked).toEqual([]);

      const offline = repo("1.0.0");
      change(offline, { "packages/a/src/index.ts": "export const a = 2;\n" });
      const result = check(offline, { "@x/a": new Error("fetch failed") });
      expect(result.status).toBe("skipped");
      expect(result.note).toBe("the registry did not answer for @x/a: fetch failed");
      expect(check(offline, { "@x/a": ["1.0.0"] }, {}).status).toBe("skipped");
    });

    it("finds the change of two pull requests that set the same version on the push to main", () => {
      // main has 0.1.3. Two pull requests each change a source file and set 0.1.4.
      const root = repo("0.1.3");
      git(root, "switch", "-q", "-c", "first");
      change(root, { "packages/a/src/first.ts": "1\n", "packages/a/package.json": { name: "@x/a", version: "0.1.4" } });
      git(root, "switch", "-q", "-c", "second", "base");
      change(root, { "packages/a/src/second.ts": "1\n", "packages/a/package.json": { name: "@x/a", version: "0.1.4" } });
      // The release of the first push publishes 0.1.4, 3 minutes after the push
      const published = { "@x/a": { "0.1.3": after(-86_400), "0.1.4": after(180) } };

      // The pull request of the second change, before the first merge: it raises 0.1.3 to 0.1.4, and npm does not have 0.1.4
      git(root, "switch", "-q", "--detach", "main");
      git(root, "merge", "-q", "--no-ff", "-m", "merge second", "second");
      expect(check(root, { "@x/a": ["0.1.3"] }, { env: { GITHUB_EVENT_NAME: "pull_request" } }).status).toBe("pass");
      git(root, "switch", "-q", "main");

      // The first merge, and its release: on its push, npm can have 0.1.4 already, from the release of the same push
      const start = git(root, "rev-parse", "HEAD").trim();
      git(root, "merge", "-q", "--no-ff", "-m", "merge first", "first");
      expect(check(root, published, { env: pushed(start) }).status).toBe("pass");
      // A version that npm had before the push breaks
      expect(check(root, { "@x/a": { "0.1.3": after(-86_400), "0.1.4": after(-60) } }, { env: pushed(start) }).breaks.map((item) => item.message)).toEqual([
        "@x/a: the change sets the version 0.1.4, but 0.1.4 is on npm already. Raise the version (SemVer) in a pull request.",
      ]);

      // The second merge: the version stays 0.1.4, which npm has, so the second change is not released
      const middle = git(root, "rev-parse", "HEAD").trim();
      git(root, "merge", "-q", "--no-ff", "-m", "merge second", "second");
      expect(check(root, published, { env: pushed(middle) }).breaks.map((item) => item.message)).toEqual([
        "@x/a: the change is not released, because 0.1.4 is on npm already. Raise the version (SemVer) in a pull request. The change ships packages/a/src/second.ts.",
      ]);

      // A push to another branch, a new branch and a commit that the checkout does not have skip
      expect(check(root, published, { env: pushed(middle, "refs/heads/other") }).status).toBe("skipped");
      expect(check(root, published, { env: pushed("0".repeat(40)) }).note).toBe("the push has no commit before it");
      expect(check(root, published, { env: pushed("f".repeat(40)) }).note).toMatch(/the checkout does not have f+, the commit before the push/);
    });

    it("examines the root package of a repository of one package, without the files of the repository tools", () => {
      const strict = { conventions: { rules: { "unreleased-change": { versionEachChange: true, reason: "each pull request sets its version" } } } };
      const root = fixture({ "package.json": { name: "one", version: "2.0.0", ...strict }, "src/index.ts": "1\n", "scripts/tool.ts": "1\n" });
      commitAll(root);
      git(root, "tag", "base");
      change(root, { "scripts/tool.ts": "2\n", ".github/workflows/ci.yml": "on: push\n", "CHANGELOG.md": "x\n" });
      expect(check(root, { one: ["2.0.0"] }).status).toBe("pass");
      change(root, { "src/index.ts": "2\n" });
      expect(check(root, { one: ["2.0.0"] }).breaks.map((item) => item.file)).toEqual(["package.json"]);
    });
  });

  describe("without versionEachChange (a repository that collects changes)", () => {
    it("passes a feature pull request with no version change, and does not ask the registry", () => {
      const root = repo("1.0.0", {}, {}, false);
      git(root, "switch", "-q", "-c", "pr");
      change(root, { "packages/a/src/index.ts": "export const a = 2;\n" });
      // main gets a version pull request after the branch starts: the merge commit has its version, but the change does not set it
      mergeRef(root, { "packages/a/package.json": { name: "@x/a", version: "1.1.0" } });
      const fake = registry({ "@x/a": ["1.0.0", "1.1.0"] });
      expect(rule(root, "unreleased-change", { rules: [unreleasedChangeRule(fake.lookup)], env: { GITHUB_EVENT_NAME: "pull_request" } }).status).toBe("pass");
      expect(fake.asked).toEqual([]);
    });

    it("breaks a pull request that sets a version that npm has, also when main has that version", () => {
      const root = repo("1.0.0", {}, {}, false);
      git(root, "switch", "-q", "-c", "pr");
      change(root, { "packages/a/package.json": { name: "@x/a", version: "1.1.0" } });
      // Another pull request set 1.1.0 first, and its release published it
      mergeRef(root, { "packages/a/src/index.ts": "export const a = 3;\n", "packages/a/package.json": { name: "@x/a", version: "1.1.0" } });
      const env = { GITHUB_EVENT_NAME: "pull_request" };
      expect(check(root, { "@x/a": ["1.0.0", "1.1.0"] }, { env }).breaks.map((item) => `${item.file}: ${item.message}`)).toEqual([
        "packages/a/package.json: @x/a: the change sets the version 1.1.0, but 1.1.0 is on npm already. Raise the version (SemVer) in a pull request.",
      ]);
      expect(check(root, { "@x/a": ["1.0.0"] }, { env }).status).toBe("pass");
    });

    it("passes the pushes of a repository that collects changes, and breaks a push that sets a version that npm had", () => {
      const root = repo("1.0.0", {}, {}, false);
      const first = git(root, "rev-parse", "HEAD").trim();
      change(root, { "packages/a/src/index.ts": "export const a = 2;\n" });
      const second = git(root, "rev-parse", "HEAD").trim();
      // A feature merge: no version change, and npm has 1.0.0
      expect(check(root, { "@x/a": { "1.0.0": after(-86_400) } }, { env: pushed(first) }).status).toBe("pass");
      // The version merge: its own release publishes 1.1.0 after the push
      change(root, { "packages/a/package.json": { name: "@x/a", version: "1.1.0" } });
      expect(check(root, { "@x/a": { "1.0.0": after(-86_400), "1.1.0": after(120) } }, { env: pushed(second) }).status).toBe("pass");
      expect(check(root, { "@x/a": { "1.0.0": after(-86_400), "1.1.0": after(-120) } }, { env: pushed(second) }).breaks.map((item) => item.message)).toEqual([
        "@x/a: the change sets the version 1.1.0, but 1.1.0 is on npm already. Raise the version (SemVer) in a pull request.",
      ]);
      // With no publish time, the rule cannot tell the release of the push from an older publish
      expect(check(root, { "@x/a": ["1.0.0", "1.1.0"] }, { env: pushed(second) }).note).toBe("the rule cannot tell if npm had @x/a@1.1.0 before the push");
    });
  });
});

describe("shared-docs", () => {
  const body = ["A shared rule.", "", "It has two lines."];
  const doc = (...parts: string[]): string => `# Promotion\n\n${parts.join("\n\n")}\n`;
  const sharedBlock = (id: string, lines: readonly string[] = body): string => [`<!-- shared:${id} -->`, ...lines, `<!-- /shared:${id} -->`].join("\n");
  const HOME = { repo: "o/home", path: "docs/HOME.md", commit: SHA, sha256: blockHash(body) };
  const link = `https://github.com/o/home/blob/${SHA}/docs/HOME.md`;
  const linkedBlock = (id: string, url = link): string => [`<!-- linked:${id} -->`, `The home of this block is [docs/HOME.md](${url}).`, `<!-- /linked:${id} -->`].join("\n");
  const repo = (text: string, lock: unknown): string => {
    const root = fixture({ "package.json": { name: "one" }, "docs/PROMOTION.md": text, "docs/shared.lock.json": lock });
    commitAll(root);
    return root;
  };
  /** A fake download that gives `text` for each URL, or the error `error`, and counts the URLs. */
  const homes = (answer: { text: string } | { error: string }): { fetch: HomeFetch; urls: string[] } => {
    const urls: string[] = [];
    return { urls, fetch: (asked) => (urls.push(...asked), new Map(asked.map((url) => [url, answer]))) };
  };
  const check = (root: string, fetch: HomeFetch, env: Record<string, string> = {}): RuleResult => rule(root, "shared-docs", { rules: [sharedDocsRule(fetch)], env });
  const none: HomeFetch = () => {
    throw new Error("no download expected");
  };

  it("skips a repository with no lock, and passes blocks that agree with the lock", () => {
    const empty = fixture({ "package.json": { name: "one" } });
    commitAll(empty);
    expect(check(empty, none).status).toBe("skipped");
    const root = repo(doc(sharedBlock("a"), sharedBlock("b", ["Other text."])), { file: "docs/PROMOTION.md", blocks: { a: blockHash(body), b: blockHash(["Other text."]) } });
    expect(check(root, none).breaks).toEqual([]);
  });

  it("breaks on a changed block, a block that the lock does not have, and a block that the document does not have", () => {
    const root = repo(doc(sharedBlock("a", ["Changed."]), sharedBlock("new")), { file: "docs/PROMOTION.md", blocks: { a: blockHash(body), gone: blockHash(body) } });
    const messages = check(root, none).breaks.map((b) => b.message);
    expect(messages).toHaveLength(3);
    expect(messages.some((m) => m.includes('"a" differs'))).toBe(true);
    expect(messages.some((m) => m.includes('"gone"') && m.includes("missing"))).toBe(true);
    expect(messages.some((m) => m.includes('"new" is not in'))).toBe(true);
  });

  it("breaks on a lock that locks nothing, and on markers that do not close", () => {
    const nothing = repo(doc(sharedBlock("a")), { file: "docs/PROMOTION.md" });
    expect(check(nothing, none).breaks.map((b) => b.message)).toEqual(['docs/shared.lock.json has no field "blocks" and no field "linked", so it locks nothing.']);
    const open = repo(doc("<!-- shared:a -->", "text"), { file: "docs/PROMOTION.md", blocks: {} });
    expect(check(open, none).breaks.some((b) => b.message.includes("has no end marker") && b.line === 3)).toBe(true);
  });

  it("passes a linked block with its link, without a download outside CI", () => {
    const root = repo(doc(linkedBlock("win-test")), { file: "docs/PROMOTION.md", linked: { "win-test": HOME } });
    expect(check(root, none).breaks).toEqual([]);
  });

  it("breaks on a linked block with a copy, a short commit or a link to another commit", () => {
    const copy = repo(doc(sharedBlock("win-test"), linkedBlock("win-test")), { file: "docs/PROMOTION.md", blocks: {}, linked: { "win-test": HOME } });
    expect(check(copy, none).breaks.map((b) => b.message)).toContain('the linked block "win-test" also has a copy in docs/PROMOTION.md. Remove the copy.');
    const short = repo(doc(linkedBlock("win-test")), { file: "docs/PROMOTION.md", linked: { "win-test": { ...HOME, commit: "0123abc" } } });
    expect(check(short, none).breaks.some((b) => b.message.includes("40 hex digits"))).toBe(true);
    const other = repo(doc(linkedBlock("win-test", link.replace(SHA, "f".repeat(40)))), { file: "docs/PROMOTION.md", linked: { "win-test": HOME } });
    expect(check(other, none).breaks.some((b) => b.message.includes("does not contain the link"))).toBe(true);
  });

  it("in CI, downloads the home at the pinned commit and compares the hash", () => {
    const root = repo(doc(linkedBlock("win-test")), { file: "docs/PROMOTION.md", linked: { "win-test": HOME } });
    const same = homes({ text: doc(sharedBlock("win-test")) });
    expect(check(root, same.fetch, { CI: "true" }).breaks).toEqual([]);
    expect(same.urls).toEqual([`https://raw.githubusercontent.com/o/home/${SHA}/docs/HOME.md`]);
    const changed = homes({ text: doc(sharedBlock("win-test", ["Another rule."])) });
    expect(check(root, changed.fetch, { CI: "true" }).breaks.some((b) => b.message.includes("not the hash of"))).toBe(true);
    const missing = homes({ text: doc(sharedBlock("other")) });
    expect(check(root, missing.fetch, { CI: "true" }).breaks.some((b) => b.message.includes('has no shared block "win-test"'))).toBe(true);
  });

  it("fails closed: a home that does not answer is a break", () => {
    const root = repo(doc(linkedBlock("win-test")), { file: "docs/PROMOTION.md", linked: { "win-test": HOME } });
    const down = homes({ error: "The operation was aborted due to timeout" });
    const result = check(root, down.fetch, { CI: "true" });
    expect(result.status).toBe("break");
    expect(result.breaks[0]?.message).toContain("did not answer");
  });
});

describe("changelog-version", () => {
  const log = (...versions: string[]): string => `# Changelog\n\n${versions.map((v) => `## ${v}\n\n- A change.\n`).join("\n")}`;
  const one = (version: string, changelog: string | undefined, options: Record<string, unknown> = {}): string =>
    fixture({ "package.json": { name: "@x/a", version, conventions: { rules: { "changelog-version": options } } }, ...(changelog === undefined ? {} : { "CHANGELOG.md": changelog }) });

  it("skips a repository with no changelog, and passes a top section at the version or below it", () => {
    expect(rule(one("1.0.0", undefined), "changelog-version").status).toBe("skipped");
    expect(rule(one("0.5.0", log("0.5.0", "0.4.1")), "changelog-version").breaks).toEqual([]);
    expect(rule(one("0.4.2", log("0.4.1")), "changelog-version").breaks).toEqual([]);
    expect(rule(one("0.4.1", log("Unreleased", "0.4.1")), "changelog-version").breaks).toEqual([]);
    expect(rule(one("1.0.0", "# Changelog\n\n## [1.0.0] - 2026-11-03\n\n- First.\n"), "changelog-version").breaks).toEqual([]);
  });

  it("breaks on a top section above the version, with its line (packing 0.5.0 at 0.4.1)", () => {
    const result = rule(one("0.4.1", log("0.5.0", "0.4.1")), "changelog-version");
    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]?.line).toBe(3);
    expect(result.breaks[0]?.message).toContain("has the section 0.5.0, and package.json is still at 0.4.1");
    expect(rule(one("1.0.0-rc.1", log("1.0.0")), "changelog-version").status).toBe("break");
  });

  it("with everyVersion, breaks on a version with no section", () => {
    expect(rule(one("0.4.2", log("0.4.1"), { everyVersion: true, reason: "each version has its notes" }), "changelog-version").breaks[0]?.message).toContain("Add the section 0.4.2");
    expect(rule(one("0.4.2", "# Changelog\n", { everyVersion: true, reason: "each version has its notes" }), "changelog-version").status).toBe("break");
  });

  it("reads the changelog of each package of a workspace, and not of a private package", () => {
    const root = workspace({}, {
      "packages/a/package.json": { name: "@x/a", version: "0.1.0" },
      "packages/a/CHANGELOG.md": log("0.2.0"),
      "packages/b/package.json": { name: "@x/b", version: "0.1.0", private: true },
      "packages/b/CHANGELOG.md": log("0.9.0"),
    });
    expect(rule(root, "changelog-version").breaks.map((b) => b.file)).toEqual(["packages/a/CHANGELOG.md"]);
  });
});

describe("main-runs-finish", () => {
  const PR = "${{ github.event_name == 'pull_request' }}";
  const OWN = "${{ github.event_name == 'pull_request' && github.ref || github.sha }}";
  const flow = (on: string[], cancel: string, group: string = OWN): string => [...on, "concurrency:", `  group: ci-${group}`, `  cancel-in-progress: ${cancel}`, "jobs:", "  a:", "    runs-on: ubuntu-latest", ""].join("\n");

  it("knows the forms of a push trigger", () => {
    expect(startsOnPush(["on: push"])).toBe(true);
    expect(startsOnPush(["on: [pull_request, push]"])).toBe(true);
    expect(startsOnPush(["on:", "  push:", "    branches: [main]"])).toBe(true);
    expect(startsOnPush(['"on":', "  push:"])).toBe(true);
    expect(startsOnPush(["on:", "  pull_request:", "  workflow_dispatch:"])).toBe(false);
    expect(startsOnPush(["on: [pull_request, push_tag]"])).toBe(false);
    expect(startsOnPush(["on:", "  workflow_call:"])).toBe(false);
    expect(runsOnMain(["on:", "  workflow_call:", "    inputs:"])).toBe(true);
    expect(runsOnMain(["on: [workflow_call]"])).toBe(true);
    expect(runsOnMain(["on: workflow_dispatch"])).toBe(false);
  });

  it("reports a push workflow that cancels a run in progress, and the fix cancels only a pull request run", () => {
    const root = fixture({
      "package.json": { name: "one" },
      ".github/workflows/ci.yml": flow(["on:", "  push:", "  pull_request:"], "true"),
      ".github/workflows/good.yml": flow(["on: [push, pull_request]"], PR),
      ".github/workflows/off.yml": flow(["on: push"], "false"),
      ".github/workflows/pr.yml": flow(["on: pull_request"], "true"),
      ".github/workflows/time-gate.yml": flow(["on:", "  workflow_call:", "  workflow_dispatch:"], "true"),
    });
    commitAll(root);
    expect(rule(root, "main-runs-finish").breaks.map((item) => `${item.file}:${String(item.line)}`)).toEqual([".github/workflows/ci.yml:6", ".github/workflows/time-gate.yml:6"]);
    const fixed = runFix({ root, only: ["main-runs-finish"] });
    expect(fixed.changed).toEqual([".github/workflows/ci.yml", ".github/workflows/time-gate.yml"]);
    expect(readFileSync(join(root, ".github/workflows/time-gate.yml"), "utf8")).toContain(`  cancel-in-progress: ${PR}
`);
    expect(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")).toContain(`  cancel-in-progress: ${PR}\n`);
    expect(rule(root, "main-runs-finish").breaks).toEqual([]);
  });

  it("reports a group that runs of main share, and the fix gives each commit its own group", () => {
    const shared = "${{ github.ref }}";
    const root = fixture({
      "package.json": { name: "one" },
      ".github/workflows/ci.yml": flow(["on: [push, pull_request]"], PR, shared),
      ".github/workflows/both.yml": flow(["on: push"], "true", shared),
      ".github/workflows/own.yml": flow(["on: [push, pull_request]"], PR),
      ".github/workflows/pr.yml": flow(["on: pull_request"], "true", shared),
      ".github/workflows/fixed-name.yml": flow(["on: push"], "false", "pages"),
    });
    commitAll(root);
    expect(rule(root, "main-runs-finish").breaks.map((item) => `${item.file}:${String(item.line)}`)).toEqual([".github/workflows/both.yml:3", ".github/workflows/both.yml:4", ".github/workflows/ci.yml:3"]);
    const fixed = runFix({ root, only: ["main-runs-finish"] });
    expect(fixed.changed).toEqual([".github/workflows/both.yml", ".github/workflows/ci.yml"]);
    expect(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")).toContain(`  group: ci-${OWN}\n`);
    expect(readFileSync(join(root, ".github/workflows/both.yml"), "utf8")).toContain(`  group: ci-${OWN}\n  cancel-in-progress: ${PR}\n`);
    expect(rule(root, "main-runs-finish").breaks).toEqual([]);
  });

  it("skips a repository with no push or called workflow", () => {
    const root = fixture({ "package.json": { name: "one" }, ".github/workflows/pr.yml": flow(["on: pull_request"], "true") });
    commitAll(root);
    expect(rule(root, "main-runs-finish")).toMatchObject({ status: "skipped", note: "no workflow starts on push or on workflow_call" });
  });
});

describe("published-minor", () => {
  const DAY = 86_400_000;
  const NOW = Date.parse("2026-11-04T00:00:00Z");
  const daysAgo = (days: number): string => new Date(NOW - days * DAY).toISOString();
  /** A fake registry. The key of `versions` is each published version, and the value is its age in days. */
  const registry = (versions: Record<string, number>, latest: string): RegistryLookup => (names) =>
    new Map(names.map((name): [string, RegistryAnswer] => [name, { versions: Object.keys(versions), times: Object.fromEntries(Object.entries(versions).map(([v, age]) => [v, daysAgo(age)])), latest }]));
  /** A package `consumer` with the dependency `@x/a` at `range`. */
  const repo = (range: string, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string =>
    workspace(
      { conventions: { rules: { "published-minor": { packages: ["@x/*"], reason: "this repository takes each minor", ...config } } } },
      { "packages/consumer/package.json": { name: "consumer", private: true, dependencies: { "@x/a": range, other: "^1.0.0" } }, ...extra },
    );
  const check = (root: string, lookup: RegistryLookup): RuleResult => rule(root, "published-minor", { rules: [publishedMinorRule(lookup, () => NOW)] });
  /** The lock text of the importer `packages/consumer`. */
  const lock = (version: string): string =>
    `lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  packages/consumer:\n    dependencies:\n      '@x/a':\n        specifier: ^1.2.0\n        version: ${version}\n\npackages:\n\n  '@x/a@9.9.9':\n    resolution: {integrity: x}\n`;

  it("reads the forms of a range", () => {
    expect(reachOf("^0.3.9")).toEqual([0, 3]);
    expect(reachOf("^0.0.3")).toEqual([0, 0]);
    expect(reachOf("^1.2.3")).toEqual([1, Number.POSITIVE_INFINITY]);
    expect(reachOf("~1.2.3")).toEqual([1, 2]);
    expect(reachOf("1.2.3")).toEqual([1, 2]);
    for (const form of ["workspace:*", "github:a/b#abc", "file:../a", "latest", "*", "^1", ">=1.0.0", "^1.0.0 || ^2.0.0"]) expect(reachOf(form), form).toBeUndefined();
  });

  it("reads a release version with its peer suffix, and no pre-release", () => {
    expect(minorOf("0.8.0")).toEqual([0, 8]);
    expect(minorOf("1.2.3(react@19.0.0)")).toEqual([1, 2]);
    expect(minorOf("1.2.0-rc.1")).toBeUndefined();
  });

  it("reads the versions of each importer, and no other section", () => {
    const locked = lockedVersions(lock("1.2.3").replace(/\n/g, "\r\n"));
    expect(locked.get("packages/consumer")?.get("@x/a")).toBe("1.2.3");
    expect(locked.get("")?.size).toBe(0);
    expect(locked.has("@x/a@9.9.9")).toBe(false);
  });

  it("does not start with no pattern, or with no dependency that a pattern names", () => {
    const root = workspace({}, { "packages/consumer/package.json": { name: "consumer", dependencies: { "@x/a": "^0.1.0" } } });
    expect(check(root, registry({ "0.2.0": 9 }, "0.2.0"))).toMatchObject({ status: "skipped", note: expect.stringContaining("names no package") });
    expect(check(repo("workspace:*"), registry({ "0.2.0": 9 }, "0.2.0"))).toMatchObject({ status: "skipped" });
  });

  it("breaks on a 0.x caret behind the next minor, at the line of the dependency", () => {
    const result = check(repo("^0.3.9"), registry({ "0.3.9": 90, "0.4.0": 9 }, "0.4.0"));
    expect(result.status).toBe("break");
    expect(result.breaks).toEqual([expect.objectContaining({ file: "packages/consumer/package.json", line: expect.any(Number), message: expect.stringContaining("cannot reach 0.4.0") })]);
  });

  it("passes at the current minor, with a patch that the range reaches", () => {
    expect(check(repo("^0.4.0"), registry({ "0.4.0": 90, "0.4.7": 1 }, "0.4.7")).status).toBe("pass");
  });

  it("breaks on a major ahead, on a tilde behind a minor and on an exact version behind a minor", () => {
    expect(check(repo("^1.2.0"), registry({ "2.0.0": 9 }, "2.0.0")).status).toBe("break");
    expect(check(repo("~1.2.0"), registry({ "1.3.0": 9 }, "1.3.0")).status).toBe("break");
    expect(check(repo("1.2.0"), registry({ "1.3.0": 9 }, "1.3.0")).status).toBe("break");
    expect(check(repo("1.3.0"), registry({ "1.3.1": 9 }, "1.3.1")).status).toBe("pass");
  });

  it("breaks on a lockfile behind a minor that the range reaches, and passes when it holds that minor", () => {
    const behind = check(repo("^1.2.0", {}, { "pnpm-lock.yaml": lock("1.2.3") }), registry({ "1.2.3": 90, "1.5.0": 9 }, "1.5.0"));
    expect(behind.status).toBe("break");
    expect(behind.breaks?.[0]?.message).toContain("the lockfile holds 1.2.3");
    expect(check(repo("^1.2.0", {}, { "pnpm-lock.yaml": lock("1.5.0(peer@1.0.0)") }), registry({ "1.5.0": 9 }, "1.5.0")).status).toBe("pass");
  });

  it("gives a consumer the grace days, from the first minor that it does not have", () => {
    const grace = { graceDays: 7 };
    expect(check(repo("^0.3.0", grace), registry({ "0.4.0": 6 }, "0.4.0")).status).toBe("pass");
    expect(check(repo("^0.3.0", grace), registry({ "0.4.0": 8 }, "0.4.0")).status).toBe("break");
    // A new patch does not start the days again
    expect(check(repo("^0.3.0", grace), registry({ "0.3.5": 80, "0.4.0": 30, "0.4.1": 1 }, "0.4.1")).status).toBe("break");
  });

  it("does not ask the registry for a name that no pattern names", () => {
    const asked: string[] = [];
    const lookup: RegistryLookup = (names) => {
      asked.push(...names);
      return new Map(names.map((name): [string, RegistryAnswer] => [name, { versions: [] }]));
    };
    expect(check(repo("^1.0.0"), lookup).status).toBe("pass");
    expect(asked).toEqual(["@x/a"]);
  });

  it("does not start when the registry does not answer, and tells why", () => {
    const lookup: RegistryLookup = (names) => new Map(names.map((name): [string, RegistryAnswer] => [name, { error: "HTTP 503" }]));
    expect(check(repo("^0.1.0"), lookup)).toMatchObject({ status: "skipped", note: expect.stringContaining("HTTP 503") });
  });
});
