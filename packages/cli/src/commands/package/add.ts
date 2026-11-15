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

// @vitest/coverage-v8: the coverage of the shared CI (action coverage) needs it in each package with Vitest.
const DEV_DEPENDENCIES = ["@mark1russell7/cue", "@types/node", "@vitest/coverage-v8", "typescript", "vitest"] as const;

/** Each dependency that releases with the same versions as its partner. */
const LOCKSTEP: Readonly<Record<string, string>> = { "@vitest/coverage-v8": "vitest" };

/**
 * This function gives the version range of each named dependency of a new package. The range comes
 * from the repository: the root `package.json`, then the packages in name order. Thus
 * `pnpm up -r --latest` in the repository also updates the ranges of its new packages. A dependency
 * that the repository does not have gets the range of this CLI. A dependency of `LOCKSTEP` gets the
 * range of its partner instead, because the two release together. Thus a repository on Vitest 4 gets
 * @vitest/coverage-v8 of Vitest 4, not the range of the CLI.
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
  const rangeIn = (list: readonly Manifest[], dep: string): string | undefined =>
    list.map((m) => m.devDependencies?.[dep] ?? m.dependencies?.[dep]).find((v) => v !== undefined);
  const repository = [...manifests];
  manifests.push(cli);
  const versions: Record<string, string> = {};
  for (const dep of names) {
    const partner = LOCKSTEP[dep];
    const partnerRange = partner !== undefined ? rangeIn(repository, partner) : undefined;
    const version = rangeIn(repository, dep) ?? partnerRange ?? rangeIn(manifests, dep);
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
export type PresetName = "node" | "node-cjs" | "ts" | "vite" | "react" | "service" | "site" | "electron";

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
   * CLI replaces `{{name}}`, `{{scope}}` and `{{package}}` in each file, and removes the end
   * `.tmpl` of a file name. Thus the checks of the CLI do not examine that file. Without a folder,
   * the package gets an empty `src/index.ts`.
   */
  readonly files?: string;
  /**
   * These files of `src/presets` go to the repository, by their path in the repository. The CLI
   * replaces the same words, and `{{pin}}` with the template commit of the workflows of the
   * repository. The CLI keeps a file that exists.
   */
  readonly repoFiles?: Readonly<Record<string, string>>;
  /**
   * These packages can start their install scripts. The CLI adds each one to `allowBuilds` of
   * `pnpm-workspace.yaml` before the install, with the reason. It keeps an entry that exists, also
   * an entry with `false`.
   */
  readonly allowBuilds?: Readonly<Record<string, string>>;
}

/** A line of `pnpm-workspace.yaml` that starts a key at the top level. */
const TOP_KEY = /^[^\s#][^:]*:/;

/** This function gives the key of a line in a block of YAML, without quotes, or `undefined` for no key. */
const keyOf = (line: string): string | undefined => /^\s+(?:"([^"]+)"|'([^']+)'|([^\s:#][^:]*?))\s*:/.exec(line)?.slice(1).find((key) => key !== undefined);

/** The result of `withAllowBuilds`: the new text of `pnpm-workspace.yaml`, and the packages that it adds. */
export interface AllowedBuilds {
  readonly text: string;
  readonly added: readonly string[];
}

/**
 * This function gives the text of `pnpm-workspace.yaml` with each package of `allow` in its block
 * `allowBuilds`, with its reason as a comment. It makes the block when it is not there. A package
 * that is in the block keeps its entry. With nothing to add, the text does not change.
 */
export function withAllowBuilds(text: string, allow: Readonly<Record<string, string>>): AllowedBuilds {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^allowBuilds:\s*(#.*)?$/.test(line));
  let end = start + 1;
  while (start >= 0 && end < lines.length && !TOP_KEY.test(lines[end] ?? "")) end++;
  const present = new Set(start < 0 ? [] : lines.slice(start + 1, end).map(keyOf).filter((key) => key !== undefined));
  const added = Object.keys(allow).filter((name) => !present.has(name));
  if (added.length === 0) return { text, added };
  const entries = added.flatMap((name) => [`  # ${allow[name] ?? ""}`, `  ${/^[\w-]+$/.test(name) ? name : JSON.stringify(name)}: true`]);
  if (start >= 0) {
    lines.splice(start + 1, 0, ...entries);
    return { text: lines.join("\n"), added };
  }
  const body = text.endsWith("\n") || text === "" ? text : `${text}\n`;
  return { text: `${body}\n# Packages allowed to run install scripts.\nallowBuilds:\n${entries.join("\n")}\n`, added };
}

/** The text of a new site (the preset `site`). */
export interface SiteText {
  /** This one line tells what the project does. */
  readonly description?: string | undefined;
  /** The npm name of the first package of the repository. It need not have a release yet. */
  readonly npm?: string | undefined;
}

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** This function gives the words of the files of the preset `site`. A command must work today, so a repository with no package name gets `git clone`. */
function siteWords(scope: string, { description, npm }: SiteText): Record<string, string> {
  return {
    description: escapeHtml(description ?? `The project ${scope}.`),
    installTitle: npm ? "Install" : "Get the code",
    install: npm ? `pnpm add ${npm}` : `git clone https://github.com/mark1russell7/${scope}.git`,
    note: npm ? "This package has no release on npm yet. " : "",
    npm: npm ?? "",
  };
}

/** The workflows of a repository pin the shared workflows of the template by this form. */
const TEMPLATE_PIN = /mark1russell7\/template\/\.github\/[\w./-]+@([0-9a-f]{40})/;

/** This function gives the template commit that the workflows of a repository pin, or undefined when they pin no commit. */
async function templatePin(root: string): Promise<string | undefined> {
  const dir = resolve(root, ".github", "workflows");
  if (!existsSync(dir)) return undefined;
  for (const file of (await readdir(dir)).sort()) {
    const pin = TEMPLATE_PIN.exec(await readFile(resolve(dir, file), "utf8"))?.[1];
    if (pin) return pin;
  }
  return undefined;
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
  // A first site: the name, one line, a command, and the links to the pages of site-pages. It passes the site check.
  site: {
    label: "site — a first site for GitHub Pages (Vite)",
    tsconfig: "vite",
    install: { dependencies: [], devDependencies: ["vite", "@mark1russell7/site-pages"] },
    scripts: { dev: "vite", build: "vite build" },
    files: "site",
    repoFiles: { ".github/workflows/pages.yml": "site-repo/pages.yml", ".github/site.json": "site-repo/site.json" },
  },
  // A desktop app: a main process with safe defaults, a preload script that gives the page only a message port, and a page.
  electron: {
    label: "electron — desktop app (Electron)",
    tsconfig: "node",
    install: { dependencies: [], devDependencies: ["electron", "tsdown"] },
    scripts: { build: "tsdown", start: "tsdown && electron build/main/main.js", smoke: "tsdown && electron build/main/main.js --smoke" },
    files: "electron",
    allowBuilds: { electron: "electron: its install script downloads the Electron binary (the preset electron)." },
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
// The config files of the package (vitest.config.ts) are in it too, so each TypeScript file has a type check (rule typed-files).
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
      rootDir: ".",
    },
    include: ["src/**/*", "*.config.ts"],
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

function parseArgs(args: string[]): { name: string | undefined; preset: PresetName | undefined; site: SiteText } {
  let name: string | undefined;
  let preset: PresetName | undefined;
  let description: string | undefined;
  let npm: string | undefined;
  for (const a of args) {
    if (a.startsWith("--description=")) description = a.slice("--description=".length);
    else if (a.startsWith("--npm=")) npm = a.slice("--npm=".length);
    else if (a.startsWith("--preset=")) {
      const v = a.slice("--preset=".length);
      if (!isPresetName(v)) {
        throw new Error(`Unknown --preset "${v}". Allowed: ${PRESET_NAMES.join(", ")}`);
      }
      preset = v;
    } else if (!name) {
      name = a;
    }
  }
  return { name, preset, site: { description, npm } };
}

/** The result of `writePackage`: the folder of the new package and the `pnpm add` commands that its preset needs. */
export interface WrittenPackage {
  readonly dir: string;
  readonly name: string;
  readonly install: readonly string[];
  /** These files of the preset are not in the repository: the file exists, or the workflows pin no template commit. */
  readonly skipped: readonly string[];
  /** These packages are new in `allowBuilds` of `pnpm-workspace.yaml`. */
  readonly allowed: readonly string[];
}

/**
 * This function writes the folder `packages/<name>` of a new package of a preset in a repository.
 * It writes `package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts` and the files
 * of the preset, or `src/index.ts` and a first test. It installs nothing: it gives the `pnpm add` commands of the preset.
 *
 * @throws Error when the name is not valid, the scope is not found, or the package exists
 */
export async function writePackage(
  root: string,
  name: string,
  presetName: PresetName,
  cli: Manifest = cliManifest(),
  site: SiteText = {},
): Promise<WrittenPackage> {
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
    return await writeFiles({ root, dir, name, scope, packageName, preset, dependencies, devDependencies, site });
  } catch (error) {
    // The folder is new (the check above), so a failed write removes it
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** The data of a new package that `writeFiles` writes, after `writePackage` resolved it. */
interface NewPackage {
  readonly root: string;
  readonly dir: string;
  readonly name: string;
  readonly scope: string;
  readonly packageName: string;
  readonly preset: Preset;
  readonly dependencies: Record<string, string> | undefined;
  readonly devDependencies: Record<string, string>;
  readonly site: SiteText;
}

/** This function gives a text with each word of `words` in place of its `{{word}}`. */
const fill = (text: string, words: Readonly<Record<string, string>>): string => text.replace(/\{\{(\w+)\}\}/g, (mark: string, word: string) => words[word] ?? mark);

/** This function writes the files of a new package in its new folder (`writePackage`). */
async function writeFiles({ root, dir, name, scope, packageName, preset, dependencies, devDependencies, site }: NewPackage): Promise<WrittenPackage> {
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

  const words: Readonly<Record<string, string>> = { ...siteWords(scope, site), name, scope, package: packageName };
  if (preset.files) {
    const source = presetDir(preset.files);
    for (const file of await filesOf(source)) {
      const text = await readFile(resolve(source, file), "utf8");
      const target = resolve(dir, file.replace(/\.tmpl$/, ""));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, fill(text, words));
    }
  } else {
    await writeFile(resolve(dir, "src", "index.ts"), `export {};\n`);
    // A first test, so that the test step runs a test: the runner fails when it finds none (rule tests-required)
    await writeFile(
      resolve(dir, "src", "index.test.ts"),
      `import { describe, expect, it } from "vitest";\nimport * as entry from "./index.ts";\n\ndescribe("the entry", () => {\n  it("loads", () => {\n    expect(entry).toBeTypeOf("object");\n  });\n});\n`,
    );
  }

  await writeFile(
    resolve(dir, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\n\nexport default defineConfig({\n  test: {\n    include: ["src/**/*.{test,spec}.{ts,tsx}"],\n  },\n});\n`,
  );

  // `pnpm add` resolves the newest versions and installs the workspace.
  const install: string[] = [];
  const filter = `--filter=${packageName}`;
  if (preset.install && preset.install.dependencies.length > 0) install.push(`pnpm add ${filter} ${preset.install.dependencies.join(" ")}`);
  if (preset.install && preset.install.devDependencies.length > 0) install.push(`pnpm add -D ${filter} ${preset.install.devDependencies.join(" ")}`);

  const skipped: string[] = [];
  const pin = await templatePin(root);
  for (const [path, source] of Object.entries(preset.repoFiles ?? {})) {
    const target = resolve(root, path);
    if (pin === undefined || existsSync(target)) {
      skipped.push(path);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, fill(await readFile(presetDir(source), "utf8"), { ...words, pin }));
  }
  // pnpm refuses the install script of a package that allowBuilds does not name, so the CLI names it before the install
  let allowed: readonly string[] = [];
  const workspace = resolve(root, "pnpm-workspace.yaml");
  if (preset.allowBuilds && existsSync(workspace)) {
    const result = withAllowBuilds(await readFile(workspace, "utf8"), preset.allowBuilds);
    if (result.added.length > 0) await writeFile(workspace, result.text);
    allowed = result.added;
  }
  return { dir, name: packageName, install, skipped, allowed };
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

  const written = await writePackage(root, name, preset, cliManifest(), parsed.site);
  p.log.success(`Created packages/${name}/ with the preset ${preset} (cue ${PRESETS[preset].tsconfig}.json)`);
  for (const name of written.allowed) p.log.info(`pnpm-workspace.yaml: allowBuilds now names ${name}.`);
  for (const path of written.skipped) p.log.warn(`The CLI did not write ${path}. Do it by hand: the file exists, or the workflows pin no template commit.`);

  if (written.install.length === 0) {
    p.log.info(`Run 'pnpm install' to wire up the new workspace package.`);
    return;
  }
  for (const command of written.install) execSync(command, { cwd: root, stdio: "inherit" });
}
