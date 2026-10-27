/**
 * The shape of a rule, the facts that a rule reads (the context), and small helpers for the rules.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp } from "./workspace.ts";

/** A row of the invariants audit that a rule comes from: the repository, the id of the rule in that audit, and the document line. */
export interface AuditSource {
  readonly repo: string;
  readonly rule: string;
  readonly doc: string;
}

/** A break of a rule: the file, the line when the rule knows it, and what is wrong. */
export interface Break {
  /** The file, relative to the root, with `/`. */
  readonly file: string;
  /** The line in the file, from 1. */
  readonly line?: number;
  readonly message: string;
  /** A fix for this break. The fix of the rule applies when this field is missing. */
  readonly fix?: string;
}

/** A value of an option of a rule. */
export type OptionValue = string | number | boolean | readonly string[];

/** The options of a rule, after the defaults. */
export type Options = Readonly<Record<string, OptionValue>>;

/** The description of one option of a rule. */
export interface OptionSpec {
  readonly type: "string" | "number" | "boolean" | "strings";
  readonly default: OptionValue;
  readonly description: string;
}

/** A field of `package.json`, as the rules read it. */
export type Manifest = Readonly<Record<string, unknown>>;

/** A `package.json` file of the repository. */
export interface PackageInfo {
  /** The folder, relative to the root, with `/`. The root is `""`. */
  readonly folder: string;
  /** The absolute path of the folder. */
  readonly dir: string;
  /** The path of the `package.json` file, relative to the root, with `/`. */
  readonly file: string;
  /** The text of the `package.json` file. */
  readonly text: string;
  readonly manifest: Manifest;
}

/** The facts of the repository that a rule reads. */
export interface RuleContext {
  /** The absolute path of the root. */
  readonly root: string;
  /** The root `package.json`. */
  readonly rootPackage: PackageInfo;
  /** The packages of the workspace, without the root. A repository with no workspace has no packages here. */
  readonly packages: readonly PackageInfo[];
  /** The environment variables. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The base commit that `--base` gives, if any. */
  readonly base?: string;
  /** This function gives the files that git tracks, relative to the root, or undefined when the root is not in a git repository. */
  gitFiles(): readonly string[] | undefined;
  /** This function starts git in the root, and gives its output, or undefined when git fails. */
  git(args: readonly string[]): string | undefined;
}

/** The result of a rule: a list of breaks (empty when the rule passes), or the reason why the rule did not start. */
export type RuleOutcome = readonly Break[] | { readonly skipped: string };

/** One convention, as a machine check. */
export interface Rule {
  /** A short id in kebab case. The configuration names the rule with this id. */
  readonly id: string;
  /** The rule in one sentence. */
  readonly title: string;
  /** Why the rule exists. */
  readonly reason: string;
  /** How to correct a break. */
  readonly fix: string;
  /** The rows of the invariants audit that the rule comes from. */
  readonly sources: readonly AuditSource[];
  /** The options of the rule, with their defaults. */
  readonly options: Readonly<Record<string, OptionSpec>>;
  check(context: RuleContext, options: Options): RuleOutcome;
}

/** The fields of `package.json` that hold dependencies. */
export const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

/** This function gives each entry of a field of `package.json` that maps names to specifiers. */
export function specifiersOf(manifest: Manifest, field: string): [string, string][] {
  const value = manifest[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string");
}

/** This function gives the line (from 1) of the first line of `text` that contains `needle`, from the line `from`. */
export function lineOf(text: string, needle: string, from = 1): number | undefined {
  const lines = text.split(/\r?\n/);
  for (let index = Math.max(0, from - 1); index < lines.length; index++) if ((lines[index] ?? "").includes(needle)) return index + 1;
  return undefined;
}

/** This function gives the line of the key `"name":` in `package.json`, after the line of the field `field`. */
export function keyLine(text: string, field: string, name: string): number | undefined {
  const start = lineOf(text, `"${field}"`) ?? 1;
  return lineOf(text, `${JSON.stringify(name)}:`, start) ?? lineOf(text, JSON.stringify(name), start);
}

/** This function joins a folder and a file name as a path relative to the root. */
export const inFolder = (folder: string, file: string): string => (folder === "" ? file : `${folder}/${file}`);

/** This function removes `./` at the start of a path. */
export const cleanPath = (path: string): string => path.replace(/^\.\//, "");

/** This function tells if a path matches one of the globs. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(cleanPath(glob)).test(path));
}

/**
 * This function reads a JSON file with comments and commas at the end of a list (a `tsconfig.json`).
 *
 * @throws SyntaxError when the text is not JSON after the comments are removed
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next;
        index++;
      } else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text.charAt(index) !== "\n") index++;
      out += "\n";
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 1;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** This function reads a JSON file with comments, or gives undefined when the file does not exist or is not JSON. */
export function readJsonc(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return parseJsonc(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** This function starts git in `root` with `args`, and gives its output, or undefined when git fails. */
export function runGit(root: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout;
}

/** This function tells if `file` exists in the folder `dir`. */
export const hasFile = (dir: string, file: string): boolean => existsSync(join(dir, file));
