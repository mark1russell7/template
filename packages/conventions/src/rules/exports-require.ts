/**
 * The rule `exports-require`: each entry of the published `exports` that resolves for `import` also resolves for
 * `require`. A conditional entry with `import` has a `default` (or a `require`).
 */
import { keyLine, lineOf, rootAndCodePackages, type Break, type Manifest, type PackageInfo, type Rule } from "../rule.ts";

/** The conditions of an ES module import in Node. Node also adds `default`. */
export const IMPORT_CONDITIONS: ReadonlySet<string> = new Set(["import", "node", "default"]);

/** The conditions of a CommonJS `require()` in Node. Node also adds `default`. */
export const REQUIRE_CONDITIONS: ReadonlySet<string> = new Set(["require", "node", "default"]);

/** A key of a value of `exports`: a key of an object, or an index of an array. */
export type ExportKey = string | number;

/**
 * The result of a resolution of a value of `exports` for a set of conditions. A target has its path in the value.
 * The value null tells that the package keeps the entry from these conditions (a target null). The value undefined
 * tells that no condition matches.
 */
export type Resolution = { readonly target: string; readonly path: readonly ExportKey[] } | null | undefined;

/**
 * This function resolves a value of `exports` for a set of conditions, as PACKAGE_TARGET_RESOLVE of Node does. A
 * string is a target. A null is a target null. An array gives its first item that resolves, else null when an item is
 * null. An object examines its keys in their order. A key `default` or a key in `conditions` gives the resolution of
 * its value. When no condition of that value matches, the object examines its next key.
 */
export function resolveExport(value: unknown, conditions: ReadonlySet<string>, path: readonly ExportKey[] = []): Resolution {
  if (typeof value === "string") return { target: value, path };
  if (value === null) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    // As Node does: an item null is kept, and a later item can still resolve
    let excluded = false;
    for (const [index, item] of value.entries()) {
      const resolved = resolveExport(item, conditions, [...path, index]);
      if (resolved === null) excluded = true;
      else if (resolved !== undefined) return resolved;
    }
    return excluded ? null : undefined;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key !== "default" && !conditions.has(key)) continue;
      const resolved = resolveExport(item, conditions, [...path, key]);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

/**
 * This function gives the entries of a value of `exports`, by subpath. A string, an array or an object of conditions
 * is the entry of the subpath `.`. It gives an empty list when the object mixes subpaths and conditions: Node refuses
 * that value.
 */
export function exportEntries(exports: unknown): [string, unknown][] {
  if (typeof exports !== "object" || exports === null || Array.isArray(exports)) return exports === undefined ? [] : [[".", exports]];
  const keys = Object.keys(exports);
  const subpaths = keys.filter((key) => key.startsWith("."));
  if (subpaths.length === keys.length) return Object.entries(exports as Record<string, unknown>);
  return subpaths.length === 0 ? [[".", exports]] : [];
}

/** This function gives the value at a path in a value of JSON, or undefined. */
function valueAt(value: unknown, path: readonly ExportKey[]): unknown {
  let at = value;
  for (const key of path) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<string | number, unknown>)[key];
  }
  return at;
}

/** This function gives the index after the end of the object that contains the index `from` (after its `}`), or -1. */
function objectEnd(text: string, from: number): number {
  let depth = 0;
  for (let at = from; at < text.length; at++) {
    const char = text.charAt(at);
    if (char === '"') {
      // Skip the string, with its escapes
      at++;
      while (at < text.length && text.charAt(at) !== '"') at += text.charAt(at) === "\\" ? 2 : 1;
    } else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      if (depth === 0) return char === "}" ? at + 1 : -1;
      depth--;
    }
  }
  return -1;
}

/**
 * This function gives the text of `package.json` with the member `"default": target` at the end of the object at
 * `objectPath`, in the format of the file. The object holds the member `"import": target`. The function gives undefined
 * when it cannot find the object, or when the changed text does not parse as the manifest with the new member.
 */
export function withDefault(pkg: PackageInfo, objectPath: readonly ExportKey[], target: string): string | undefined {
  const expected = structuredClone(pkg.manifest) as Manifest;
  const object = valueAt(expected, objectPath);
  if (typeof object !== "object" || object === null || Array.isArray(object) || "default" in object) return undefined;
  (object as Record<string, unknown>)["default"] = target;
  const wanted = JSON.stringify(expected);
  const eol = pkg.text.includes("\r\n") ? "\r\n" : "\n";
  const member = new RegExp(`"import"\\s*:\\s*${JSON.stringify(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
  for (const match of pkg.text.matchAll(member)) {
    const start = match.index ?? 0;
    const end = objectEnd(pkg.text, start + match[0].length);
    if (end < 0) continue;
    const close = end - 1;
    // The last member ends at the last character before the `}` that is not a space
    let last = close - 1;
    while (last > start && /\s/.test(pkg.text.charAt(last))) last--;
    // An object with a line for each member gets a new line with the indent of the member `import`, an object on one line gets ", "
    const multiline = pkg.text.slice(last + 1, close).includes("\n");
    const indent = /^[ \t]*/.exec(pkg.text.slice(pkg.text.lastIndexOf("\n", start) + 1))?.[0] ?? "";
    const separator = multiline ? `,${eol}${indent}` : ", ";
    const after = `${pkg.text.slice(0, last + 1)}${separator}"default": ${JSON.stringify(target)}${pkg.text.slice(last + 1)}`;
    try {
      if (JSON.stringify(JSON.parse(after)) === wanted) return after;
    } catch {
      // The next member `import` with this target, if any
    }
  }
  return undefined;
}

/** This function gives the published `exports` of a manifest: `publishConfig.exports` when it exists, else `exports`. */
function publishedExports(manifest: Manifest): { readonly field: "publishConfig.exports" | "exports"; readonly value: unknown } {
  const published = manifest["publishConfig"];
  if (typeof published === "object" && published !== null && (published as Manifest)["exports"] !== undefined) {
    return { field: "publishConfig.exports", value: (published as Manifest)["exports"] };
  }
  return { field: "exports", value: manifest["exports"] };
}

export const exportsRequire: Rule = {
  id: "exports-require",
  title: "Each entry of the published `exports` that resolves for `import` also resolves for `require`: a conditional entry with `import` has a `default`.",
  reason:
    "Node resolves `exports` by conditions. A CommonJS loader asks for `require`, `node` and `default`. An entry with only `types` and `import` has no target for these conditions, so `require()` of the package stops with ERR_PACKAGE_PATH_NOT_EXPORTED. This occurs also on Node 22 and 24, which can load an ES module with `require()`. On 2026-11-12 the config loader of Playwright, which is CommonJS, could not load six rigor packages for this reason (rigor#196).",
  fix: 'Add `"default"` with the target of `"import"` as the last member of the entry, for example `{ "types": "./build/index.d.ts", "import": "./build/index.js", "default": "./build/index.js" }`. `conventions fix` writes it. A target null for `require` keeps a package from CommonJS on purpose, and the rule accepts it. A module with a top-level `await` cannot load with `require()`: give it a `require` target with a CommonJS build.',
  sources: [
    { repo: "rigor", rule: "exports-require", doc: "packages/*/package.json (publishConfig.exports, rigor#196)" },
    { repo: "packing", rule: "exports-default", doc: "packages/packing/package.json (publishConfig.exports)" },
    { repo: "highways", rule: "exports-default", doc: "packages/core/package.json (publishConfig.exports)" },
    { repo: "layout-contract", rule: "exports-default", doc: "packages/layout-contract/package.json (publishConfig.exports)" },
    { repo: "vex", rule: "exports-default", doc: "packages/core/package.json (publishConfig.exports)" },
  ],
  options: {},
  failsFrom: "2026-11-27",
  check(context) {
    const breaks: Break[] = [];
    for (const pkg of rootAndCodePackages(context)) {
      if (pkg.manifest["private"] === true) continue;
      const name = String(pkg.manifest["name"] ?? pkg.folder);
      const { field, value } = publishedExports(pkg.manifest);
      const base: ExportKey[] = field === "exports" ? ["exports"] : ["publishConfig", "exports"];
      const fieldLine = field === "exports" ? lineOf(pkg.text, '"exports"') : keyLine(pkg.text, "publishConfig", "exports");
      // A field that is an object of subpaths has a key for each entry. Else the field is the entry of the subpath "."
      const subpaths = typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).every((key) => key.startsWith("."));
      for (const [subpath, entry] of exportEntries(value)) {
        const imported = resolveExport(entry, IMPORT_CONDITIONS);
        if (imported === undefined || imported === null) continue;
        if (resolveExport(entry, REQUIRE_CONDITIONS) !== undefined) continue;
        // The path of the entry in the manifest: the field, then the subpath when the field is an object of subpaths
        const entryPath = subpaths ? [...base, subpath] : base;
        const found = [...entryPath, ...imported.path];
        const parent = found.slice(0, -1);
        const after = found[found.length - 1] === "import" ? withDefault(pkg, parent, imported.target) : undefined;
        const line = (subpaths ? keyLine(pkg.text, field === "exports" ? "exports" : "publishConfig", subpath) : undefined) ?? fieldLine;
        breaks.push({
          file: pkg.file,
          ...(line === undefined ? {} : { line }),
          message: `The entry "${subpath}" of ${field} of ${name} resolves for import (${imported.target}) and not for require: require() of it stops with ERR_PACKAGE_PATH_NOT_EXPORTED.`,
          ...(after === undefined
            ? {
                fix: `Give the entry "${subpath}" of ${field} a target for require: "default": ${JSON.stringify(imported.target)} as the last member of the object that holds "import", or "require": ${JSON.stringify(imported.target)} before its "default".`,
              }
            : { edits: [{ file: pkg.file, before: pkg.text, after }] }),
        });
      }
    }
    return breaks;
  },
};
