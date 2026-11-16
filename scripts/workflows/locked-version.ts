// The version of a package that pnpm-lock.yaml gives for the root package (CI.md, "The packages of the workflow scripts").
// A workflow that installs a package with npm, outside pnpm, starts it before the install:
//
//   version="$(node scripts/workflows/locked-version.ts pnpm-lock.yaml @mark1russell7/text)"
//
// Thus a bump of the lockfile also moves each such install, and no version pin in a workflow stays behind. The script
// imports only Node.js modules, because it starts before each install. It writes the version and a line end to stdout.
// It exits with code 1 when the lockfile has no such package for the root package, and with code 2 for a wrong command.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * This function gives the version that the root importer (`.`) of a pnpm lockfile resolves for a package, or undefined.
 * A lockfile of pnpm 12 has two YAML documents, and the function reads the root importer of each one. A peer suffix of
 * the version (`1.2.3(typescript@6.0.0)`) is not part of the result.
 */
export function lockedVersion(lock: string, name: string): string | undefined {
  const lines = lock.split(/\r?\n/);
  // pnpm writes a key with a "@" or a "/" in quotes
  const keys = new Set([`      ${name}:`, `      '${name}':`, `      "${name}":`]);
  let importers = false;
  let root = false;
  for (const [at, line] of lines.entries()) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      // A key at the start of a line, or the line "---" of the next document, ends the block importers
      importers = line === "importers:";
      root = false;
      continue;
    }
    if (!importers) continue;
    if (/^ {2}\S/.test(line)) {
      root = line === "  .:" || line === "  '.':";
      continue;
    }
    if (!root || !keys.has(line)) continue;
    for (const next of lines.slice(at + 1)) {
      if (!next.startsWith("        ")) break;
      const version = /^ {8}version: '?([^\s'(]+)/.exec(next)?.[1];
      if (version !== undefined) return version;
    }
  }
  return undefined;
}

function main(): number {
  const [file, name, ...rest] = process.argv.slice(2);
  if (file === undefined || name === undefined || rest.length > 0) {
    process.stderr.write("locked-version: give the path of pnpm-lock.yaml and the name of a package\n");
    return 2;
  }
  const version = lockedVersion(readFileSync(file, "utf8"), name);
  if (version === undefined) {
    process.stderr.write(`locked-version: ${file} resolves no ${name} for the root package\n`);
    return 1;
  }
  process.stdout.write(`${version}\n`);
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
