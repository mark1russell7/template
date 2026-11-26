// Writes the index of the shapes of the home functions: packages/conventions/src/home-shapes.ts.
// The rule home-shape of conventions reads it. A function of a repository that contains the body of an exported
// function of a home is a copy that belongs in that home, also with another name (STRATEGY direction 18, the map of homes).
//
//   node scripts/homes/shapes.ts
//
// For each package of a published home of the map (indexPackages of exports.ts), the script takes the tarball of its
// latest version from npm, as exports.ts does. It reads the names of the exports of each entry from its API report, and the top-level
// functions of each built JavaScript file with functionsOf of @mark1russell7/code-shape. For each exported function it keeps
// the body (bodyTokens): the tokens in the braces, with no parameters and no first `return`. Thus a function that puts the
// body in its own body, also in an `if`, contains it. It keeps a body of MIN_SHAPE_TOKENS to MAX_SHAPE_TOKENS tokens, and
// one function for each shape: the first in the order of the map.
// Thus the index is the published code, not the source of a branch. Run it again after each release of a home package
// that changes the body of an export, and after each change of the published homes of the map.
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { functionsOf, MIN_SHAPE_TOKENS, shapeHash, type FunctionShape } from "@mark1russell7/code-shape";
import { HOMES } from "../../packages/conventions/src/map.ts";
import { packageReport } from "@mark1russell7/api-report";
import { indexPackages, unpackPackage, valueNames } from "./exports.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SHAPES_FILE: string = join(ROOT, "packages/conventions/src/home-shapes.ts");

/**
 * The most tokens of the body of a function of the index. A longer body is rare as a whole copy, and it makes the index
 * big. On 2026-11-26 the 88 home packages had 4234 exported bodies of 16 to 400 tokens (2.7 MB as tokens), and 1330
 * bodies of 16 to 50 tokens (291 KB). A small helper is the usual copy, so the index keeps the short bodies.
 */
export const MAX_SHAPE_TOKENS: number = 50;

/** The built JavaScript files of a package, and the files that the index does not read. */
const BUILT_FILE = /\.[cm]?js$/;
const SKIPPED = /(?:^|[\\/])node_modules[\\/]/;

/** One function of the index: its exported name, the entry to import it from when it is not the root, and the shape tokens of its body. */
export interface HomeFunction {
  readonly name: string;
  readonly from?: string;
  readonly tokens: readonly string[];
}

/** The functions of one home package at one version. */
export interface PackageShapes {
  readonly version: string;
  readonly functions: readonly HomeFunction[];
}

/**
 * This function gives the body of the tokens of a function: the tokens in the braces after the parameters, with no first
 * `return`. An arrow function with an expression body has a block with one `return` in its tokens (functionsOf), so its
 * body is the expression. It gives the tokens as they are when they have no parameters and braces.
 */
export function bodyTokens(tokens: readonly string[]): readonly string[] {
  const open = tokens.indexOf("(");
  if (open < 0) return tokens;
  let depth = 0;
  let close = -1;
  for (let index = open; index < tokens.length; index++) {
    if (tokens[index] === "(") depth++;
    else if (tokens[index] === ")" && --depth === 0) {
      close = index;
      break;
    }
  }
  if (close < 0 || tokens[close + 1] !== "{" || tokens[tokens.length - 1] !== "}") return tokens;
  const body = tokens.slice(close + 2, -1);
  return body[0] === "return" ? body.slice(1) : body;
}

/**
 * This function gives the names of the values of each entry of an API report, keyed by the entry (`.`, `./read`), in
 * the order of the report. It gives no types and no `default`.
 */
export function entryNames(report: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  let entry: string | undefined;
  const lines: string[] = [];
  const flush = (): void => {
    if (entry !== undefined) entries.set(entry, valueNames(lines.join("\n")));
    lines.length = 0;
  };
  for (const line of report.split("\n")) {
    const header = /^## (\.\S*) \(/.exec(line);
    if (header?.[1] !== undefined) {
      flush();
      entry = header[1];
    } else if (line.startsWith("## ")) {
      flush();
      entry = undefined;
    } else if (entry !== undefined) lines.push(line);
  }
  flush();
  return entries;
}

/**
 * This function gives the specifier that imports a name of a package: the package when its root entry exports the name,
 * else the package and the first entry that exports it, for example `@o/p/read`. It gives undefined when no entry exports it.
 */
export function specifierOf(pkg: string, entries: ReadonlyMap<string, readonly string[]>, name: string): string | undefined {
  if (entries.get(".")?.includes(name) === true) return pkg;
  for (const [entry, names] of entries) if (names.includes(name)) return `${pkg}${entry.slice(1)}`;
  return undefined;
}

/** One package before the selection: its version, the names of each entry, and the functions of its built files. */
export interface PackageFunctions {
  readonly version: string;
  readonly entries: ReadonlyMap<string, readonly string[]>;
  readonly functions: readonly FunctionShape[];
}

/**
 * This function selects the functions of the index from the functions of each package, in the order of `packages`:
 * each exported function with a body (bodyTokens) of MIN_SHAPE_TOKENS to `max` tokens. A shape that an earlier function has already is not
 * kept again, also in another package. A bundler can give a copy of a name a suffix `$1`, so the suffix goes first.
 */
export function selectShapes(packages: readonly (readonly [string, PackageFunctions])[], max: number = MAX_SHAPE_TOKENS): Record<string, PackageShapes> {
  const seen = new Set<string>();
  const index: Record<string, PackageShapes> = {};
  for (const [name, entry] of packages) {
    const functions: HomeFunction[] = [];
    for (const fn of entry.functions) {
      const exported = fn.name.replace(/\$\d+$/, "");
      const body = bodyTokens(fn.tokens);
      const from = specifierOf(name, entry.entries, exported);
      if (from === undefined || body.length < MIN_SHAPE_TOKENS || body.length > max) continue;
      const hash = shapeHash(body);
      if (seen.has(hash)) continue;
      seen.add(hash);
      functions.push({ name: exported, ...(from === name ? {} : { from }), tokens: body });
    }
    index[name] = { version: entry.version, functions: functions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
  }
  return index;
}

/** This function gives the text of the index module: one line for each function, under its package. */
export function shapesModule(index: Readonly<Record<string, PackageShapes>>): string {
  const lines = [
    "// Generated by scripts/homes/shapes.ts from the latest version of each home package on npm. Do not edit by hand.",
    "/** The shape tokens of the bodies of the exported functions of each home package, with the version that the functions come from. A function that the root entry does not export gives its entry in `from`. */",
    "export const HOME_SHAPES: Readonly<Record<string, { readonly version: string; readonly functions: readonly { readonly name: string; readonly from?: string; readonly tokens: readonly string[] }[] }>> = {",
  ];
  for (const name of Object.keys(index).sort()) {
    const entry = index[name];
    if (entry === undefined) continue;
    if (entry.functions.length === 0) {
      lines.push(`  ${JSON.stringify(name)}: { version: ${JSON.stringify(entry.version)}, functions: [] },`);
      continue;
    }
    lines.push(`  ${JSON.stringify(name)}: { version: ${JSON.stringify(entry.version)}, functions: [`);
    for (const fn of entry.functions) lines.push(`    { name: ${JSON.stringify(fn.name)}, ${fn.from === undefined ? "" : `from: ${JSON.stringify(fn.from)}, `}tokens: ${JSON.stringify(fn.tokens)} },`);
    lines.push("  ] },");
  }
  lines.push("};", "");
  return lines.join("\n");
}

/** This function gives the top-level functions of each built JavaScript file of a folder, in the order of the paths. */
export function builtFunctions(dir: string): FunctionShape[] {
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => BUILT_FILE.test(file) && !SKIPPED.test(file))
    .sort();
  return files.flatMap((file) => {
    try {
      return functionsOf(readFileSync(join(dir, file), "utf8"));
    } catch {
      return [];
    }
  });
}

async function main(): Promise<number> {
  const temp = mkdtempSync(join(tmpdir(), "home-shapes-"));
  try {
    const packages: [string, PackageFunctions][] = [];
    for (const name of [...new Set(indexPackages(HOMES))]) {
      const unpacked = await unpackPackage(name, "latest", temp);
      packages.push([name, { version: unpacked.version, entries: entryNames(packageReport(unpacked.dir)), functions: builtFunctions(unpacked.dir) }]);
    }
    const index = selectShapes(packages);
    const text = shapesModule(index);
    writeFileSync(SHAPES_FILE, text);
    const count = Object.values(index).reduce((sum, entry) => sum + entry.functions.length, 0);
    process.stdout.write(`${Object.keys(index).length} packages, ${count} functions, ${Buffer.byteLength(text)} bytes: packages/conventions/src/home-shapes.ts\n`);
    return 0;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
