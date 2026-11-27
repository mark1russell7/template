// The entry points of a packed manifest, and the entry points that the tarball does not hold.
//
// A package.json can point at files that the tarball does not have: for example, the build of a
// package did not run before the pack, so "main" names dist/index.js and dist is absent. npm then
// publishes a package that no user can import (@mark1russell7/otel-sink 0.1.0, 2026-11-27). pack.ts
// reads the packed package.json and the files of each tarball, and stops for each missing entry.
//
// The fields: main, module, browser (a string), types, typings, each bin, and each target of
// exports (conditions and subpaths at any depth). A target with "*" is a pattern: at least one file
// of the tarball must match it. A null target excludes a subpath, so it names no file.

/** One entry point: the field that names it, and the path in the package. */
export interface EntryPoint {
  readonly field: string;
  readonly path: string;
}

/** This function gives the path of a manifest field in the form of a tarball file name. */
export function normalEntryPath(path: string): string {
  return path.replace(/^(\.\/)+/u, "").replace(/\/{2,}/gu, "/");
}

function exportTargets(value: unknown, field: string, out: EntryPoint[]): void {
  if (typeof value === "string") {
    out.push({ field, path: value });
  } else if (Array.isArray(value)) {
    // A fallback array: each item is a target of its own.
    value.forEach((item, index) => exportTargets(item, `${field}[${index}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) exportTargets(item, `${field}["${key}"]`, out);
  }
}

/** This function gives each entry point of a manifest. */
export function entryPoints(manifest: Record<string, unknown>): EntryPoint[] {
  const out: EntryPoint[] = [];
  for (const field of ["main", "module", "browser", "types", "typings"]) {
    const value = manifest[field];
    if (typeof value === "string" && value !== "") out.push({ field, path: value });
  }
  const bin = manifest["bin"];
  if (typeof bin === "string") out.push({ field: "bin", path: bin });
  else if (bin !== null && typeof bin === "object") {
    for (const [name, path] of Object.entries(bin as Record<string, unknown>)) {
      if (typeof path === "string") out.push({ field: `bin["${name}"]`, path });
    }
  }
  if (manifest["exports"] !== undefined) exportTargets(manifest["exports"], "exports", out);
  return out;
}

function patternMatches(pattern: string, files: ReadonlySet<string>): boolean {
  const [head = "", ...rest] = pattern.split("*");
  const tail = rest.join("*");
  if (rest.length > 1) return [...files].some((file) => file.startsWith(head));
  return [...files].some((file) => file.startsWith(head) && file.endsWith(tail) && file.length >= head.length + tail.length);
}

/** This function gives each entry point of the manifest that names no file of the tarball. */
export function missingEntryPoints(manifest: Record<string, unknown>, files: Iterable<string>): EntryPoint[] {
  const have = new Set([...files].map(normalEntryPath));
  return entryPoints(manifest).filter(({ field, path }) => {
    const normal = normalEntryPath(path);
    if (normal.includes("*")) return !patternMatches(normal, have);
    // Only "main" can name a file with no extension, or a folder with an index file (the CommonJS
    // rules). The other fields name the file itself.
    const candidates = field === "main" ? [normal, `${normal}.js`, `${normal}.json`, `${normal}.node`, `${normal}/index.js`] : [normal];
    return !candidates.some((candidate) => have.has(candidate));
  });
}
