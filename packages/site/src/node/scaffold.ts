/**
 * The build of the site starts the real CLI (`@mark1russell7/template-cli`) one time for each preset, in a new empty
 * repository. Then it reads the files that the CLI writes. Thus the package preview of the page cannot be different
 * from the CLI. This module operates only in Node.js, at build time.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { ScaffoldData, ScaffoldPreset } from "../types.ts";

/** The package name that the build gives to the CLI. The page puts the name of the visitor in its place. */
export const NAME_MARK = "zqxname";
/** The scope that the build gives to the CLI. The page puts the scope of the visitor in its place. */
export const SCOPE_MARK = "zqxscope";

/** The folder and the `package.json` of the CLI in the workspace. */
function cli(): { dir: string; bin: string; version: string } {
  const require = createRequire(import.meta.url);
  const manifestPath = realpathSync(require.resolve("@mark1russell7/template-cli/package.json"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string; bin: string | Record<string, string> };
  const bin = typeof manifest.bin === "string" ? manifest.bin : Object.values(manifest.bin)[0];
  if (bin === undefined) throw new Error("The CLI has no bin.");
  return { dir: dirname(manifestPath), bin: join(dirname(manifestPath), bin), version: manifest.version };
}

/** This function gives the path of each file in a folder and its subfolders, relative to the folder, in name order. */
function filesOf(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  const entries = readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...filesOf(dir, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** The environment of the CLI, with a folder first in its PATH. The key of PATH on Windows is often "Path". */
function withPath(folder: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, NO_COLOR: "1", FORCE_COLOR: "0" };
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[key] = `${folder}${process.platform === "win32" ? ";" : ":"}${env[key] ?? ""}`;
  return env;
}

/**
 * This function writes a stand-in `pnpm` in a folder. The CLI starts `pnpm add` for the presets vite and react. The
 * stand-in installs nothing: it writes each command into a log, so that the page can show the commands.
 */
function stubPnpm(folder: string): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "pnpm"), `#!/bin/sh\nprintf 'pnpm %s\\n' "$*" >> "$SCAFFOLD_LOG"\n`, { mode: 0o755 });
  writeFileSync(join(folder, "pnpm.cmd"), `@echo pnpm %*>> "%SCAFFOLD_LOG%"\r\n`);
}

/** This function starts the CLI in a folder and gives its output. */
function run(bin: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, [bin, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** This function starts the CLI with arguments that it refuses, and gives the list of permitted values in its error message. */
function allowed(bin: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, pattern: RegExp): string {
  try {
    run(bin, args, cwd, env);
  } catch (error) {
    const text = String((error as { stderr?: unknown }).stderr ?? "") + String((error as { stdout?: unknown }).stdout ?? "") + String(error);
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
    throw new Error(`The CLI did not tell what it allows for ${args.join(" ")}: ${text.slice(0, 400)}`);
  }
  throw new Error(`The CLI accepted ${args.join(" ")}.`);
}

/** This function gives the label of each preset, from the source of the CLI. A preset without a label gets its name. */
export function presetLabels(source: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const match of source.matchAll(/^\s*"?([a-z0-9-]+)"?: \{\s*label: "([^"]+)"/gm)) {
    if (match[1] && match[2]) labels[match[1]] = match[2];
  }
  return labels;
}

/** This function makes one new repository, starts `package add` of the CLI in it, and reads the new package. */
function scaffold(bin: string, preset: string, root: Record<string, unknown>): Omit<ScaffoldPreset, "label"> {
  const repo = mkdtempSync(join(tmpdir(), "template-site-"));
  try {
    writeFileSync(join(repo, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    writeFileSync(join(repo, "package.json"), `${JSON.stringify({ ...root, name: `${SCOPE_MARK}-monorepo` }, null, 2)}\n`);
    const stub = join(repo, ".stub");
    stubPnpm(stub);
    const log = join(repo, ".scaffold-log");
    writeFileSync(log, "");
    run(bin, ["package", "add", NAME_MARK, `--preset=${preset}`], repo, withPath(stub, { SCAFFOLD_LOG: log }));
    const dir = join(repo, "packages", NAME_MARK);
    const files = filesOf(dir).map((path) => ({ path, text: readFileSync(join(dir, path), "utf8").replace(/\r\n/g, "\n") }));
    const install = readFileSync(log, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return { name: preset, files, install };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

/**
 * This function starts the CLI for each of its presets and gives the files of each new package. The root `package.json`
 * of each new repository has the development dependencies of `rootManifest`, as a repository of the template has.
 */
export function scaffoldData(rootManifest: Record<string, unknown> = {}): ScaffoldData {
  const { dir, bin, version } = cli();
  const root = { private: true, type: "module", devDependencies: rootManifest["devDependencies"] ?? {} };
  const probe = mkdtempSync(join(tmpdir(), "template-site-"));
  let names: string[];
  let namePattern: string;
  try {
    writeFileSync(join(probe, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    writeFileSync(join(probe, "package.json"), `${JSON.stringify({ name: `${SCOPE_MARK}-monorepo` })}\n`);
    const env = withPath(join(probe, ".none"), {});
    // The names of the presets and the pattern of a package name come from the error messages of the CLI.
    names = allowed(bin, ["package", "add", NAME_MARK, "--preset=zqxnone"], probe, env, /Allowed: ([a-z0-9, -]+)/)
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    namePattern = allowed(bin, ["package", "add", "Not_A_Name", "--preset=node"], probe, env, /Allowed: (\^\S+\$)/);
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  const labels = presetLabels(readFileSync(join(dir, "src", "commands", "package", "add.ts"), "utf8"));
  const presets = names.map((name) => ({ ...scaffold(bin, name, root), label: labels[name] ?? name }));
  return { cliVersion: version, cliSource: relative(join(dir, "..", ".."), dir).replace(/\\/g, "/"), nameMark: NAME_MARK, scopeMark: SCOPE_MARK, namePattern, presets };
}
