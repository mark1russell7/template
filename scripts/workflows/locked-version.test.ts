// Tests of scripts/workflows/locked-version.ts (CI.md, "The packages of the workflow scripts"). Start them with
// "pnpm test:workflows". The tests read the lockfile and the workflows of the template, and use no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { lockedVersion } from "./locked-version.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

/** A lockfile of pnpm 12: the first document has no packages of the root, the second one has them. */
const lock = [
  "---",
  "lockfileVersion: '9.0'",
  "",
  "importers:",
  "",
  "  .:",
  "    configDependencies: {}",
  "",
  "packages: {}",
  "",
  "---",
  "lockfileVersion: '9.0'",
  "",
  "importers:",
  "",
  "  .:",
  "    devDependencies:",
  "      '@scope/name':",
  "        specifier: ^0.0.7",
  "        version: 0.0.7",
  "      plain:",
  "        specifier: ^2.1.0",
  "        version: 2.1.3(typescript@6.0.2)",
  "",
  "  packages/inner:",
  "    dependencies:",
  "      inner-only:",
  "        specifier: ^1.0.0",
  "        version: 1.0.0",
  "",
  "packages:",
  "",
  "  '@scope/name@0.0.7':",
  "    resolution: {integrity: sha512-x}",
  "",
  "snapshots:",
  "",
  "  plain@2.1.3(typescript@6.0.2):",
  "    dependencies:",
  "      snapshot-only: 3.0.0",
  "",
].join("\n");

describe("lockedVersion", () => {
  it("gives the version of the root importer, from the second document of a lockfile of pnpm 12", () => {
    assert.equal(lockedVersion(lock, "@scope/name"), "0.0.7");
  });

  it("reads a key with no quotes, and leaves out the peer suffix of the version", () => {
    assert.equal(lockedVersion(lock, "plain"), "2.1.3");
  });

  it("gives undefined for a package of another importer, of the snapshots only, or of no part of the file", () => {
    for (const name of ["inner-only", "snapshot-only", "absent", "@scope"]) assert.equal(lockedVersion(lock, name), undefined, name);
  });

  it("reads a lockfile with Windows line ends", () => {
    assert.equal(lockedVersion(lock.replaceAll("\n", "\r\n"), "@scope/name"), "0.0.7");
  });

  it("reads the version of @mark1russell7/text in the lockfile of the template", () => {
    const version = lockedVersion(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"), "@mark1russell7/text");
    assert.match(version ?? "", /^\d+\.\d+\.\d+$/);
  });
});

describe("the command", () => {
  const script = join(here, "locked-version.ts");
  const start = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  it("writes the version and a line end, and exits with code 1 for a package that the root does not have", () => {
    const dir = mkdtempSync(join(tmpdir(), "locked-version-"));
    try {
      const file = join(dir, "pnpm-lock.yaml");
      writeFileSync(file, lock);
      const found = start(file, "@scope/name");
      assert.equal(found.status, 0, found.stderr);
      assert.equal(found.stdout, "0.0.7\n");
      const missing = start(file, "inner-only");
      assert.equal(missing.status, 1);
      assert.equal(missing.stdout, "");
      assert.match(missing.stderr, /resolves no inner-only for the root package/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits with code 2 for a wrong command", () => {
    assert.equal(start().status, 2);
    assert.equal(start("a", "b", "c").status, 2);
  });
});

describe("the installs of the workflows", () => {
  /** This function gives each workflow file and each action file of the template, with its text. */
  const files = (): [string, string][] => {
    const workflows = readdirSync(join(root, ".github/workflows")).filter((name) => /\.ya?ml$/.test(name)).map((name) => `.github/workflows/${name}`);
    const actions = readdirSync(join(root, ".github/actions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => ["action.yml", "action.yaml"].map((name) => `.github/actions/${entry.name}/${name}`))
      .filter((path) => existsSync(join(root, path)));
    return [...workflows, ...actions].map((path) => [path, readFileSync(join(root, path), "utf8")]);
  };

  it("install no package of the lockfile at a version in the text of the workflow", () => {
    const text = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    const pinned: string[] = [];
    for (const [path, workflow] of files()) {
      for (const [index, line] of workflow.split(/\r?\n/).entries()) {
        if (!/\bnpm (install|i)\b/.test(line)) continue;
        for (const token of line.split(/\s+/).map((part) => part.replace(/^["']|["']$/g, ""))) {
          // A package spec: name@range, or @scope/name@range. A range that starts with "$" comes from a variable
          const spec = /^((?:@[^/@\s]+\/)?[^@\s/$-][^@\s]*)@([^@\s]+)$/.exec(token);
          if (spec === null || (spec[2] ?? "").startsWith("$")) continue;
          if (lockedVersion(text, spec[1] ?? "") !== undefined) pinned.push(`${path}:${String(index + 1)}: ${token}`);
        }
      }
    }
    assert.deepEqual(pinned, [], "Read the version with scripts/workflows/locked-version.ts, as reusable-queue.yml does");
  });

  it("read the version of @mark1russell7/text with locked-version.ts before each install of it", () => {
    let installs = 0;
    for (const [path, workflow] of files()) {
      const lines = workflow.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (!/\bnpm (install|i)\b.*"@mark1russell7\/text@\$\{version\}"/.test(line)) continue;
        installs += 1;
        assert.match(lines[index - 1] ?? "", /^\s*version="\$\(node \S*locked-version\.ts"? \S*pnpm-lock\.yaml"? @mark1russell7\/text\)"$/, `${path}:${String(index + 1)}`);
      }
    }
    assert.ok(installs >= 2, "the queue and the action pull-of-run install @mark1russell7/text");
  });
});
