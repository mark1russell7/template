/**
 * The import boundaries of a workspace, as a dependency-cruiser configuration. Each package is a
 * unit. Another package imports it only through an entry of its package.json (`exports`, `main`,
 * `module`, `types`, `bin`). A relative path or a deep path into its folder is not an entry.
 *
 * A repository uses it from its `.dependency-cruiser.cjs`:
 *
 * ```js
 * const { boundaries } = require("@mark1russell7/boundaries");
 * module.exports = boundaries(__dirname, { apps: "private" });
 * ```
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix } from "node:path";

/** A rule of dependency-cruiser (the `forbidden` list). The package does not depend on the types of dependency-cruiser. */
export interface Rule {
  name: string;
  severity: "error" | "warn" | "info" | "ignore";
  comment?: string;
  from: Record<string, unknown>;
  to: Record<string, unknown>;
}

/** A dependency-cruiser configuration. */
export interface Config {
  forbidden: Rule[];
  options: Record<string, unknown>;
}

/** A package of the workspace. */
export interface WorkspacePackage {
  /** The name in package.json. */
  name: string;
  /** The folder, relative to the root, with "/". */
  dir: string;
  private: boolean;
  /** RegExp sources of the files that other packages can import. */
  entries: string[];
  /** The names of the dependencies in package.json: dependencies, devDependencies, peerDependencies and optionalDependencies. */
  dependencies?: string[];
}

/**
 * The scopes of the rule unknown-workspace-package. A list replaces the scopes of the workspace
 * packages. `add` and `remove` change that list. An empty list turns off the rule.
 */
export type ScopeOptions = string[] | { add?: string[]; remove?: string[] };

export interface BoundaryOptions {
  /**
   * Globs of the package folders, for example `["packages/*"]`. The default is the `packages` list of
   * pnpm-workspace.yaml, or `["packages/*"]` when the file does not exist.
   */
  packages?: string[];
  /** The apps: the leaves of the graph, which no other package imports. "private" means each private package. */
  apps?: "private" | string[];
  /** A text before each comment, for example the decision record of the rules. The comments of `forbidden` get it too. */
  reference?: string;
  /**
   * The scopes (for example "@x") in which an import that does not resolve must name a workspace
   * package or a declared dependency. The default is the scopes of the workspace package names.
   */
  scopes?: ScopeOptions;
  /**
   * The build folders of each package, for example `["dist", "build"]` (the default). The analysis
   * does not follow the imports of their files, and it does not start from them.
   */
  buildFolders?: string[];
  /** More rules, after the rules of the boundaries. */
  forbidden?: Rule[];
  /** More options of dependency-cruiser. They replace the default options with the same key. */
  options?: Record<string, unknown>;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The default build folders of a package. */
const BUILD_FOLDERS = ["dist", "build"];

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** The names of the dependencies of a package.json, from each dependency field. */
export function declaredDependencies(manifest: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest[field];
    if (value && typeof value === "object" && !Array.isArray(value)) for (const name of Object.keys(value)) names.add(name);
  }
  return [...names].sort();
}

/** The scopes of the package names, for example "@x" for "@x/a", changed by the option `scopes`. A name with no scope gives no scope. */
export function workspaceScopes(packages: Pick<WorkspacePackage, "name">[], opts: ScopeOptions = {}): string[] {
  const normal = (scope: string): string => (scope.startsWith("@") ? scope : `@${scope}`).replace(/\/$/, "");
  if (Array.isArray(opts)) return [...new Set(opts.map(normal))].sort();
  const scopes = new Set(packages.filter((p) => p.name.startsWith("@") && p.name.includes("/")).map((p) => p.name.slice(0, p.name.indexOf("/"))));
  for (const scope of opts.add ?? []) scopes.add(normal(scope));
  for (const scope of opts.remove ?? []) scopes.delete(normal(scope));
  return [...scopes].sort();
}

/** The `packages` list of a pnpm-workspace.yaml file. It reads only that list, with no YAML library. */
export function workspaceGlobs(yaml: string): string[] {
  const globs: string[] = [];
  let inList = false;
  // String operations, not one large RegExp: a RegExp with nested whitespace groups can be slow on some input.
  for (const raw of yaml.split(/\r?\n/)) {
    const hash = raw.indexOf(" #");
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trimEnd();
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (/^packages\s*:/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    if (trimmed === line) break;
    if (!trimmed.startsWith("-")) continue;
    const item = trimmed.slice(1).trim().replace(/^["']/, "").replace(/["']$/, "");
    if (item) globs.push(item);
  }
  return globs;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The folders that a glob of pnpm-workspace.yaml gives: "a/b", "a/*" and "a/**". */
function expand(root: string, glob: string): string[] {
  const clean = glob.replace(/^\.\//, "").replace(/\/$/, "");
  const star = clean.indexOf("*");
  if (star === -1) return isDir(join(root, clean)) ? [clean] : [];
  const base = clean.slice(0, star).replace(/\/$/, "");
  const recursive = clean.slice(star).startsWith("**");
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = dir === "" ? entry.name : `${dir}/${entry.name}`;
      found.push(child);
      if (recursive && depth < 6) walk(child, depth + 1);
    }
  };
  walk(base, 0);
  return found;
}

/** The leaf strings of an `exports` value, with their subpath keys. */
function exportTargets(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) exportTargets(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) exportTargets(item, out);
  return out;
}

/**
 * The RegExp source of an entry target of a package. The extension can change, because
 * dependency-cruiser resolves "./x.js" to the source file x.ts, and "*" of a subpath pattern matches
 * each path.
 */
export function entryPattern(dir: string, target: string): string {
  const path = posix.normalize(posix.join(dir, target.replace(/^\.\//, "")));
  const stem = path.replace(/\.d\.[cm]?ts$|\.[cm]?[jt]sx?$/, "");
  const source = stem.split("*").map(escape).join(".*");
  // A flat list, because dependency-cruiser refuses a RegExp with nested quantifiers (safe-regex).
  return `^${source}(${EXTENSIONS})?$`;
}

const EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".d.ts", ".d.mts", ".d.cts"].map(escape).join("|");

/** The entries of a package.json: the files that other packages can import. */
export function packageEntries(dir: string, manifest: Record<string, unknown>): string[] {
  const targets = exportTargets(manifest["exports"]);
  for (const field of ["main", "module", "types", "typings"]) {
    const value = manifest[field];
    if (typeof value === "string") targets.push(value);
  }
  if (typeof manifest["bin"] === "string") targets.push(manifest["bin"]);
  else if (manifest["bin"] && typeof manifest["bin"] === "object") targets.push(...exportTargets(manifest["bin"]));
  // With no entry field, Node resolves the package to index.js.
  if (targets.length === 0 && manifest["exports"] === undefined) targets.push("./index.js");
  return [...new Set(targets.filter((t) => !t.endsWith(".json") || t === "./package.json").map((t) => entryPattern(dir, t)))];
}

/** The packages of the workspace in the folder `root`. */
export function workspacePackages(root: string, globs?: string[]): WorkspacePackage[] {
  let list = globs;
  if (!list) {
    try {
      list = workspaceGlobs(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"));
    } catch {
      list = [];
    }
    if (list.length === 0) list = ["packages/*"];
  }
  const excluded = list.filter((g) => g.startsWith("!")).flatMap((g) => expand(root, g.slice(1)));
  const dirs = [...new Set(list.filter((g) => !g.startsWith("!")).flatMap((g) => expand(root, g)))].filter((d) => !excluded.includes(d));
  const found: WorkspacePackage[] = [];
  for (const dir of dirs.sort()) {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof manifest["name"] !== "string") continue;
    found.push({
      name: manifest["name"],
      dir,
      private: manifest["private"] === true,
      entries: packageEntries(dir, manifest),
      dependencies: declaredDependencies(manifest),
    });
  }
  return found;
}

/** The options of `boundaryRules()`. */
export interface RuleOptions extends Pick<BoundaryOptions, "apps" | "reference" | "scopes"> {
  /** More declared dependencies, for example the dependencies of the root package.json. */
  dependencies?: string[];
}

/** The rules of the boundaries for a list of packages. `boundaries()` reads the list from the workspace. */
export function boundaryRules(packages: WorkspacePackage[], opts: RuleOptions = {}): Rule[] {
  const why = (text: string): string => (opts.reference ? `${opts.reference} ${text}` : text);
  const anyPackage = packages.map((p) => `^${escape(p.dir)}/`);
  const rules: Rule[] = [];
  for (const pkg of packages) {
    const own = `^${escape(pkg.dir)}/`;
    const others = anyPackage.filter((path) => path !== own);
    if (others.length > 0) {
      rules.push({
        name: `relative-import-out-of-${slug(pkg.name)}`,
        severity: "error",
        comment: why(`A relative import leaves the package ${pkg.name}. Import the other package by its name, through an entry of its package.json.`),
        from: { path: own },
        to: { path: others, pathNot: own, dependencyTypes: ["local"] },
      });
    }
    rules.push({
      name: `deep-import-into-${slug(pkg.name)}`,
      severity: "error",
      comment: why(
        `An import reaches into the folder of ${pkg.name} at a file that is not an entry of its package.json (exports, main, module, types or bin). Import an entry, or add the file to the exports of ${pkg.name}.`,
      ),
      from: { pathNot: own },
      to: pkg.entries.length > 0 ? { path: own, pathNot: pkg.entries } : { path: own },
    });
  }
  const names = packages.map((p) => escape(p.name));
  if (names.length > 0) {
    rules.push({
      name: "not-a-declared-export",
      severity: "error",
      comment: why("An import of a package of this workspace does not resolve. The path is not an entry of its exports, or the package is not built."),
      from: {},
      to: { path: `^(${names.join("|")})(/|$)`, couldNotResolve: true },
    });
  }
  const scopes = workspaceScopes(packages, opts.scopes);
  if (scopes.length > 0) {
    const inScope = (name: string): boolean => scopes.some((scope) => name.startsWith(`${scope}/`));
    const declared = [...packages.flatMap((p) => p.dependencies ?? []), ...(opts.dependencies ?? [])];
    const known = [...new Set([...packages.map((p) => p.name), ...declared].filter(inScope))].sort().map(escape);
    rules.push({
      name: "unknown-workspace-package",
      severity: "error",
      comment: why(
        `An import names a package of the scope ${scopes.join(", ")}, but the import does not resolve. The name is not a package of this workspace and not a declared dependency. Correct the name, or add the package.`,
      ),
      from: {},
      to: { path: `^(${scopes.map(escape).join("|")})/`, ...(known.length > 0 ? { pathNot: `^(${known.join("|")})(/|$)` } : {}), couldNotResolve: true },
    });
  }
  const apps =
    opts.apps === "private" ? packages.filter((p) => p.private) : packages.filter((p) => (opts.apps ?? []).includes(p.name));
  for (const app of apps) {
    rules.push({
      name: `import-of-the-app-${slug(app.name)}`,
      severity: "error",
      comment: why(`A package imports the app ${app.name}. An app is a leaf: no other package imports it. Move the shared code to a library package.`),
      from: { pathNot: `^${escape(app.dir)}/` },
      to: { path: `^${escape(app.dir)}/` },
    });
  }
  return rules;
}

const slug = (name: string): string => name.replace(/^@/, "").replace(/[^A-Za-z0-9]+/g, "-");

/**
 * The parser of the TypeScript source. dependency-cruiser reads TypeScript with the TypeScript
 * compiler of the repository only for TypeScript 2 to 6. With TypeScript 7 or no TypeScript, it reads
 * TypeScript with swc when @swc/core is installed. Else it reads only JavaScript (acorn): that is
 * enough for a check of built JavaScript.
 */
export function parserOptions(root?: string): Record<string, unknown> {
  if (!root) return {};
  const require = createRequire(join(root, "package.json"));
  try {
    const { version } = require("typescript/package.json") as { version: string };
    // A type-only import is a boundary too. This option needs the TypeScript compiler.
    if (Number(version.split(".")[0]) < 7) return { tsPreCompilationDeps: true };
  } catch {
    // No TypeScript in the repository
  }
  // @swc/core from the repository, or next to this package (a peer dependency)
  for (const from of [require, createRequire(import.meta.url)]) {
    try {
      from.resolve("@swc/core");
      return { parser: "swc" };
    } catch {
      // Not there
    }
  }
  return {};
}

/** The options of `defaultOptions()`. */
export interface DefaultOptionsInput {
  /** The packages of the workspace. The default is `workspacePackages(root)`. */
  packages?: WorkspacePackage[];
  /** The build folders of each package. The default is `["dist", "build"]`. */
  buildFolders?: string[];
}

/** The RegExp sources of the paths that the analysis does not follow: node_modules and the build folders of each package. */
export function doNotFollowPaths(packages: Pick<WorkspacePackage, "dir">[], buildFolders: string[] = BUILD_FOLDERS): string[] {
  const paths = ["(^|/)node_modules/"];
  const dirs = packages.map((p) => p.dir).filter((dir) => dir !== "" && dir !== ".");
  const folders = buildFolders.map((folder) => folder.replace(/^\.\//, "").replace(/\/$/, "")).filter((folder) => folder !== "");
  if (dirs.length > 0 && folders.length > 0) paths.push(`^(${dirs.map(escape).join("|")})/(${folders.map(escape).join("|")})/`);
  return paths;
}

/**
 * The default options: the source of the packages, with type-only imports, resolved as Node resolves
 * an ESM import. There is no `includeOnly`, because it also removes the imports that do not resolve,
 * and the rule not-a-declared-export needs them. The analysis does not follow node_modules and the
 * build folders of the packages: an import of a package stops at its entry. The "types" condition is
 * not used: it resolves to a declaration file, and the analysis excludes declaration files, so a deep
 * import does not show. The `require` condition is not used: an ESM import does not resolve to an
 * entry that is only for `require`.
 */
export function defaultOptions(root?: string, input: DefaultOptionsInput = {}): Record<string, unknown> {
  const packages = input.packages ?? (root ? workspacePackages(root) : []);
  return {
    ...parserOptions(root),
    exclude: {
      path: ["(^|/)node_modules/", "\\.(test|spec|e2e)\\.[cm]?[jt]sx?$", "\\.d\\.[cm]?ts$", "/(test|tests|e2e|__tests__|fixtures)/"],
    },
    doNotFollow: { path: doNotFollowPaths(packages, input.buildFolders) },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default"],
      mainFields: ["module", "main"],
    },
    skipAnalysisNotInRules: true,
  };
}

/** A rule with the reference before its comment, when the comment does not start with it. */
function withReference(rule: Rule, reference?: string): Rule {
  if (!reference || rule.comment?.startsWith(reference)) return rule;
  return { ...rule, comment: rule.comment ? `${reference} ${rule.comment}` : reference };
}

/** The dependency-cruiser configuration of the boundaries for the workspace in the folder `root`. */
export function boundaries(root: string, opts: BoundaryOptions = {}): Config {
  const packages = workspacePackages(root, opts.packages);
  let rootManifest: Record<string, unknown> = {};
  try {
    rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    // No package.json at the root
  }
  const options = { ...defaultOptions(root, { packages, ...(opts.buildFolders ? { buildFolders: opts.buildFolders } : {}) }), ...opts.options };
  const rules = boundaryRules(packages, { ...opts, dependencies: declaredDependencies(rootManifest) });
  return {
    forbidden: [...rules, ...(opts.forbidden ?? []).map((rule) => withReference(rule, opts.reference))],
    options,
  };
}
