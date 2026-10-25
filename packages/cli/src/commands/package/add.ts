import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import { cliManifest, presetDir, repoRoot, type Manifest } from "../../paths.ts";

async function getScope(root: string): Promise<string> {
  const raw = await readFile(resolve(root, "package.json"), "utf8");
  const pkg = JSON.parse(raw) as { name?: string };
  const name = pkg.name ?? "";
  return name.endsWith("-monorepo") ? name.slice(0, -"-monorepo".length) : name;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const DEV_DEPENDENCIES = ["@mark1russell7/cue", "@types/node", "typescript", "vitest"] as const;

/**
 * This function gives the version range of each named dependency of a new package. The range comes
 * from the repository: the root `package.json`, then the packages in name order. Thus
 * `pnpm up -r --latest` in the repository also updates the ranges of its new packages. A dependency
 * that the repository does not have gets the range of this CLI.
 *
 * @throws Error when neither the repository nor the CLI has a dependency
 */
export async function dependencyVersions(
  names: readonly string[],
  root: string = repoRoot(),
  cli: Manifest = cliManifest(),
): Promise<Record<string, string>> {
  const manifests: Manifest[] = [];
  const read = async (file: string): Promise<void> => {
    if (existsSync(file)) manifests.push(JSON.parse(await readFile(file, "utf8")) as Manifest);
  };
  await read(resolve(root, "package.json"));
  const dir = resolve(root, "packages");
  if (existsSync(dir)) {
    const folders = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    for (const folder of folders) await read(resolve(dir, folder, "package.json"));
  }
  manifests.push(cli);
  const versions: Record<string, string> = {};
  for (const dep of names) {
    const version = manifests.map((m) => m.devDependencies?.[dep] ?? m.dependencies?.[dep]).find((v) => v !== undefined);
    if (!version) throw new Error(`Neither the repository nor ${cli.name ?? "the CLI"} has the dependency "${dep}".`);
    versions[dep] = version;
  }
  return versions;
}

/** This function gives the version range of each development dependency of a new package (`dependencyVersions`). */
export async function devDependencyVersions(root: string = repoRoot(), cli: Manifest = cliManifest()): Promise<Record<string, string>> {
  return dependencyVersions(DEV_DEPENDENCIES, root, cli);
}

/** A base config of `@mark1russell7/cue`: the `tsconfig.json` of a package extends `@mark1russell7/cue/ts/config/<name>.json`. */
type CueConfig = "node" | "node-cjs" | "ts" | "vite" | "react";

/** The name of a preset: the value of `--preset`. */
export type PresetName = "node" | "node-cjs" | "ts" | "vite" | "react" | "service";

/** A preset of a new package, as data. */
export interface Preset {
  /** This text tells what the preset is for, in the prompt. */
  readonly label: string;
  /** The `tsconfig.json` of the package extends this base config of `@mark1russell7/cue`. */
  readonly tsconfig: CueConfig;
  /** These dependencies get the range of the repository, or else the range of this CLI (`dependencyVersions`). */
  readonly dependencies?: readonly string[];
  /** `pnpm add` gives these packages their newest version, and it installs the workspace. */
  readonly install?: { readonly dependencies: readonly string[]; readonly devDependencies: readonly string[] };
  /** These scripts go in the `package.json` of the package, after the scripts of each package. */
  readonly scripts?: Readonly<Record<string, string>>;
  /**
   * This folder of `src/presets` has the files of the package, at their paths in the package. The
   * CLI replaces `{{name}}`, `{{scope}}` and `{{package}}` in each file. Without a folder, the
   * package gets an empty `src/index.ts`.
   */
  readonly files?: string;
}

/** These are the presets of `pnpm package add`, by name. */
export const PRESETS: Readonly<Record<PresetName, Preset>> = {
  node: { label: "node — Node.js library/CLI (ESM, NodeNext)", tsconfig: "node" },
  "node-cjs": { label: "node-cjs — Node.js library (CJS)", tsconfig: "node-cjs" },
  ts: { label: "ts — generic TS library (ESM)", tsconfig: "ts" },
  // The vite and react presets reference types (vite/client, react-jsx) that only these packages provide.
  vite: { label: "vite — browser/bundler (Vite)", tsconfig: "vite", install: { dependencies: [], devDependencies: ["vite"] } },
  react: {
    label: "react — React + Vite",
    tsconfig: "react",
    install: { dependencies: ["react", "react-dom"], devDependencies: ["vite", "@vitejs/plugin-react", "@types/react", "@types/react-dom"] },
  },
  // A server on the one service runner: a component, a declaration, and an entry that alone uses run().
  service: {
    label: "service — HTTP server on @mark1russell7/service",
    tsconfig: "node",
    dependencies: ["@mark1russell7/service"],
    scripts: { start: "node src/main.ts" },
    files: "service",
  },
};

const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

const isPresetName = (value: string): value is PresetName => (PRESET_NAMES as string[]).includes(value);

// The library presets emit declarations; the vite and react presets bundle and emit nothing.
const LIBRARY_CONFIGS: readonly CueConfig[] = ["node", "node-cjs", "ts"];

// A workspace package is a source package: "main" points at src/index.ts, so other packages import its source.
// Such a package cannot be a composite project (TS6059, TS6307), so composite and incremental are off.
// The library presets emit only declarations, because isolatedDeclarations is checked only when tsc emits them.
function tsconfigOptions(config: CueConfig): Record<string, unknown> {
  const shared = { allowImportingTsExtensions: true, composite: false, incremental: false };
  if (LIBRARY_CONFIGS.includes(config)) return { noEmit: false, emitDeclarationOnly: true, ...shared };
  return { noEmit: true, ...shared, isolatedDeclarations: false, declaration: false, declarationMap: false, types: ["vite/client"] };
}

// The base presets exclude *.test.ts, so tests get their own config, and "typecheck" checks both.
function testTsconfig(config: CueConfig): Record<string, unknown> {
  return {
    $schema: "https://json.schemastore.org/tsconfig",
    extends: "./tsconfig.json",
    compilerOptions: {
      noEmit: true,
      emitDeclarationOnly: false,
      declaration: false,
      declarationMap: false,
      isolatedDeclarations: false,
      types: LIBRARY_CONFIGS.includes(config) ? ["node"] : ["vite/client", "node"],
    },
    include: ["src/**/*"],
    exclude: [],
  };
}

/** This function gives the path of each file in a folder and its subfolders, relative to the folder. */
async function filesOf(dir: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(resolve(dir, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await filesOf(dir, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function parseArgs(args: string[]): { name: string | undefined; preset: PresetName | undefined } {
  let name: string | undefined;
  let preset: PresetName | undefined;
  for (const a of args) {
    if (a.startsWith("--preset=")) {
      const v = a.slice("--preset=".length);
      if (!isPresetName(v)) {
        throw new Error(`Unknown --preset "${v}". Allowed: ${PRESET_NAMES.join(", ")}`);
      }
      preset = v;
    } else if (!name) {
      name = a;
    }
  }
  return { name, preset };
}

/** The result of `writePackage`: the folder of the new package and the `pnpm add` commands that its preset needs. */
export interface WrittenPackage {
  readonly dir: string;
  readonly name: string;
  readonly install: readonly string[];
}

/**
 * This function writes the folder `packages/<name>` of a new package of a preset in a repository.
 * It writes `package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts` and the files
 * of the preset. It installs nothing: it gives the `pnpm add` commands of the preset.
 *
 * @throws Error when the name is not valid, the scope is not found, or the package exists
 */
export async function writePackage(root: string, name: string, presetName: PresetName, cli: Manifest = cliManifest()): Promise<WrittenPackage> {
  const scope = await getScope(root);
  if (!scope) {
    throw new Error("Could not derive package scope from root package.json (expected name to end with -monorepo).");
  }
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid package name "${name}". Allowed: ^[a-z0-9][a-z0-9-]*$`);
  }
  const preset = PRESETS[presetName];
  const dir = resolve(root, "packages", name);
  if (existsSync(dir)) {
    throw new Error(`Package already exists: packages/${name}`);
  }
  const packageName = `@${scope}/${name}`;
  // Resolve the ranges before the folder exists: a range that is not found must not leave a folder that blocks a retry
  const dependencies = preset.dependencies && preset.dependencies.length > 0 ? await dependencyVersions(preset.dependencies, root, cli) : undefined;
  const devDependencies = await devDependencyVersions(root, cli);
  await mkdir(resolve(dir, "src"), { recursive: true });
  try {
    return await writeFiles({ dir, name, scope, packageName, preset, dependencies, devDependencies });
  } catch (error) {
    // The folder is new (the check above), so a failed write removes it
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** The data of a new package that `writeFiles` writes, after `writePackage` resolved it. */
interface NewPackage {
  readonly dir: string;
  readonly name: string;
  readonly scope: string;
  readonly packageName: string;
  readonly preset: Preset;
  readonly dependencies: Record<string, string> | undefined;
  readonly devDependencies: Record<string, string>;
}

/** This function writes the files of a new package in its new folder (`writePackage`). */
async function writeFiles({ dir, name, scope, packageName, preset, dependencies, devDependencies }: NewPackage): Promise<WrittenPackage> {
  const pkgJson = {
    $schema: "https://json.schemastore.org/package",
    name: packageName,
    version: "0.1.0",
    private: true,
    type: "module",
    main: "./src/index.ts",
    scripts: {
      test: "vitest run",
      "test:watch": "vitest",
      typecheck: "tsc -p tsconfig.json && tsc -p tsconfig.test.json",
      ...preset.scripts,
    },
    ...(dependencies ? { dependencies } : {}),
    devDependencies,
  };
  await writeFile(resolve(dir, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");

  const tsconfig = {
    $schema: "https://json.schemastore.org/tsconfig",
    extends: `@mark1russell7/cue/ts/config/${preset.tsconfig}.json`,
    compilerOptions: tsconfigOptions(preset.tsconfig),
  };
  await writeFile(resolve(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2) + "\n");
  await writeFile(resolve(dir, "tsconfig.test.json"), JSON.stringify(testTsconfig(preset.tsconfig), null, 2) + "\n");

  if (preset.files) {
    const source = presetDir(preset.files);
    const words: Readonly<Record<string, string>> = { name, scope, package: packageName };
    for (const file of await filesOf(source)) {
      const text = await readFile(resolve(source, file), "utf8");
      const target = resolve(dir, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text.replace(/\{\{(name|scope|package)\}\}/g, (_, word: string) => words[word] ?? ""));
    }
  } else {
    await writeFile(resolve(dir, "src", "index.ts"), `export {};\n`);
  }

  await writeFile(
    resolve(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\n\nexport default defineConfig({\n  test: {\n    include: ["src/**/*.{test,spec}.{ts,tsx}"],\n    passWithNoTests: true,\n  },\n});\n`,
  );

  // `pnpm add` resolves the newest versions and installs the workspace.
  const install: string[] = [];
  const filter = `--filter=${packageName}`;
  if (preset.install && preset.install.dependencies.length > 0) install.push(`pnpm add ${filter} ${preset.install.dependencies.join(" ")}`);
  if (preset.install && preset.install.devDependencies.length > 0) install.push(`pnpm add -D ${filter} ${preset.install.devDependencies.join(" ")}`);
  return { dir, name: packageName, install };
}

export async function addPackage(args: string[]): Promise<void> {
  const root = repoRoot();
  const scope = await getScope(root);
  if (!scope) {
    throw new Error("Could not derive package scope from root package.json (expected name to end with -monorepo).");
  }
  const parsed = parseArgs(args);
  let name = parsed.name;
  if (!name) {
    const answer = await p.text({
      message: `Package name (will be @${scope}/<name>)?`,
      validate: (v) => (NAME_RE.test(v ?? "") ? undefined : "lowercase letters, digits, hyphens; must start with letter/digit"),
    });
    if (p.isCancel(answer)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    name = answer;
  }

  let preset: PresetName;
  if (parsed.preset) {
    preset = parsed.preset;
  } else {
    const presetAnswer = await p.select({
      message: "Pick a preset:",
      options: PRESET_NAMES.map((value) => ({ value, label: PRESETS[value].label })),
      initialValue: "node" as PresetName,
    });
    if (p.isCancel(presetAnswer)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    preset = presetAnswer;
  }

  const written = await writePackage(root, name, preset);
  p.log.success(`Created packages/${name}/ with the preset ${preset} (cue ${PRESETS[preset].tsconfig}.json)`);

  if (written.install.length === 0) {
    p.log.info(`Run 'pnpm install' to wire up the new workspace package.`);
    return;
  }
  for (const command of written.install) execSync(command, { cwd: root, stdio: "inherit" });
}
