/**
 * The rule `home-shape`: a change does not add a function that contains the body of an exported function of another home.
 * This is also true for a copy with another name.
 */
import { containsShape, functionsOf, type FunctionShape } from "@mark1russell7/code-shape";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addedLines, rangeOf } from "../change.ts";
import { HOME_SHAPES } from "../home-shapes.ts";
import { HOMES, type Home } from "../map.ts";
import { showFiles, type Break, type Rule } from "../rule.ts";
import { byCode } from "../workspace.ts";
import { CODE_FILE, repoOf, reposOf, SKIPPED_FILE } from "./home-package.ts";

/** One function of a home: its name, the specifier to import it from (the package, or an entry of it), its home and the shape tokens of its body. */
export interface HomeShape {
  readonly name: string;
  readonly pkg: string;
  readonly home: Home;
  readonly tokens: readonly string[];
}

/** The files of TypeScript: the read removes their types first. */
const TYPESCRIPT_FILE = /\.[cm]?tsx?$/;

/**
 * This function gives the functions of the homes of `index` that a repository can use. These are the homes on npm, and
 * the homes in a repository with a pin. A package that no home of `homes` names gives no function.
 */
export function homeShapesOf(homes: readonly Home[], index: typeof HOME_SHAPES = HOME_SHAPES): HomeShape[] {
  const usable = homes.filter((home) => home.state === "published" || home.state === "unpublished");
  return Object.entries(index).flatMap(([pkg, entry]) => {
    const home = usable.find((item) => item.packages.includes(pkg));
    return home === undefined ? [] : entry.functions.map((fn) => ({ name: fn.name, pkg: fn.from ?? pkg, home, tokens: fn.tokens }));
  });
}

/** This function gives the top-level functions of a source, or an empty list when the read fails (for example an `enum` in TypeScript). */
export function shapesOfSource(file: string, text: string): FunctionShape[] {
  try {
    return functionsOf(text, { typescript: TYPESCRIPT_FILE.test(file) });
  } catch {
    return [];
  }
}

/**
 * This function gives the lines of each function. They start at the line of its name. They stop at the line before the
 * next function, or at the last line. The tokens of a function do not give its last line, so a line after its end counts too.
 */
export function spansOf(functions: readonly FunctionShape[], lineCount: number): (readonly [number, number])[] {
  const starts = functions.map((fn) => fn.line);
  return functions.map((fn, index) => {
    const next = starts.slice(index + 1).find((line) => line > fn.line);
    return [fn.line, next === undefined ? lineCount : next - 1] as const;
  });
}

/** This function gives the first function of `shapes` whose body is a contiguous run of `tokens`, or undefined. */
export function containedHome(tokens: readonly string[], shapes: readonly HomeShape[]): HomeShape | undefined {
  return shapes.find((shape) => containsShape(tokens, shape.tokens));
}

/** This function gives the message of a break. */
export function shapeMessage(name: string, file: string, line: number, shape: HomeShape): string {
  return `${name} at ${file}:${line} contains the body of ${shape.name} of ${shape.pkg}. Import ${shape.name} from ${shape.pkg}.`;
}

export const homeShape: Rule = {
  id: "home-shape",
  title: "A change does not add a function that contains the body of an exported function of another home of the map of homes, also with another name.",
  reason:
    "Each area of code has one home package (conventions map). The rule home-package finds a copy by its name, so it does not find a renamed copy, or a copy that puts the body of a home function in a bigger function. On 2026-11-26 the tenets audit found local readers of records (recordOf, numberOf, textOf) with the bodies of the readers of @mark1russell7/optional/read. This rule compares the shape of the body: each name and each literal becomes its kind, so a copy with other names has the same tokens. The index of the shapes is src/home-shapes.ts, from the published code of each home. The rule examines only the functions that a change adds or changes, so the copies that exist do not break.",
  fix: "Import the function of the home in place of the copy. A function that only has the shape of a home function and does another thing is rare: it goes in `ignore` with a reason.",
  sources: [{ repo: "private", rule: "direction-18", doc: "a decision of 2026-11-02: one map of homes, checked when the code is written" }],
  options: {
    scope: {
      type: "string",
      default: "change",
      description: "`change`: only the functions with a line that the change adds (a pull request, or `--base`). `all`: each function of each tracked file, for a sweep of the copies that exist.",
    },
    level: {
      type: "string",
      default: "warn",
      description: "`warn`: a break is a warning, until a measure over the repositories gives the count of the false breaks. `fail`: a break fails the check.",
    },
  },
  changeScoped: true,
  failsFrom: "2026-12-10",
  warnOnly(options) {
    return options["level"] === "fail" ? undefined : "The rule warns until a measure of its breaks over the repositories (the option level is warn).";
  },
  check(context, options) {
    const scope = options["scope"];
    if (scope !== "change" && scope !== "all") throw new Error(`The option scope is "change" or "all", not ${JSON.stringify(scope)}.`);
    const level = options["level"];
    if (level !== "warn" && level !== "fail") throw new Error(`The option level is "warn" or "fail", not ${JSON.stringify(level)}.`);
    const repo = repoOf(context);
    const shapes = homeShapesOf(HOMES).filter((shape) => !reposOf(shape.home).includes(repo ?? ""));
    if (shapes.length === 0) return [];
    let files: readonly string[];
    let added: ReadonlyMap<string, ReadonlySet<number>> | undefined;
    let base: string | undefined;
    if (scope === "change") {
      added = addedLines(context);
      if (added === undefined) return { skipped: "no change: the rule examines the functions that a pull request or --base changes (option scope: all examines each function)" };
      const range = rangeOf(context);
      base = "skipped" in range ? undefined : range.ends[0];
      files = [...added.keys()];
    } else {
      const tracked = context.gitFiles();
      if (tracked === undefined) return { skipped: "the root is not in a git repository" };
      files = tracked;
    }
    files = files.filter((path) => CODE_FILE.test(path) && !SKIPPED_FILE.test(path)).sort(byCode);
    // The text of each file at the base: a function that contains the same home body there is a copy that exists.
    const before = base === undefined ? files.map(() => undefined) : showFiles(context, files.map((file) => `${base}:${file}`));
    const breaks: Break[] = [];
    files.forEach((file, fileIndex) => {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        return;
      }
      const lines = added?.get(file);
      const functions = shapesOfSource(file, text);
      const spans = spansOf(functions, text.split(/\r?\n/).length);
      const baseText = before[fileIndex];
      const baseFunctions = baseText === undefined ? [] : shapesOfSource(file, baseText);
      functions.forEach((fn, index) => {
        const [from, to] = spans[index] ?? [fn.line, fn.line];
        if (lines !== undefined && ![...lines].some((line) => line >= from && line <= to)) return;
        const shape = containedHome(fn.tokens, shapes);
        if (shape === undefined) return;
        const old = baseFunctions.find((item) => item.name === fn.name);
        if (old !== undefined && containsShape(old.tokens, shape.tokens)) return;
        breaks.push({ file, line: fn.line, message: shapeMessage(fn.name, file, fn.line, shape) });
      });
    });
    return breaks;
  },
};
