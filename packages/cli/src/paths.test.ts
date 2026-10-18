import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_NAME, cliManifest, findRepoRoot } from "./paths.ts";
import { devDependencyVersions } from "./commands/package/add.ts";

/** A repository in a new temporary folder: the workspace file, the root manifest and package manifests. */
function repo(root: object, packages: Record<string, object> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "template-cli-"));
  writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeFileSync(join(dir, "package.json"), JSON.stringify(root));
  for (const [name, manifest] of Object.entries(packages)) {
    mkdirSync(join(dir, "packages", name), { recursive: true });
    writeFileSync(join(dir, "packages", name, "package.json"), JSON.stringify(manifest));
  }
  return dir;
}

describe("findRepoRoot", () => {
  it("finds the nearest folder with pnpm-workspace.yaml, from a folder in the repository", () => {
    const dir = repo({ name: "demo-monorepo" }, { a: { name: "@demo/a" } });
    expect(findRepoRoot(join(dir, "packages", "a"))).toBe(dir);
    expect(findRepoRoot(dir)).toBe(dir);
  });

  it("refuses a folder outside a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "template-cli-none-"));
    expect(() => findRepoRoot(dir)).toThrow(/No pnpm-workspace.yaml/);
  });
});

describe("cliManifest", () => {
  it("gives the package.json of the CLI", () => {
    const manifest = cliManifest();
    expect(manifest.name).toBe(CLI_NAME);
    expect(manifest.devDependencies?.["typescript"]).toBeDefined();
  });
});

describe("devDependencyVersions", () => {
  const cli = { name: CLI_NAME, devDependencies: { "@mark1russell7/cue": "^1.0.0", "@types/node": "^26.0.0", typescript: "^7.0.0", vitest: "^5.0.0" } };

  it("takes each range from the repository first: the root, then the packages in name order", async () => {
    const dir = repo(
      { name: "demo-monorepo", devDependencies: { typescript: "^6.0.0" } },
      { b: { devDependencies: { vitest: "^4.1.0" } }, a: { devDependencies: { vitest: "^4.0.0", "@types/node": "^24.0.0" } } },
    );
    expect(await devDependencyVersions(dir, cli)).toEqual({
      "@mark1russell7/cue": "^1.0.0",
      "@types/node": "^24.0.0",
      typescript: "^6.0.0",
      vitest: "^4.0.0",
    });
  });

  it("refuses a dependency that neither the repository nor the CLI has", async () => {
    const dir = repo({ name: "demo-monorepo" });
    await expect(devDependencyVersions(dir, { name: CLI_NAME, devDependencies: {} })).rejects.toThrow(/has the dependency/);
  });
});
