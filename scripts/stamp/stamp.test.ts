import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { minuteField, scheduleMinute } from "../../packages/conventions/src/rules/runner-budget.ts";
import { parseRoadmap } from "../../packages/site-pages/src/index.ts";
import { checkStamp, firstRoadmap, pinWorkflow, type RootManifest, rootScripts, stamp, workflowShape } from "./stamp.ts";

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

  it("keeps check:api, because the check passes a repository of private packages", async () => {
    const { out } = await stamped();
    const root = JSON.parse(read(out, "package.json")) as { scripts: Record<string, string> };
    assert.equal(root.scripts["check:api"], "api-report check");
  });

  it("sets each schedule to the minute of the new repository", async () => {
    const { out } = await stamped();
    const pages = read(out, ".github/workflows/pages.yml");
    const minute = scheduleMinute("mark1russell7/demo-repo", ".github/workflows/pages.yml");
    assert.match(pages, new RegExp(`cron: "${minuteField(minute, 1)} `));
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

  it("gives a security workflow that also passes in a private repository: the pinned action, and no checkout of the template", async () => {
    const { out, sha } = await stamped();
    const security = read(out, ".github/workflows/security.yml");
    assert.ok(security.includes(`uses: mark1russell7/template/.github/actions/security-scan@${sha} # main`));
    // A sparse checkout before the action leaves a partial clone, and in a private repository the checkout of the base then fails
    for (const each of security.split(/\n {6}- /).filter((text) => text.includes("sparse-checkout:"))) {
      assert.match(each, /^if: github\.repository == 'mark1russell7\/template'\n/);
    }
    // The action chooses the scans: "auto" skips the parts that need GitHub Advanced Security in a private repository
    assert.doesNotMatch(security, /\b(dependency-review|codeql|osv-upload): /);
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
      "check:api": "api-report check",
      typecheck: "pnpm -r run typecheck",
      package: "tsx packages/cli/src/index.ts package",
    });
    assert.deepEqual(scripts, { test: "pnpm -r run test", "check:api": "api-report check", typecheck: "pnpm -r run typecheck", package: "template package", template: "template repo" });
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

describe("checkStamp", () => {
  const states = (out: string): Record<string, string> =>
    Object.fromEntries(checkStamp({ repo: out, template, ref: "HEAD" }).files.filter((file) => file.state !== "same").map((file) => [file.path, file.state]));

  it("finds no change in a repository that the stamp made at the same commit", async () => {
    const { out } = await stamped();
    assert.deepEqual(states(out), {});
  });

  it("does not count the parts that the stamp sets for each repository, or what the repository adds", async () => {
    const { out } = await stamped();
    const ci = join(out, ".github/workflows/ci.yml");
    writeFileSync(ci, read(out, ".github/workflows/ci.yml").replace(/@[0-9a-f]{40} # main/g, `@${"c".repeat(40)} # main`).replace(/\n/g, "\r\n"));
    const root = JSON.parse(read(out, "package.json")) as RootManifest;
    root.name = "other-monorepo";
    root.scripts["own"] = "node own.ts";
    root.devDependencies["playwright"] = "^1.56.1";
    for (const dep of Object.keys(root.devDependencies)) if (root.devDependencies[dep] === "^9.8.7") root.devDependencies[dep] = "^0.1.0";
    writeFileSync(join(out, "package.json"), `${JSON.stringify(root, null, 2)}\n`);
    assert.deepEqual(states(out), {});
  });

  it("finds a changed text, a missing file and a package.json field that the stamp would change", async () => {
    const { out } = await stamped();
    writeFileSync(join(out, "CLAUDE.md"), `${read(out, "CLAUDE.md")}\nOne more line.\n`);
    rmSync(join(out, "LICENSE"));
    const root = JSON.parse(read(out, "package.json")) as RootManifest;
    delete root.scripts["typecheck"];
    root.devDependencies["@mark1russell7/conventions"] = "workspace:*";
    writeFileSync(join(out, "package.json"), `${JSON.stringify(root, null, 2)}\n`);
    assert.deepEqual(states(out), { "CLAUDE.md": "differs", LICENSE: "missing", "package.json": "differs" });
    const manifest = checkStamp({ repo: out, template, ref: "HEAD" }).files.find((file) => file.path === "package.json");
    assert.deepEqual(manifest?.fields, ["scripts.typecheck", "devDependencies.@mark1russell7/conventions"]);
  });
});

describe("workflowShape", () => {
  it("removes the commit of each pin and the minute of each schedule", () => {
    const a = `on:\n  schedule:\n    - cron: "17 6 * * 1"\njobs:\n  ci:\n    uses: ./.github/workflows/reusable-ci.yml\n`;
    const b = `on:\n  schedule:\n    - cron: "42 6 * * 1"\njobs:\n  ci:\n    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@${"d".repeat(40)} # main\n`;
    assert.equal(workflowShape(a), workflowShape(b));
    assert.notEqual(workflowShape(a), workflowShape(b.replace("6 * * 1", "7 * * 1")));
  });
});

describe("firstRoadmap", () => {
  it("has one row", () => {
    assert.equal(parseRoadmap(firstRoadmap("demo")).length, 1);
  });
});
