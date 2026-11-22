import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SRC, "../../..");

/** This function gives the specifiers of the imports and re-exports that stay at run time. `import type` goes away with the types. */
function runtimeImports(source: string): string[] {
  const specifiers: string[] = [];
  let typeOnly = false;
  for (const line of source.split("\n")) {
    if (/^(?:import|export)\b/u.test(line)) typeOnly = /^(?:import|export) type\b/u.test(line);
    const specifier = /\bfrom "([^"]+)";$/u.exec(line)?.[1] ?? /^import "([^"]+)";$/u.exec(line)?.[1] ?? /\bimport\("([^"]+)"\)/u.exec(line)?.[1];
    if (specifier !== undefined && !typeOnly) specifiers.push(specifier);
  }
  return specifiers;
}

/** This function gives each file that an entry of `src` reaches at run time, and each import that is not Node.js or a file. */
function reachable(entry: string): { files: string[]; outside: string[] } {
  const files = new Set<string>();
  const outside: string[] = [];
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const specifier of runtimeImports(readFileSync(file, "utf8"))) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith("./") || specifier.startsWith("../")) visit(join(dirname(file), specifier));
      else outside.push(`${relative(SRC, file)}: ${specifier}`);
    }
  };
  visit(join(SRC, entry));
  return { files: [...files].map((file) => relative(SRC, file).replaceAll("\\", "/")).sort(), outside };
}

/** This function gives the folders of `src` in the sparse checkout of the shared actions of reusable-pages.yml. */
function sparseFolders(): string[] {
  const workflow = readFileSync(join(ROOT, ".github/workflows/reusable-pages.yml"), "utf8");
  const start = workflow.indexOf("name: Shared actions (the site config, site-pages and the site check)");
  const end = workflow.indexOf("persist-credentials", start);
  expect(start).toBeGreaterThan(-1);
  return workflow
    .slice(start, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("packages/site-pages/src/"))
    .map((line) => line.slice("packages/site-pages/src/".length));
}

describe("cli.ts, the bin site-pages", () => {
  it("imports only Node.js and files of the sparse checkout of reusable-pages, so the site-pages action starts it with no install", () => {
    const folders = sparseFolders();
    expect(folders).toEqual(expect.arrayContaining(["check", "data", "render"]));
    const { files, outside } = reachable("cli.ts");
    expect(outside).toEqual([]);
    expect(files).toEqual(expect.arrayContaining(["cli.ts", "build.ts", "render/releases.ts", "render/status.ts"]));
    // The cone mode of the checkout also gives the files directly in src, the parent of each folder.
    expect(files.filter((file) => file.includes("/") && !folders.some((folder) => file.startsWith(`${folder}/`)))).toEqual([]);
  });

  it("finds an npm import and a dynamic import, and keeps a type import out", () => {
    const source = ['import { a } from "./a.ts";', 'import type { B } from "../b.ts";', "import {", "  c,", '} from "@scope/c";', 'export { d } from "./d.ts";', 'const e = await import("e");'];
    expect(runtimeImports(source.join("\n"))).toEqual(["./a.ts", "@scope/c", "./d.ts", "e"]);
  });

  it("is what the site-pages action starts when the input version is empty, with no default range of npm", () => {
    const action = readFileSync(join(ROOT, ".github/actions/site-pages/action.yml"), "utf8");
    expect(action).toContain('node "$GITHUB_ACTION_PATH/../../../packages/site-pages/src/cli.ts" "${args[@]}"');
    expect(action).toContain('"@mark1russell7/site-pages@$SP_VERSION"');
    expect(action).not.toMatch(/SP_VERSION:-/u);
  });
});
