/**
 * The rule `home-module`: a change does not add a value import of a module that only a home of the map of homes
 * imports, for example `node:sqlite` out of `@mark1russell7/sqlite`. An `import type` does not load the module, so it
 * does not break.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addedLines } from "../change.ts";
import { HOMES, type Home } from "../map.ts";
import type { Break, Rule } from "../rule.ts";
import { byCode } from "../workspace.ts";
import { CODE_FILE, repoOf, reposOf, SKIPPED_FILE, unpublishedNote } from "./home-package.ts";

/** A use of a module at run time: the specifier, and the line of the specifier (from 1). */
export interface ModuleUse {
  readonly specifier: string;
  readonly line: number;
}

/** A module that only one home imports. */
export interface HomeModule {
  readonly home: Home;
  readonly specifier: string;
}

/**
 * An `import` or an `export` with a specifier at the start of a line: with `from`, or bare (`import "x"`). The group 1
 * is `type ` of `import type` and `export type`. The statement can have more than one line. It stops at the word
 * `import` or `export`, so a statement does not take the specifier of the next statement.
 */
const STATIC = /^[ \t]*(?:import|export)[ \t]+(type[ \t]+)?(?:(?:(?!\b(?:import|export)\b)[^;=()"'`])*?\bfrom[ \t]*)?(["'])([^"'\r\n]+)\2/gm;

/** A call that loads a module: `import("x")`, `require("x")` or `process.getBuiltinModule("x")`. */
const CALL = /\b(import|require|getBuiltinModule)[ \t]*\([ \t]*(["'`])([^"'`\r\n]+)\2[ \t]*\)/g;

/** The text after `import("x")` that makes it a type: a member that is not a method of a promise. */
const TYPE_MEMBER = /^[ \t]*\.[ \t]*(?!then\b|catch\b|finally\b)[A-Za-z_$]/;

/** This function gives the line (from 1) of each index of `text`, by the starts of the lines. */
function lineAt(text: string): (index: number) => number {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/**
 * This function gives each use of a module that loads the module at run time, in the order of the text. `import type`
 * and `export type` do not load the module. `typeof import("x")` and `import("x").Name` are types. A call after `//`
 * on its line, or on a line of a block comment that starts with `*`, is a comment.
 */
export function moduleUses(text: string): ModuleUse[] {
  const line = lineAt(text);
  const uses: { readonly index: number; readonly use: ModuleUse }[] = [];
  for (const match of text.matchAll(STATIC)) {
    if (match[1] !== undefined) continue;
    const specifier = match[3] as string;
    const index = match.index + match[0].length - specifier.length - 1;
    uses.push({ index, use: { specifier, line: line(index) } });
  }
  for (const match of text.matchAll(CALL)) {
    const start = text.lastIndexOf("\n", match.index) + 1;
    const before = text.slice(start, match.index);
    if (before.includes("//") || /^[ \t]*(?:\*|\/\*)/.test(before)) continue;
    if (match[1] === "import" && (/\btypeof[ \t]*$/.test(before) || TYPE_MEMBER.test(text.slice(match.index + match[0].length)))) continue;
    // `import type x = require("x")` of TypeScript is a type
    if (match[1] === "require" && /^[ \t]*(?:export[ \t]+)?import[ \t]+type\b/.test(before)) continue;
    // A static import has no parentheses after `import`, so a use does not match both forms
    const specifier = match[3] as string;
    const index = match.index + match[0].lastIndexOf(specifier);
    uses.push({ index, use: { specifier, line: line(index) } });
  }
  return uses.sort((a, b) => a.index - b.index).map((item) => item.use);
}

/** This function gives the modules of the homes that a repository can use in their place: on npm, or in a repository. */
export function modulesOf(homes: readonly Home[]): HomeModule[] {
  return homes.filter((home) => home.state === "published" || home.state === "unpublished").flatMap((home) => (home.modules ?? []).map((specifier) => ({ home, specifier })));
}

/** This function gives the message of a break: the module, its home, and the exception. */
export function moduleMessage(file: string, specifier: string, home: Home): string {
  const where = home.packages.map((pkg) => `\`${pkg}\``).join(", ");
  return `${file} imports \`${specifier}\`, a module that only the home of the area ${home.title} (${home.area}) imports. Use ${where}${unpublishedNote(home)} in place of the module. If the home does not have the function, add it to the home in a pull request of ${home.repo}. An \`import type\` does not break.`;
}

export const homeModule: Rule = {
  id: "home-module",
  title: "A change does not add a value import of a module that only a home of the map of homes imports, for example `node:sqlite` out of `@mark1russell7/sqlite`.",
  reason:
    "A package that imports the module of a home writes its own copy of the code of the home: the pragmas, the migrations, the transactions and the recovery. On 2026-11-15, codeatlas and the SQLite procedures of client opened node:sqlite with their own copies, while @mark1russell7/sqlite was on npm. A move to the home ends a copy, and this rule stops a new copy. The check examines only the lines that a change adds, so the imports that exist do not break.",
  fix: "Use the functions of the home. If the home does not have the function, add it to the home in a pull request of the home repository, then use it. An `import type` of the module does not break. A real exception (for example, a test that writes a broken file) goes in `ignore` with a reason.",
  sources: [{ repo: "private", rule: "home-module", doc: "docs/STRATEGY.md (2026-11-15, a gate holds each move to a home)" }],
  options: {
    scope: {
      type: "string",
      default: "change",
      description: "`change`: only the lines that the change adds (a pull request, or `--base`). `all`: each line of each tracked file, for a sweep of the imports that exist.",
    },
  },
  changeScoped: true,
  failsFrom: "2026-11-30",
  check(context, options) {
    const scope = options["scope"];
    if (scope !== "change" && scope !== "all") throw new Error(`The option scope is "change" or "all", not ${JSON.stringify(scope)}.`);
    const repo = repoOf(context);
    const modules = modulesOf(HOMES).filter((item) => !reposOf(item.home).includes(repo ?? ""));
    if (modules.length === 0) return [];
    let files: readonly string[];
    let added: ReadonlyMap<string, ReadonlySet<number>> | undefined;
    if (scope === "change") {
      added = addedLines(context);
      if (added === undefined) return { skipped: "no change: the rule examines the lines that a pull request or --base adds (option scope: all examines each line)" };
      files = [...added.keys()];
    } else {
      const tracked = context.gitFiles();
      if (tracked === undefined) return { skipped: "the root is not in a git repository" };
      files = tracked;
    }
    const breaks: Break[] = [];
    for (const file of files.filter((path) => CODE_FILE.test(path) && !SKIPPED_FILE.test(path)).sort(byCode)) {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      const lines = added?.get(file);
      for (const use of moduleUses(text)) {
        if (lines !== undefined && !lines.has(use.line)) continue;
        const found = modules.find((item) => item.specifier === use.specifier);
        if (found !== undefined) breaks.push({ file, line: use.line, message: moduleMessage(file, use.specifier, found.home) });
      }
    }
    return breaks;
  },
};
