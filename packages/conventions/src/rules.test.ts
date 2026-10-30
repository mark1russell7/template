// Each rule on fixture repositories: a case that passes and a case that breaks.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hasTests, isGitSpecifier, isPinned, isSourcePath, parseJsonc, runChecks, type CheckOptions, type RuleResult } from "./index.ts";

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
