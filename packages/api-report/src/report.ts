/**
 * The report of the public API of a package, from its built `.d.ts` files.
 *
 * The report lists the names that each entry of the `exports` field gives, and the declaration of
 * each name. It follows `export *`, `export { a as b } from`, `export * as ns` and the imports that
 * a module exports again. It also lists the ambient declarations of each file that an entry reaches,
 * and the bins. An entry without a declaration file (for example a JSON file) lists its files. The
 * report has no comments and no private members. Thus a change of a comment or of a private field
 * does not change it.
 *
 * The text is the same on Windows and on Linux. The line ends
 * are LF, the paths use `/`, and the sort does not use the locale.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseDeclarations, type DeclarationInfo } from "./declarations.ts";
import { binsOf, byCode, declarationPathOf, entriesOf, patternMatch, publishedManifest, relativePath, targetOf, type Entry, type Manifest } from "./entries.ts";

/** The command that the header of a report names, when the options give no other command. */
export const DEFAULT_TOOL = "api-report";

/** The options of a report. */
export interface ReportOptions {
  /** The manifest of the package: the report reads its `imports` and `bin` fields. */
  readonly manifest?: Manifest;
  /** The command that the header names, for example `api-report` or `node scripts/api-report.mjs`. */
  readonly tool?: string;
}

/** The binding of an exported name. */
type Binding =
  | { readonly kind: "declaration"; readonly file: string; readonly local: string; readonly typeOnly: boolean }
  | { readonly kind: "namespace"; readonly file: string; readonly typeOnly: boolean }
  | { readonly kind: "external"; readonly module: string; readonly name: string; readonly typeOnly: boolean };

/** The reader of the declaration files of one package. */
class Reader {
  readonly #infos = new Map<string, DeclarationInfo>();
  readonly #bindings = new Map<string, Map<string, Binding>>();
  readonly #visiting = new Set<string>();
  readonly #root: string;
  readonly #manifest: Manifest;

  constructor(root: string, manifest: Manifest) {
    this.#root = root;
    this.#manifest = manifest;
  }

  info(file: string): DeclarationInfo {
    let info = this.#infos.get(file);
    if (!info) {
      info = parseDeclarations(readFileSync(file, "utf8"), relativePath(this.#root, file));
      this.#infos.set(file, info);
    }
    return info;
  }

  /** This method gives the candidate declaration files of a module path. */
  #candidates(base: string): string[] {
    const declared = declarationPathOf(base);
    if (declared) return [declared];
    const source = /\.([mc]?)ts$/.exec(base);
    if (source) return [`${base.slice(0, -source[0].length)}.d.${source[1] ?? ""}ts`];
    return [`${base}.d.ts`, join(base, "index.d.ts")];
  }

  /**
   * This method gives the declaration file of a module specifier of `from`: a relative path, or a
   * `#` name of the `imports` field. The result is undefined for a module of a different package. A
   * missing file throws, or gives `null` when `soft` is true.
   */
  fileOf(from: string, specifier: string, soft = false): string | null | undefined {
    let base: string | undefined;
    if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
    else if (specifier.startsWith("#") && typeof this.#manifest.imports === "object" && this.#manifest.imports !== null) {
      for (const [pattern, value] of Object.entries(this.#manifest.imports)) {
        const part = patternMatch(pattern, specifier);
        const target = part === undefined ? undefined : targetOf(value);
        if (part !== undefined && typeof target === "string" && target.startsWith(".")) {
          base = resolve(this.#root, target.split("*").join(part));
          break;
        }
      }
      if (base === undefined) return undefined;
    } else return undefined;
    const file = this.#candidates(base).find((candidate) => existsSync(candidate));
    if (file) return file;
    if (soft) return null;
    throw new Error(`No declaration file for "${specifier}" from ${relativePath(this.#root, from)}`);
  }

  /** This method gives the binding of `imported` in the module `specifier` of `from`. */
  #bindingIn(from: string, specifier: string, imported: string, typeOnly: boolean): Binding {
    const file = this.fileOf(from, specifier);
    if (!file) return { kind: "external", module: specifier, name: imported, typeOnly };
    if (imported === "*") return { kind: "namespace", file, typeOnly };
    const binding = this.exportsOf(file).get(imported);
    if (!binding) throw new Error(`"${specifier}" from ${relativePath(this.#root, from)} does not export ${imported}`);
    return typeOnly ? { ...binding, typeOnly: true } : binding;
  }

  /** This method gives the names that a module exports, and their bindings. */
  exportsOf(file: string): Map<string, Binding> {
    const known = this.#bindings.get(file);
    if (known) return known;
    if (this.#visiting.has(file)) return new Map();
    this.#visiting.add(file);
    const info = this.info(file);
    const result = new Map<string, Binding>();
    for (const [name, { local, typeOnly }] of info.exported) {
      const imported = info.imports.get(local);
      if (info.locals.has(local)) result.set(name, { kind: "declaration", file, local, typeOnly });
      else if (imported) result.set(name, this.#bindingIn(file, imported.from, imported.imported, typeOnly || imported.typeOnly));
      else throw new Error(`${relativePath(this.#root, file)} exports ${local}, and has no declaration or import of it`);
    }
    for (const reexport of info.reexports) result.set(reexport.exported, this.#bindingIn(file, reexport.from, reexport.imported, reexport.typeOnly));
    for (const namespace of info.namespaces) result.set(namespace.name, this.#bindingIn(file, namespace.from, "*", namespace.typeOnly));
    // A name of `export *` never replaces an explicit export, and `default` does not pass
    const explicit = new Set(result.keys());
    for (const { from: star, typeOnly } of info.stars) {
      const target = this.fileOf(file, star);
      if (!target) {
        // The names of a different package are not in this package: the report names the package
        const name = `* from "${star}"`;
        if (!result.has(name)) result.set(name, { kind: "external", module: star, name: "*", typeOnly });
        continue;
      }
      // `export type *` gives each name as a type only
      for (const [name, binding] of this.exportsOf(target)) {
        if (name !== "default" && !explicit.has(name) && !result.has(name)) result.set(name, typeOnly ? { ...binding, typeOnly: true } : binding);
      }
    }
    this.#visiting.delete(file);
    this.#bindings.set(file, result);
    return result;
  }

  /**
   * This method gives each declaration file of the package that `file` reaches through its module
   * specifiers, and `file`. A file outside the package folder or in `node_modules` is not part of it.
   */
  reached(file: string): string[] {
    const seen = new Set<string>();
    const pending = [file];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      for (const specifier of this.info(next).references) {
        const target = this.fileOf(next, specifier, true);
        if (!target) continue;
        const path = relativePath(this.#root, target);
        if (path.startsWith("../") || path.split("/").includes("node_modules")) continue;
        pending.push(target);
      }
    }
    return [...seen];
  }
}

/** This function gives the lines of the header of a report. */
function header(packageName: string, tool: string): string[] {
  return [
    `# The public API of ${packageName}`,
    "#",
    "# The names of each entry of the exports field, and the declaration of each name, without comments",
    `# and private members. The command \`${tool} check\` compares this file with the built .d.ts files.`,
    `# To accept a change of the API, start the build, then \`${tool} update\`, and review the diff.`,
  ];
}

/** The number of lines of the header of a report. */
export const HEADER_LINES = 5;

/**
 * This function gives the report of the public API of a package. `entries` gives the subpath and
 * the declaration file of each entry, relative to `root`. The report has the exported names of each
 * entry, the bins of the manifest, and then the declaration of each name.
 */
export function apiReport(packageName: string, root: string, entries: readonly Entry[], options: ReportOptions = {}): string {
  const manifest = options.manifest ?? {};
  const reader = new Reader(root, manifest);
  const path = (file: string): string => relativePath(root, file);
  const keyOf = (binding: Binding): string =>
    binding.kind === "declaration" ? `${path(binding.file)}#${binding.local}` : binding.kind === "namespace" ? `${path(binding.file)}#*` : `${binding.module}#${binding.name}`;
  const declarations = new Map<string, string>();
  const lines = header(packageName, options.tool ?? DEFAULT_TOOL);
  if (entries.every((entry) => entry.types === undefined)) {
    lines.push("", "This package has no type declarations: no entry of its package.json gives a .d.ts file.");
  }

  /** The lines of the names of a module, and the names of each namespace in it, with `prefix`. */
  const names = (bindings: Map<string, Binding>, prefix: string, parents: ReadonlySet<string>, typeOnly: boolean): void => {
    for (const [name, binding] of [...bindings].sort(([a], [b]) => byCode(a, b))) {
      const key = keyOf(binding);
      const isType = typeOnly || binding.typeOnly;
      lines.push(`${isType ? "type " : ""}${prefix}${name}: ${key}${binding.kind === "declaration" ? "" : ` (${binding.kind})`}`);
      if (binding.kind === "declaration" && !declarations.has(key)) {
        declarations.set(key, (reader.info(binding.file).locals.get(binding.local) ?? []).join("\n"));
      }
      // The names of a namespace are part of the API: `ns.name`
      if (binding.kind === "namespace" && !parents.has(binding.file)) {
        names(reader.exportsOf(binding.file), `${prefix}${name}.`, new Set([...parents, binding.file]), isType);
      }
    }
  };

  for (const entry of entries) {
    if (entry.types === undefined) {
      lines.push("", `## ${entry.subpath}: ${entry.note ?? "no declaration file"}`);
      // The files of an entry without declarations: a removed file changes the report
      const files = entry.files ?? [];
      if (files.length > 0) lines.push("", ...files.map((file) => `file ${file.subpath}: ${file.path.replace(/^\.\//, "")}`));
      continue;
    }
    const file = resolve(root, entry.types);
    if (!existsSync(file)) throw new Error(`${entry.subpath}: ${entry.types} is missing. Build the package first.`);
    const bindings = reader.exportsOf(file);
    lines.push("", `## ${entry.subpath} (${path(file)}): ${bindings.size} names`, "");
    names(bindings, "", new Set([file]), false);
    // The ambient declarations of each file that the entry reaches
    const ambient: string[] = [];
    for (const reached of reader.reached(file)) {
      for (const [label, statements] of reader.info(reached).ambient) {
        const key = `${path(reached)}#${label}`;
        ambient.push(key);
        if (!declarations.has(key)) declarations.set(key, statements.join("\n"));
      }
    }
    for (const key of ambient.sort(byCode)) lines.push(`ambient: ${key}`);
  }
  const bins = binsOf(manifest);
  if (bins.length > 0) {
    lines.push("", `## bin: ${bins.length} commands`, "");
    for (const bin of bins) lines.push(`${bin.name}: ${bin.path}`);
  }
  if (declarations.size > 0 || entries.some((entry) => entry.types !== undefined)) {
    lines.push("", "## Declarations");
    for (const key of [...declarations.keys()].sort(byCode)) lines.push("", `### ${key}`, declarations.get(key) ?? "");
  }
  return `${lines.join("\n")}\n`;
}

/** The options of the report of a package folder. */
export interface PackageReportOptions {
  /** The command that the header names. */
  readonly tool?: string;
  /** When true (the default), the fields of `publishConfig` replace the fields of the source, as pnpm publishes them. */
  readonly publishConfig?: boolean;
}

/** This function gives the report of the package in the folder `dir`. */
export function packageReport(dir: string, options: PackageReportOptions = {}): string {
  const source = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
  const manifest = options.publishConfig === false ? source : publishedManifest(source);
  const name = typeof manifest.name === "string" ? manifest.name : basename(dir);
  return apiReport(name, dir, entriesOf(manifest, dir), { manifest, ...(options.tool === undefined ? {} : { tool: options.tool }) });
}
