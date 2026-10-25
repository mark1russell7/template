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
 * This function gives the folder of this CLI: the nearest folder with the `package.json` of the CLI,
 * from the folder of this module up. It is the same folder for the source in the workspace and for
 * the build in `node_modules`.
 */
export function cliRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = resolve(dir, "package.json");
    if (existsSync(file) && (JSON.parse(readFileSync(file, "utf8")) as Manifest).name === CLI_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** This function gives the `package.json` of this CLI, from the folder of the CLI (`cliRoot`). */
export function cliManifest(): Manifest {
  const root = cliRoot();
  return root === undefined ? {} : (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as Manifest);
}

/**
 * This function gives the folder of the files of a preset: `src/presets/<folder>` in the folder of the CLI.
 * The npm package of the CLI has the same folder.
 *
 * @throws Error when the folder of the CLI or of the preset is not found
 */
export function presetDir(folder: string): string {
  const root = cliRoot();
  const dir = root === undefined ? undefined : resolve(root, "src", "presets", folder);
  if (dir === undefined || !existsSync(dir)) throw new Error(`The files of the preset "${folder}" are not in ${CLI_NAME}.`);
  return dir;
}
