/**
 * The compiler options of a tsconfig after its `extends` chain, as the rules read them.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readJsonc } from "./rule.ts";

/** The value of a compiler option, and the file of the config that sets it. */
export interface ConfigOption {
  readonly value: unknown;
  readonly file: string;
}

/**
 * This function gives the value of the compiler option `name` that a tsconfig gets from the configs it extends. It gives
 * `null` when no config of the chain sets it. It gives `undefined` when it cannot read a config of the chain, for example
 * a package that is not installed.
 */
export function inheritedOption(tsconfig: string, name: string, seen: ReadonlySet<string> = new Set()): ConfigOption | null | undefined {
  const json = readJsonc(tsconfig) as { extends?: unknown } | undefined;
  if (json === undefined || seen.has(tsconfig)) return undefined;
  const specs = Array.isArray(json.extends) ? json.extends : json.extends === undefined ? [] : [json.extends];
  let found: ConfigOption | null = null;
  // A later config of the list wins, as in tsc
  for (const spec of specs) {
    if (typeof spec !== "string") return undefined;
    let file: string;
    try {
      file = spec.startsWith(".") || spec.startsWith("/") ? resolve(dirname(tsconfig), spec) : createRequire(tsconfig).resolve(spec);
    } catch {
      return undefined;
    }
    if (!existsSync(file) && existsSync(`${file}.json`)) file = `${file}.json`;
    const parent = readJsonc(file) as { compilerOptions?: Record<string, unknown> } | undefined;
    if (parent === undefined) return undefined;
    const own = parent.compilerOptions?.[name];
    const value = own === undefined ? inheritedOption(file, name, new Set([...seen, tsconfig])) : { value: own, file };
    if (value === undefined) return undefined;
    if (value !== null) found = value;
  }
  return found;
}

/**
 * This function gives the value of the compiler option `name` of a tsconfig. It is its own value, or else the value from
 * the configs it extends. It gives `null` when no config sets it, and `undefined` when it cannot read a config.
 */
export function compilerOption(tsconfig: string, name: string): ConfigOption | null | undefined {
  const json = readJsonc(tsconfig) as { compilerOptions?: Record<string, unknown> } | undefined;
  if (json === undefined) return undefined;
  const own = json.compilerOptions?.[name];
  return own === undefined ? inheritedOption(tsconfig, name) : { value: own, file: tsconfig };
}

/**
 * This function gives the absolute path of a path option. A `${configDir}` is the folder of the tsconfig `tsconfig`. Each
 * other relative path is relative to the config that sets it.
 */
export function optionPath(tsconfig: string, option: ConfigOption & { readonly value: string }): string {
  const value = option.value;
  return value.startsWith("${configDir}") ? resolve(dirname(tsconfig), `.${value.slice("${configDir}".length)}`) : resolve(dirname(option.file), value);
}

/**
 * This function gives the absolute path of the build info file that tsc writes for a tsconfig, by the rules of tsc. It
 * gives `null` when tsc writes no build info file: `incremental` and `composite` are both off. It gives `undefined` when
 * it cannot read a config of the chain.
 */
export function buildInfoFile(tsconfig: string): string | null | undefined {
  const read = (name: string): ConfigOption | null | undefined => compilerOption(tsconfig, name);
  const incremental = read("incremental");
  const composite = read("composite");
  if (incremental === undefined || composite === undefined) return undefined;
  // `composite` turns on the incremental build, also when `incremental` is false (isIncrementalCompilation of tsc)
  if (incremental?.value !== true && composite?.value !== true) return null;
  const paths: Record<string, string | null> = {};
  for (const name of ["tsBuildInfoFile", "outFile", "outDir", "rootDir"]) {
    const option = read(name);
    if (option === undefined) return undefined;
    paths[name] = option !== null && typeof option.value === "string" ? optionPath(tsconfig, { file: option.file, value: option.value }) : null;
  }
  if (paths["tsBuildInfoFile"]) return paths["tsBuildInfoFile"];
  const withoutExtension = (path: string): string => path.replace(/\.[^./\\]*$/, "");
  if (paths["outFile"]) return `${withoutExtension(paths["outFile"])}.tsbuildinfo`;
  const config = withoutExtension(resolve(tsconfig));
  const outDir = paths["outDir"];
  const rootDir = paths["rootDir"];
  const stem = outDir ? (rootDir ? resolve(outDir, relative(rootDir, config)) : join(outDir, basename(config))) : config;
  return `${stem}.tsbuildinfo`;
}
