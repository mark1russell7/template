import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseRoadmap } from "../../packages/site-pages/src/index.ts";
import { firstRoadmap, pinWorkflow, rootScripts, stamp } from "./stamp.ts";

const template = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** This function makes a repository in a new folder, with made-up versions from npm. */
async function stamped(npm?: string): Promise<{ out: string; sha: string }> {
  const out = join(mkdtempSync(join(tmpdir(), "stamp-")), "demo-repo");
  const sha = await stamp({ name: "demo-repo", description: "One <line> of text.", npm, template, out, ref: "HEAD", latest: () => "9.8.7" });
  return { out, sha };
}

const read = (out: string, path: string): string => readFileSync(join(out, path), "utf8");

describe("the stamp", () => {
  it("gives the repository its own site, not the site of the template", async () => {
    const { out } = await stamped();
    const home = read(out, "packages/site/index.html");
    assert.match(home, /<title>demo-repo<\/title>/);
    assert.match(home, /One &lt;line&gt; of text\./);
    assert.match(home, /git clone https:\/\/github\.com\/mark1russell7\/demo-repo\.git/);
    assert.equal(existsSync(join(out, "packages/site/src/check-probe.ts")), false);
    assert.deepEqual(readdirSync(join(out, "packages")), ["site"]);
  });

  it("gives the install command when the repository has a package name", async () => {
    const { out } = await stamped("@mark1russell7/demo");
    assert.match(read(out, "packages/site/index.html"), /pnpm add @mark1russell7\/demo/);
    assert.match(read(out, ".github/workflows/pages.yml"), /packages: "@mark1russell7\/demo"/);
  });

  it("names the site in the Pages workflow and pins the shared workflow", async () => {
    const { out, sha } = await stamped();
    const pages = read(out, ".github/workflows/pages.yml");
    assert.match(pages, /build: pnpm --filter @demo-repo\/site run build/);
    assert.match(pages, /out: packages\/site\/dist/);
    assert.ok(pages.includes(`reusable-pages.yml@${sha} # main`));
    assert.doesNotMatch(pages, /@template\/site|site-name: Template|\{\{\w+\}\}/);
  });

  it("leaves no range of a package that the repository does not have", async () => {
    const { out } = await stamped();
    for (const path of ["package.json", "packages/site/package.json"]) assert.doesNotMatch(read(out, path), /workspace:/);
    const root = JSON.parse(read(out, "package.json")) as { name: string; devDependencies: Record<string, string> };
    assert.equal(root.name, "demo-repo-monorepo");
    assert.equal(root.devDependencies["@mark1russell7/conventions"], "^9.8.7");
    assert.equal(root.devDependencies["@mark1russell7/template-cli"], "^9.8.7");
  });

  it("gives a roadmap that the Status page reads", async () => {
    const { out } = await stamped();
    assert.equal(parseRoadmap(read(out, "docs/ROADMAP.md")).length, 1);
  });

  it("copies no folder that only the template needs", async () => {
    const { out } = await stamped();
    for (const path of ["scripts", "renovate", ".github/actions", ".github/workflows/site-audit.yml", ".github/workflows/actions-test.yml", "pnpm-lock.yaml"]) {
      assert.equal(existsSync(join(out, path)), false, path);
    }
    assert.deepEqual(
      readdirSync(join(out, ".github/workflows")).filter((file) => file.startsWith("reusable-")),
      [],
    );
  });

  it("stops when the folder exists", async () => {
    const { out } = await stamped();
    await assert.rejects(stamp({ name: "demo-repo", description: "x", template, out, ref: "HEAD", latest: () => "1.0.0" }), /The folder exists/);
  });
});

describe("rootScripts", () => {
  it("removes a script that names a path of the template, and each call of it", () => {
    const scripts = rootScripts({
      test: "pnpm -r run test && pnpm run test:homes && pnpm run test:actions",
      "test:homes": 'node --test "scripts/homes/*.test.ts"',
      "test:actions": 'node --test ".github/actions/*.test.ts"',
      "homes:exports": "node scripts/homes/exports.ts",
      typecheck: "pnpm -r run typecheck",
      package: "tsx packages/cli/src/index.ts package",
    });
    assert.deepEqual(scripts, { test: "pnpm -r run test", typecheck: "pnpm -r run typecheck", package: "template package", template: "template repo" });
  });
});

describe("pinWorkflow", () => {
  it("pins a local path and moves an old pin", () => {
    const sha = "a".repeat(40);
    const old = "b".repeat(40);
    const text = `      - uses: ./.github/actions/setup\n    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@${old} # main\n    # uses: ./.github/actions/not-this\n`;
    assert.equal(
      pinWorkflow(text, sha),
      `      - uses: mark1russell7/template/.github/actions/setup@${sha} # main\n    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@${sha} # main\n    # uses: ./.github/actions/not-this\n`,
    );
  });
});

describe("firstRoadmap", () => {
  it("has one row", () => {
    assert.equal(parseRoadmap(firstRoadmap("demo")).length, 1);
  });
});
