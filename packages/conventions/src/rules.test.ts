// Each rule on fixture repositories: a case that passes and a case that breaks.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { convertGate, hasTests, isGitSpecifier, isPinned, isSourcePath, parseJsonc, prPathFilters, repositoryOfRemote, roadmapOfLine, runChecks, runFix, scheduleMinute, summaryName, type CheckOptions, type RuleResult } from "./index.ts";
import { minuteField } from "./rules/runner-budget.ts";

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
  const preset = { compilerOptions: { strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: false } };

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
        "packages/b/tsconfig.test.json": { extends: "./tsconfig.json", compilerOptions: { strictNullChecks: false, noUncheckedIndexedAccess: false } },
      },
    );
    expect(rule(root, "cue-preset").breaks.map((item) => `${item.file}: ${item.message}`)).toEqual([
      "packages/a/tsconfig.json: tsconfig.json does not extend a preset of @mark1russell7/cue.",
      "packages/b/tsconfig.test.json: tsconfig.test.json turns off the strict option strictNullChecks.",
      "packages/b/tsconfig.test.json: tsconfig.test.json turns off the strict option noUncheckedIndexedAccess.",
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
      "    if: always()",
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
    expect(converted.text).toContain("    concurrency:\n      group: ${{ github.workflow }}-changes-${{ github.ref }}\n");
    expect(converted.text).toContain("    concurrency:\n      group: ${{ github.workflow }}-text-bench-ok-${{ github.ref }}\n");
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
