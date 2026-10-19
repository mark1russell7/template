import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The npm name of this CLI. */
export const CLI_NAME = "@mark1russell7/template-cli";

/**
 * This function finds the root of the repository: the nearest folder with a `pnpm-workspace.yaml`,
 * from `start` up. The CLI operates in the repository that calls it, so the start is the working folder.
 *
 * @throws Error when no folder from `start` up has a `pnpm-workspace.yaml`
 */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No pnpm-workspace.yaml in ${resolve(start)} or above it. Start the CLI in a template repository.`);
    dir = parent;
  }
}

/** This function gives the root of the repository of the working folder. */
export function repoRoot(): string {
  return findRepoRoot();
}

/** This function gives the folder of the packages of the repository of the working folder. */
export function packagesDir(): string {
  return resolve(repoRoot(), "packages");
}

/** The fields of a `package.json` that the CLI reads. */
export interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * This function gives the `package.json` of this CLI: the nearest one with the name of the CLI, from
 * the folder of this module up. It is the same file for the source in the workspace and for the
 * build in `node_modules`.
 */
export function cliManifest(): Manifest {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = resolve(dir, "package.json");
    if (existsSync(file)) {
      const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
      if (manifest.name === CLI_NAME) return manifest;
    }
    const parent = dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}
