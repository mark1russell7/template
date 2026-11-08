/**
 * The private name list: a JSON file outside of the public repositories, with the names of private projects. The file
 * `schema/private-names.schema.json` tells its form. This module parses the list and finds its names in a line or in a
 * path. It has no input or output.
 *
 * A result tells the place of a name by its index in the list, for example `name 3 of the private name list`. A result
 * does not show the text, the id, the project or a pattern, because the id of a name is the private name.
 */

/** The name of the private name list in a break and in an error. A break does not show the path of the file. */
export const PRIVATE_NAME_LIST = "the private name list";

/** One name of the private name list. */
export interface NameRule {
  /** The short name of the entry. An entry of `allow` refers to it. The check does not show it. */
  readonly id: string;
  /** The private project of the name, as a note for persons. The check does not read it. */
  readonly project: string;
  /**
   * The fixed texts of the name, with case. A line that has no seed of the list is no hit. A seed is a fast filter, so
   * each text that a pattern or the word finds must contain a seed.
   */
  readonly seeds: readonly string[];
  /** The regular expressions of the name, with no flags. A match in a line or in a path is a hit. */
  readonly patterns: readonly string[];
  /**
   * A word that is also a common word. A match of the whole word is a hit only in a sentence about the project.
   * The word in code, in a title or before a noun is no hit.
   */
  readonly word?: string;
  /** The lower-case words that make the word a common word when they come next, for example `corp` after `Acme`. */
  readonly commonAfter?: readonly string[];
}

/** A hit that a person examined and permitted: the name `name` in the file `path` of the repository `repo`. */
export interface AllowedHit {
  /** The name of the repository, with no owner. A value `owner/name` is also correct. Case is not significant. */
  readonly repo: string;
  /** The path of the file from the root of the repository, with `/`. */
  readonly path: string;
  /** The id of the permitted name. With no id, each name of the list is permitted in the file. */
  readonly name?: string;
  /** The reason of the person. */
  readonly why: string;
}

/** The private name list after a parse. */
export interface PrivateNameList {
  readonly names: readonly NameRule[];
  readonly allow: readonly AllowedHit[];
}

/** A name of the list that a line or a path has. */
export interface NameHit {
  /** The index of the name in the list, from 1. */
  readonly name: number;
  /** The entry of the name. A break does not show it. */
  readonly rule: NameRule;
  /** The position of the match in the text, from 0. */
  readonly index: number;
}

/** The place of a line: the repository and the path of its file. The list `allow` applies only to a line with a place. */
export interface LinePlace {
  /** The repository: `owner/name` or `name`. */
  readonly repo?: string;
  /** The path of the file from the root of the repository. */
  readonly path?: string;
}

/**
 * This error tells that a private name list is not valid. Its reason names a field by the index of its entry, and
 * does not show a value of the list.
 */
export class PrivateNameListError extends Error {
  /** The reason, for example `name 3 of the private name list: the field seeds has no text`. */
  readonly reason: string;
  constructor(reason: string) {
    super(`The private name list is not valid: ${reason}.`);
    this.name = "PrivateNameListError";
    this.reason = reason;
  }
}

/** The compiled regular expressions of a name. */
interface CompiledName {
  readonly patterns: readonly RegExp[];
  readonly word?: RegExp;
}

/** The compiled names, by entry. The parse fills it, and a list of another source gets its entries on the first use. */
const compiled = new WeakMap<NameRule, CompiledName>();

/** The form of a word: letters, digits, `_` and `-`. So the word is a literal in a regular expression. */
const WORD = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The form of a word of `commonAfter`: lower-case letters. The check compares it with the next word in lower case. */
const AFTER = /^[a-z]+$/;

/** This function gives the compiled regular expressions of a name. */
function compiledOf(rule: NameRule): CompiledName {
  const known = compiled.get(rule);
  if (known !== undefined) return known;
  const made: CompiledName = {
    patterns: rule.patterns.map((source) => new RegExp(source)),
    ...(rule.word === undefined || rule.word === "" ? {} : { word: new RegExp(`\\b${rule.word}\\b`, "g") }),
  };
  compiled.set(rule, made);
  return made;
}

/** This function tells if a value is a list of texts that are not empty. */
const isTexts = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");

/** This function tells if a value is an object that is not a list. */
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** This function gives the first field of `entry` that `known` does not have, or undefined. */
const unknownField = (entry: Record<string, unknown>, known: readonly string[]): string | undefined => Object.keys(entry).find((key) => !known.includes(key));

/** This function gives a name of the list after a check of its fields. The error names the entry by its index. */
function nameOf(entry: unknown, at: string): NameRule {
  const fail = (reason: string): never => {
    throw new PrivateNameListError(`${at}: ${reason}`);
  };
  if (!isObject(entry)) return fail("the entry is not an object");
  const extra = unknownField(entry, ["id", "project", "seeds", "patterns", "word", "commonAfter"]);
  if (extra !== undefined) fail("the entry has a field that the schema does not have");
  const { id, project, seeds, patterns, word, commonAfter } = entry;
  if (typeof id !== "string" || id === "") fail("the field id is not a text");
  if (typeof project !== "string" || project === "") fail("the field project is not a text");
  if (!isTexts(seeds) || seeds.length === 0) fail("the field seeds is not a list of one or more texts");
  if (!isTexts(patterns)) fail("the field patterns is not a list of texts");
  if (word !== undefined && (typeof word !== "string" || !WORD.test(word))) fail("the field word is not one word of letters, digits, _ and -");
  if (commonAfter !== undefined && (!Array.isArray(commonAfter) || !commonAfter.every((item) => typeof item === "string" && AFTER.test(item))))
    fail("the field commonAfter is not a list of lower-case words");
  if (commonAfter !== undefined && word === undefined) fail("the field commonAfter has no field word");
  const rule: NameRule = {
    id: id as string,
    project: project as string,
    seeds: seeds as string[],
    patterns: patterns as string[],
    ...(word === undefined ? {} : { word: word as string }),
    ...(commonAfter === undefined ? {} : { commonAfter: commonAfter as string[] }),
  };
  rule.patterns.forEach((source, index) => {
    try {
      new RegExp(source);
    } catch {
      fail(`pattern ${String(index + 1)} is not a valid regular expression`);
    }
  });
  compiledOf(rule);
  return rule;
}

/** This function gives an entry of the list `allow` after a check of its fields. */
function allowedOf(entry: unknown, at: string, ids: ReadonlySet<string>): AllowedHit {
  const fail = (reason: string): never => {
    throw new PrivateNameListError(`${at}: ${reason}`);
  };
  if (!isObject(entry)) return fail("the entry is not an object");
  if (unknownField(entry, ["repo", "path", "name", "why"]) !== undefined) fail("the entry has a field that the schema does not have");
  const { repo, path, name, why } = entry;
  if (typeof repo !== "string" || repo === "") fail("the field repo is not a text");
  if (typeof path !== "string" || path === "") fail("the field path is not a text");
  if (typeof why !== "string" || why === "") fail("the field why is not a text");
  if (name !== undefined && (typeof name !== "string" || !ids.has(name))) fail("the field name is not the id of a name of the list");
  return { repo: repo as string, path: path as string, why: why as string, ...(name === undefined ? {} : { name: name as string }) };
}

/**
 * This function parses the text of a private name list, and checks it against the schema. It also checks each regular
 * expression and the ids. It throws a `PrivateNameListError` when the text is not valid. The error shows no value of the text.
 */
export function parsePrivateNames(text: string): PrivateNameList {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // The message of JSON.parse can quote the text, so the error does not give it
    throw new PrivateNameListError("the text is not valid JSON");
  }
  if (!isObject(data)) throw new PrivateNameListError("the text is not a JSON object");
  if (unknownField(data, ["$schema", "$comment", "names", "allow"]) !== undefined) throw new PrivateNameListError("the object has a field that the schema does not have");
  if (data["$comment"] !== undefined && typeof data["$comment"] !== "string") throw new PrivateNameListError("the field $comment is not a text");
  const names = data["names"];
  const allow = data["allow"] ?? [];
  if (!Array.isArray(names)) throw new PrivateNameListError("the field names is not a list");
  if (!Array.isArray(allow)) throw new PrivateNameListError("the field allow is not a list");
  const rules = names.map((entry, index) => nameOf(entry, `name ${String(index + 1)} of ${PRIVATE_NAME_LIST}`));
  const ids = new Set<string>();
  rules.forEach((rule, index) => {
    if (ids.has(rule.id)) throw new PrivateNameListError(`name ${String(index + 1)} of ${PRIVATE_NAME_LIST}: the id is also the id of an earlier name`);
    ids.add(rule.id);
  });
  return { names: rules, allow: allow.map((entry, index) => allowedOf(entry, `allow entry ${String(index + 1)} of ${PRIVATE_NAME_LIST}`, ids)) };
}

/** The words before a name in code: a declaration, a type or an operator. */
const CODE_BEFORE = /\b(class|interface|type|new|extends|implements|const|let|enum|struct|typeof|instanceof|as)\s+$/;
/** A line of code that imports or exports names. */
const CODE_LINE = /^\s*(import|export)\b/;
/** The words before a common noun: an article or a count. */
const COUNT_BEFORE = /\b(a|an|any|each|every|one|our|this|your)\s+$/i;
/** A word with a capital letter before the word: a title, or a name of more words. */
const TITLE_BEFORE = /[A-Z][\w-]*\s+$/;
/** The words with a capital letter that start a sentence part, not a title. */
const WORD_BEFORE = /\b(And|By|For|From|In|Of|See|To|With)\s+$/;

/**
 * This function tells if the word of `rule` at `index` of `line` is a common word or code, and not the name of the
 * project. Code is a type, a key or a part of a path. A common word comes after an article, in a title or before a noun.
 */
export function isCommonUse(line: string, index: number, rule: NameRule): boolean {
  const word = rule.word ?? "";
  const before = line.slice(0, index);
  const after = line.slice(index + word.length);
  if (/^\s*[\]>{};]/.test(after) || /["[]$/.test(before) || /=>\s*$/.test(before)) return true;
  if (/^[<([{]/.test(after) || /^\.\w/.test(after) || after.startsWith("::") || /^:\s*[{[(]/.test(after)) return true;
  if (/^[-/]/.test(after) || /[-/]$/.test(before)) return true;
  if (/[<.]$/.test(before)) return true;
  if (CODE_BEFORE.test(before) || CODE_LINE.test(line)) return true;
  if (/[`'"]$/.test(before) && /^[`'"]/.test(after)) return true;
  if (/[\w)\]?]:\s*$/.test(before) && /^\s*([,;)=|&>]|$)/.test(after)) return true;
  if (COUNT_BEFORE.test(before)) return true;
  if (TITLE_BEFORE.test(before) && !WORD_BEFORE.test(before)) return true;
  const next = /^\s+([A-Za-z]+)/.exec(after)?.[1];
  if (next === undefined) return false;
  return /^[A-Z][a-z]/.test(next) || (rule.commonAfter ?? []).includes(next.toLowerCase());
}

/**
 * This function gives the first name of `names` in `line`, or undefined. For each name in sequence, a pattern match is
 * a hit. A match of the word is a hit when `isCommonUse` is false. It does not use the seeds or the list `allow`.
 */
export function firstNameMatch(line: string, names: readonly NameRule[]): NameHit | undefined {
  for (let at = 0; at < names.length; at++) {
    const rule = names[at];
    if (rule === undefined) continue;
    const { patterns, word } = compiledOf(rule);
    for (const pattern of patterns) {
      const found = pattern.exec(line);
      if (found !== null) return { name: at + 1, rule, index: found.index };
    }
    if (word === undefined) continue;
    for (const found of line.matchAll(word)) {
      if (!isCommonUse(line, found.index, rule)) return { name: at + 1, rule, index: found.index };
    }
  }
  return undefined;
}

/** This function gives the name part of a repository: `name` for `owner/name`, in lower case. */
const repoName = (repo: string): string => (repo.split("/").at(-1) ?? repo).toLowerCase();

/**
 * This function tells if the list `allow` permits the name `id` in the file `path` of the repository `repo`. An entry
 * with the repository `name` or `owner/name` matches the repository `owner/name`. Case of a repository is not significant.
 */
export function isAllowedHit(allow: readonly AllowedHit[], repo: string, path: string, id: string): boolean {
  const full = repo.toLowerCase();
  return allow.some((entry) => {
    const named = entry.repo.toLowerCase();
    const sameRepo = named.includes("/") ? named === full : named === repoName(repo);
    return sameRepo && entry.path === path && (entry.name === undefined || entry.name === id);
  });
}

/**
 * This function gives the name of the list in one line of a file or of a message, or undefined. The line must have a
 * seed of the list. The first name of the line counts. A permitted hit at the place gives undefined.
 */
export function lineNameHit(list: PrivateNameList, line: string, place: LinePlace = {}): NameHit | undefined {
  if (!list.names.some((rule) => rule.seeds.some((seed) => line.includes(seed)))) return undefined;
  const hit = firstNameMatch(line, list.names);
  if (hit === undefined) return undefined;
  if (place.repo !== undefined && place.path !== undefined && isAllowedHit(list.allow, place.repo, place.path, hit.rule.id)) return undefined;
  return hit;
}

/**
 * This function gives the first name of the list whose pattern matches a path of a file, or undefined. Only the patterns
 * apply, because a path has no sentence. The seeds and the list `allow` do not apply.
 */
export function pathNameHit(list: PrivateNameList, path: string): NameHit | undefined {
  for (let at = 0; at < list.names.length; at++) {
    const rule = list.names[at];
    if (rule === undefined) continue;
    const found = compiledOf(rule)
      .patterns.map((pattern) => pattern.exec(path))
      .find((match) => match !== null);
    if (found !== undefined && found !== null) return { name: at + 1, rule, index: found.index };
  }
  return undefined;
}

