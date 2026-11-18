// Tests the committed bundles of .github/actions/bundles (tsdown.actions.config.ts of the package conventions). Each
// import of a bundle is a module of Node.js, so a step that runs a bundle runs no code of an installed dependency. Each
// bundle that an action or a workflow names is in the folder. The bundle of the action select writes a record on a
// fixture repository. scripts/workflows/private-names.test.ts starts the bundle private-names.mjs. The library bundle
// files.mjs has its types in files.d.mts. The script check:actions examines that each bundle is current.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const actions = import.meta.dirname;
const folder = join(actions, "bundles");
const bundles = readdirSync(folder).filter((name) => name.endsWith(".mjs"));

/** The module specifiers of a bundle: static imports and exports, dynamic imports and calls of require. */
export function specifiers(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /^\s*(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.push(match[1] ?? "");
  return found;
}

describe("the bundles of the shared actions", () => {
  it("has a bundle", () => {
    assert.ok(bundles.length > 0, "The folder .github/actions/bundles has no bundle");
  });

  for (const name of bundles) {
    it(`${name} imports only modules of Node.js`, () => {
      const text = readFileSync(join(folder, name), "utf8");
      const outside = specifiers(text).filter((spec) => !isBuiltin(spec));
      assert.deepEqual(outside, [], `${name} imports a module that is not a module of Node.js`);
      assert.ok(!/\bcreateRequire\b/.test(text), `${name} makes a require function, which can load an installed package`);
    });
  }

  it("finds the specifiers of each form, so that the test above can fail", () => {
    const text = 'import { a } from "node:fs";\nexport { b } from "yaml";\nimport "side";\nconst c = await import("dyn");\nconst d = require("cjs");\n';
    assert.deepEqual(specifiers(text).sort(), ["cjs", "dyn", "node:fs", "side", "yaml"]);
  });

  it("has each bundle that an action names", () => {
    for (const action of readdirSync(actions, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const file = join(actions, action.name, "action.yml");
      if (!existsSync(file)) continue;
      for (const match of readFileSync(file, "utf8").matchAll(/\.\.\/bundles\/([\w-]+\.mjs)/g)) {
        assert.ok(bundles.includes(match[1] ?? ""), `${action.name}/action.yml names ${match[1] ?? ""}, which is not in .github/actions/bundles`);
      }
    }
  });

  it("has each bundle that a script of an action imports, and the types of each library bundle", () => {
    const scripts = readdirSync(actions, { recursive: true, encoding: "utf8" }).filter((path) => path.endsWith(".ts") && !path.startsWith("bundles"));
    let imports = 0;
    for (const path of scripts) {
      for (const match of readFileSync(join(actions, path), "utf8").matchAll(/from "\.\.\/bundles\/([\w-]+)\.mjs"/g)) {
        imports++;
        const name = match[1] ?? "";
        assert.ok(bundles.includes(`${name}.mjs`), `${path} imports ${name}.mjs, which is not in .github/actions/bundles`);
        assert.ok(existsSync(join(folder, `${name}.d.mts`)), `${path} imports ${name}.mjs, which has no ${name}.d.mts`);
      }
    }
    assert.ok(imports > 0, "No script of an action imports a bundle, so the test above reads nothing");
  });

  it("has each bundle that a workflow names", () => {
    const workflows = join(actions, "..", "workflows");
    for (const name of readdirSync(workflows).filter((file) => file.endsWith(".yml"))) {
      for (const match of readFileSync(join(workflows, name), "utf8").matchAll(/actions\/bundles\/([\w-]+\.mjs)/g)) {
        assert.ok(bundles.includes(match[1] ?? ""), `${name} names ${match[1] ?? ""}, which is not in .github/actions/bundles`);
      }
    }
  });
});

describe("the bundle select.mjs", () => {
  const gitIn = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
  const write = (root: string, files: Record<string, string>): void => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  };

  it("writes the record of the merge commit of a pull request, and the summary, with no install", () => {
    const temp = mkdtempSync(join(tmpdir(), "bundle-select-"));
    try {
      const repo = join(temp, "repo");
      mkdirSync(repo);
      gitIn(repo, "init", "-q", "-b", "main");
      write(repo, {
        "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
        "package.json": JSON.stringify({ name: "root", private: true }),
        "packages/core/package.json": JSON.stringify({ name: "@x/core", version: "1.0.0" }),
        "packages/core/src/index.ts": "export const a = 1;\n",
        "packages/app/package.json": JSON.stringify({ name: "@x/app", version: "1.0.0", dependencies: { "@x/core": "workspace:*" } }),
      });
      gitIn(repo, "add", "-A");
      gitIn(repo, "commit", "-q", "-m", "base");
      gitIn(repo, "switch", "-q", "-c", "change");
      write(repo, { "packages/core/src/index.ts": "export const a = 2;\n" });
      gitIn(repo, "commit", "-q", "-am", "change");
      gitIn(repo, "switch", "-q", "main");
      gitIn(repo, "merge", "-q", "--no-ff", "-m", "merge", "change");
      const out = join(temp, "out", "selection.json");
      const summary = join(temp, "summary.md");
      const result = spawnSync(process.execPath, [join(folder, "select.mjs")], {
        cwd: repo,
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "", SYSTEMROOT: process.env["SYSTEMROOT"] ?? "", OUT: out, GITHUB_STEP_SUMMARY: summary, SELECTOR_REF: "test" },
      });
      assert.equal(result.status, 0, result.stderr);
      const record = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
      assert.equal(record["format"], "selection/1");
      assert.equal(record["noRead"], undefined, JSON.stringify(record));
      assert.equal(record["ref"], "test");
      assert.equal(typeof record["durationMs"], "number");
      assert.deepEqual((record["packages"] as { affected: unknown }).affected, [
        { id: "packages/app", via: "packages/core" },
        { id: "packages/core", via: "changed" },
      ]);
      assert.match(readFileSync(summary, "utf8"), /shadow mode/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe("the library bundle files.mjs", () => {
  it("gives the glob functions of @mark1russell7/files, with the types of each export", async () => {
    const files = (await import(pathToFileURL(join(folder, "files.mjs")).href)) as {
      globToRegExp: (glob: string) => RegExp;
      matchesGlob: (path: string, glob: string) => boolean;
    };
    assert.ok(files.globToRegExp("**/test/**").test("packages/a/test/x.ts"));
    assert.ok(files.globToRegExp("{apps,libs}/[ab].ts").test("libs/b.ts"));
    assert.ok(!files.matchesGlob("packages/a/b", "packages/*"));
    const types = readFileSync(join(folder, "files.d.mts"), "utf8");
    for (const name of Object.keys(files)) assert.match(types, new RegExp(`export declare function ${name}\\(`), `files.d.mts has no type of ${name}`);
  });
});
