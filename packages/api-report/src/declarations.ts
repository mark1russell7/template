/**
 * The reader of the text of a declaration file. TypeScript 7 has no stable compiler API, so this
 * module reads the `.d.ts` files as text. The declaration emit of `tsc` and of `tsdown` is regular,
 * and an unknown form of statement throws.
 */

/** An import of a declaration file, by its local name. */
export interface ImportBinding {
  /** The module specifier. */
  readonly from: string;
  /** The imported name, or `default`, `export=` or `*`. */
  readonly imported: string;
  readonly typeOnly: boolean;
}

/** A name that a module exports from its own scope. */
export interface LocalExport {
  /** The local name of the exported name. */
  readonly local: string;
  readonly typeOnly: boolean;
}

/** A part of an `export { a as b } from "x"` statement. */
export interface Reexport {
  readonly imported: string;
  readonly exported: string;
  readonly typeOnly: boolean;
  readonly from: string;
}

/** The statements of one declaration file, sorted by their kind. */
export interface DeclarationInfo {
  /** The declarations of the module by name, exported or not. */
  readonly locals: Map<string, string[]>;
  /** The names that the module exports from its own scope, by the exported name. */
  readonly exported: Map<string, LocalExport>;
  /** The `export { a as b } from "x"` parts. */
  readonly reexports: Reexport[];
  /** The `export * from "x"` statements. */
  readonly stars: { readonly from: string; readonly typeOnly: boolean }[];
  /** The `export * as name from "x"` statements. */
  readonly namespaces: { readonly name: string; readonly from: string; readonly typeOnly: boolean }[];
  /** The imports by local name. */
  readonly imports: Map<string, ImportBinding>;
  /** The ambient declarations by label: `declare module "x"`, `declare global`, `export as namespace X`. */
  readonly ambient: Map<string, string[]>;
  /** Each module specifier that the file names: the files that it reaches. */
  readonly references: Set<string>;
  /** The text of the doc comment of each declaration of `locals`, by name. A declaration without a doc comment has no item. */
  readonly docs: Map<string, string>;
}

/** One top-level statement of a declaration file, and the text of the doc comment before it. */
interface DocumentedStatement {
  readonly statement: string;
  readonly doc: string | undefined;
}

/**
 * This function gives the text of a doc comment: the lines without the `/**` and `*` marks and the
 * spaces at their ends. The first line also loses the spaces at its start. The lines without a `*` mark
 * lose only their common indent. The result keeps the tags, for example `@param`, and the indent after a
 * `*` mark.
 */
function docText(comment: string): string {
  const inner = comment.replace(/^\/\*\*/, "").replace(/\*\/$/, "").split("\n");
  const marked = (line: string, index: number): boolean => index > 0 && /^\s*\*/.test(line);
  const bare = inner.filter((line, index) => index > 0 && !marked(line, index) && line.trim() !== "");
  const indent = bare.length === 0 ? 0 : Math.min(...bare.map((line) => line.length - line.trimStart().length));
  const lines = inner.map((line, index) => {
    if (index === 0) return line.trim();
    return (marked(line, index) ? line.replace(/^\s*\* ?/, "") : line.slice(indent)).trimEnd();
  });
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  return lines.join("\n");
}

/** A mode of the reader of a template literal. */
type Mode = { readonly kind: "template" } | { readonly kind: "part"; readonly depth: number };

const BLOCK_HEADER = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+class|class|interface|const\s+enum|enum|namespace|module|global)\b/;

// A name of the ECMAScript grammar: a start letter, then continue letters. The letters include the letters that are not ASCII.
const NAME_START = String.raw`[\p{ID_Start}$_]`;
const NAME_PART = String.raw`[\p{ID_Continue}$‌‍]`;
const NAME = `${NAME_START}${NAME_PART}*`;

/** This tag makes a pattern with the flag `u` from raw text. The `\p{...}` classes of a name need that flag. */
function unicode(strings: TemplateStringsArray, ...parts: string[]): RegExp {
  return new RegExp(String.raw({ raw: strings.raw }, ...parts), "u");
}

const SPECIFIER = unicode`^(type\s+)?(${NAME})(?:\s+as\s+(${NAME}|"[^"]*"))?$`;
const PRIVATE_MEMBER = unicode`^\s+(?:private\s+(?:static\s+)?(?:readonly\s+)?${NAME}\??;|#private;)$`;
const DEFAULT_IMPORT = unicode`^(${NAME})\s*(?:,|$)`;
const NAMESPACE_IMPORT = unicode`^\* as (${NAME})$`;
const IMPORT_REQUIRE = unicode`^(export )?import (type )?(${NAME}) = require\(["']([^"']+)["']\);?$`;
const IMPORT_ALIAS = unicode`^(export )?import (${NAME}) = ${NAME}(?:\.${NAME})*;?$`;
const NAMESPACE_EXPORT = unicode`^export (type )?\* as (${NAME}) from ["']([^"']+)["'];?$`;
const EXPORT_ASSIGNMENT = unicode`^export = (${NAME});?$`;
const EXPORT_AS_NAMESPACE = unicode`^export as namespace (${NAME});?$`;
const DEFAULT_NAME = unicode`^export default (${NAME});?$`;
// The negative lookahead stops `classX` as a keyword. The name is empty for a default function or class without a name.
const NAMELESS_DEFAULT = unicode`^export default (?:declare )?(?:abstract )?(?:class|function\*?)(?!${NAME_PART})\s*((?:${NAME})?)`;
const DECLARATOR = unicode`^\s*(${NAME})`;
const DECLARATION = unicode`^(export )?(default )?(?:declare )?(?:abstract )?(?:const (?=enum))?(?:function|class|interface|type|enum|namespace|module) (${NAME})`;
const KIND_KEYWORD = unicode`^(?:export )?(?:default )?(?:declare )?(?:abstract )?(?:const (?=enum))?(function|class|interface|type|enum|namespace|module)(?!${NAME_PART})`;
const VARIABLE = /^(?:export )?(?:declare )?(?:const|let|var) (?!enum\b)(.*?);?$/;
const TYPED_DECLARATOR = unicode`^\s*${NAME}\s*\??\s*:\s*([\s\S]*)$`;

/**
 * This function splits the text of a declaration file into its top-level statements. It removes the
 * comments, the blank lines and the spaces at the ends of the lines.
 */
export function statementsOf(source: string): string[] {
  return documentedStatementsOf(source).map(({ statement }) => statement);
}

/**
 * This function splits the text of a declaration file into its top-level statements, as `statementsOf`
 * does. Each statement also has the text of the last doc comment before it at the top level.
 */
function documentedStatementsOf(source: string): DocumentedStatement[] {
  // The declarations of a bin file keep its `#!` line
  const text = source.replace(/\r\n?/g, "\n").replace(/^#![^\n]*\n?/, "");
  const statements: DocumentedStatement[] = [];
  let current = "";
  // The text of the last doc comment before the start of the current statement
  let doc: string | undefined;
  let depth = 0;
  // The depth of the type arguments at the top level: `class A<T = {}> {` has a brace in them
  let angle = 0;
  // True when the body of a class, an interface, an enum or a namespace is open
  let body = false;
  // The template literals and their `${ }` parts, from the outside in
  const modes: Mode[] = [];

  const finish = (): void => {
    const lines = current
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "");
    if (lines.length > 0) {
      statements.push({ statement: lines.join("\n"), doc });
      doc = undefined;
    }
    current = "";
    angle = 0;
    body = false;
  };

  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    const mode = modes.at(-1);
    if (mode?.kind === "template") {
      if (char === "\\") {
        current += char + next;
        index += 2;
      } else if (char === "`") {
        modes.pop();
        current += char;
        index++;
      } else if (char === "$" && next === "{") {
        modes.push({ kind: "part", depth });
        current += "${";
        index += 2;
      } else {
        current += char;
        index++;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text.charAt(index) !== "\n") index++;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end < 0 ? text.length : end + 2;
      // A doc comment starts with `/**`, and `/**/` is an empty comment. Only a comment before the statement is its doc comment.
      const isDoc = text.startsWith("/**", index) && text.charAt(index + 3) !== "/";
      if (isDoc && modes.length === 0 && depth === 0 && current.trim() === "") doc = docText(text.slice(index, stop));
      index = stop;
      current += " ";
      continue;
    }
    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < text.length && text.charAt(end) !== char) end += text.charAt(end) === "\\" ? 2 : 1;
      current += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === "`") {
      modes.push({ kind: "template" });
      current += char;
      index++;
      continue;
    }
    if (modes.length === 0 && depth === 0) {
      // The `>` of an arrow `=>` closes nothing
      if (char === "<") angle++;
      else if (char === ">" && text.charAt(index - 1) !== "=") angle = Math.max(0, angle - 1);
      else if (char === "{" && angle === 0 && !body && BLOCK_HEADER.test(current.trim())) body = true;
    }
    if (char === "{" || char === "(" || char === "[") depth++;
    if (char === "}" || char === ")" || char === "]") {
      if (char === "}" && mode?.kind === "part" && depth === mode.depth) {
        modes.pop();
        current += char;
        index++;
        continue;
      }
      depth--;
    }
    current += char;
    index++;
    if (modes.length > 0 || depth !== 0) continue;
    if (char === ";" || (char === "}" && body)) finish();
  }
  finish();
  return statements;
}

/** This function splits `text` at each comma outside brackets, type arguments and strings. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < text.length && text.charAt(end) !== char) end += text.charAt(end) === "\\" ? 2 : 1;
      index = end;
    } else if (char === "(" || char === "[" || char === "{" || char === "<") depth++;
    else if (char === ")" || char === "]" || char === "}" || (char === ">" && text.charAt(index - 1) !== "=")) depth--;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * The kind of one statement of a declaration.
 * - `function`: a function, or a variable with a function type, for example `declare const f: (x: A) => B`.
 * - `variable`: each other `const`, `let` or `var`.
 * - `namespace`: a `namespace` or a `module` with a name.
 * - `alias`: `import A = N.B`.
 * - `other`: an expression, for example `export default 1` or `export = { a }`.
 */
export type DeclarationKind = "function" | "class" | "interface" | "type" | "enum" | "namespace" | "variable" | "alias" | "other";

/**
 * This function gives the kinds of the statements of the text of one declaration, in their order and with no repeats.
 * An overload repeats `function`, thus it gives one `function`. A function with a merged namespace gives
 * `function` and `namespace`. The text is a declaration of a report or of the model, or a statement of a declaration file.
 */
export function declarationKinds(text: string): DeclarationKind[] {
  const kinds: DeclarationKind[] = [];
  for (const statement of statementsOf(text)) {
    const kind = statementKind(statement.replace(/\s+/g, " ").trim());
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

/** This function gives the kind of one statement, with its white space as one space. */
function statementKind(flat: string): DeclarationKind {
  const keyword = KIND_KEYWORD.exec(flat)?.[1];
  if (keyword !== undefined) return keyword === "module" ? "namespace" : (keyword as DeclarationKind);
  const variable = VARIABLE.exec(flat);
  if (variable) {
    // A statement with more than one declarator gets the kind of the first one
    const type = TYPED_DECLARATOR.exec(splitTopLevel(group(variable, 1))[0] ?? "")?.[1];
    return type !== undefined && isFunctionType(type.trim()) ? "function" : "variable";
  }
  if (IMPORT_ALIAS.test(flat)) return "alias";
  return "other";
}

/** This function tells if a type is a function type: `(x: A) => B` or `<T>(x: T) => T`, not `(A | B)[]` or `new () => C`. */
function isFunctionType(type: string): boolean {
  let index = 0;
  if (type.startsWith("<")) {
    index = afterGroup(type, 0);
    while (type.charAt(index) === " ") index++;
  }
  if (index < 0 || type.charAt(index) !== "(") return false;
  const end = afterGroup(type, index);
  return end > 0 && type.slice(end).trimStart().startsWith("=>");
}

/**
 * This function gives the index after the bracket that closes the bracket at `start`, or -1. It skips strings, and
 * the `>` of an arrow `=>` closes nothing.
 */
function afterGroup(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const char = text.charAt(index);
    if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < text.length && text.charAt(end) !== char) end += text.charAt(end) === "\\" ? 2 : 1;
      index = end;
    } else if (char === "(" || char === "[" || char === "{" || char === "<") depth++;
    else if (char === ")" || char === "]" || char === "}" || (char === ">" && text.charAt(index - 1) !== "=")) {
      depth--;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** The names of an export or import list: `a, type b, c as d`. */
function specifiersOf(list: string, typeOnly: boolean): { imported: string; exported: string; typeOnly: boolean }[] {
  return list
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const match = SPECIFIER.exec(part);
      if (!match?.[2]) throw new Error(`An export list part that the report does not know: ${part}`);
      return { imported: match[2], exported: match[3] ?? match[2], typeOnly: typeOnly || match[1] !== undefined };
    });
}

/** This function removes the private members of a class: they are not part of the API. */
function withoutPrivateMembers(statement: string): string {
  return statement
    .split("\n")
    .filter((line) => !PRIVATE_MEMBER.test(line))
    .join("\n");
}

/** A capture group of a match that the pattern always sets. */
const group = (match: RegExpExecArray, index: number): string => match[index] ?? "";

/**
 * This function sorts the statements of the text of one declaration file by their kind. `file`
 * names the file in the errors. An unknown form of statement throws.
 */
export function parseDeclarations(source: string, file = "<text>"): DeclarationInfo {
  const info: DeclarationInfo = {
    locals: new Map(),
    exported: new Map(),
    reexports: [],
    stars: [],
    namespaces: [],
    imports: new Map(),
    ambient: new Map(),
    references: new Set(),
    docs: new Map(),
  };
  // The doc comment of the statement that the loop reads
  let doc: string | undefined;
  const addLocal = (name: string, statement: string): void => {
    info.locals.set(name, [...(info.locals.get(name) ?? []), statement]);
    // The first doc comment of a name wins: an overload or a merged interface can repeat it
    if (doc !== undefined && doc !== "" && !info.docs.has(name)) info.docs.set(name, doc);
  };
  const addAmbient = (label: string, statement: string): void => {
    info.ambient.set(label, [...(info.ambient.get(label) ?? []), statement]);
  };
  for (const documented of documentedStatementsOf(source)) {
    const { statement } = documented;
    doc = documented.doc;
    const flat = statement.replace(/\s+/g, " ");
    for (const found of flat.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) info.references.add(found[1] ?? "");
    let match: RegExpExecArray | null;
    if ((match = /^import (type )?(.+?) from ["']([^"']+)["'];?$/.exec(flat))) {
      const typeOnly = match[1] !== undefined;
      const from = group(match, 3);
      info.references.add(from);
      let clause = group(match, 2).trim();
      const defaultName = DEFAULT_IMPORT.exec(clause);
      if (defaultName) {
        info.imports.set(group(defaultName, 1), { from, imported: "default", typeOnly });
        clause = clause.slice(defaultName[0].length).trim();
      }
      const namespace = NAMESPACE_IMPORT.exec(clause);
      if (namespace) info.imports.set(group(namespace, 1), { from, imported: "*", typeOnly });
      const braces = /^\{(.*)\}$/.exec(clause);
      if (braces) {
        for (const specifier of specifiersOf(group(braces, 1), typeOnly)) {
          info.imports.set(specifier.exported, { from, imported: specifier.imported, typeOnly: specifier.typeOnly });
        }
      }
      continue;
    }
    if ((match = /^import ["']([^"']+)["'];?$/.exec(flat))) {
      info.references.add(group(match, 1));
      continue;
    }
    // `import x = require("y")`: the name is the `export =` of the module
    if ((match = IMPORT_REQUIRE.exec(flat))) {
      const name = group(match, 3);
      info.references.add(group(match, 4));
      info.imports.set(name, { from: group(match, 4), imported: "export=", typeOnly: match[2] !== undefined });
      if (match[1] !== undefined) info.exported.set(name, { local: name, typeOnly: false });
      continue;
    }
    // `import A = N.B`: an alias of a name of a namespace
    if ((match = IMPORT_ALIAS.exec(flat))) {
      const name = group(match, 2);
      addLocal(name, statement);
      if (match[1] !== undefined) info.exported.set(name, { local: name, typeOnly: false });
      continue;
    }
    if ((match = NAMESPACE_EXPORT.exec(flat))) {
      info.references.add(group(match, 3));
      info.namespaces.push({ name: group(match, 2), from: group(match, 3), typeOnly: match[1] !== undefined });
      continue;
    }
    if ((match = /^export (type )?\* from ["']([^"']+)["'];?$/.exec(flat))) {
      info.references.add(group(match, 2));
      info.stars.push({ from: group(match, 2), typeOnly: match[1] !== undefined });
      continue;
    }
    if ((match = /^export (type )?\{(.*)\} from ["']([^"']+)["'];?$/.exec(flat))) {
      const from = group(match, 3);
      info.references.add(from);
      for (const specifier of specifiersOf(group(match, 2), match[1] !== undefined)) info.reexports.push({ ...specifier, from });
      continue;
    }
    if ((match = /^export (type )?\{(.*)\};?$/.exec(flat))) {
      for (const specifier of specifiersOf(group(match, 2), match[1] !== undefined)) {
        info.exported.set(specifier.exported, { local: specifier.imported, typeOnly: specifier.typeOnly });
      }
      continue;
    }
    // `export = X`: the module is the value X (CommonJS)
    if ((match = EXPORT_ASSIGNMENT.exec(flat))) {
      info.exported.set("export=", { local: group(match, 1), typeOnly: false });
      continue;
    }
    if (/^export = /.test(flat)) {
      addLocal("export=", statement);
      info.exported.set("export=", { local: "export=", typeOnly: false });
      continue;
    }
    if ((match = /^(?:export )?declare module (["'][^"']+["'])/.exec(flat))) {
      addAmbient(`declare module ${group(match, 1).replaceAll("'", '"')}`, statement);
      continue;
    }
    if (/^(?:export )?(?:declare )?global \{/.test(flat)) {
      addAmbient("declare global", statement);
      continue;
    }
    if ((match = EXPORT_AS_NAMESPACE.exec(flat))) {
      addAmbient(`export as namespace ${group(match, 1)}`, statement);
      continue;
    }
    // `export default x`: the default export is a name of the module
    if ((match = DEFAULT_NAME.exec(flat))) {
      info.exported.set("default", { local: group(match, 1), typeOnly: false });
      continue;
    }
    // A default function or class without a name
    match = NAMELESS_DEFAULT.exec(flat);
    if (match && (match[1] === "" || match[1] === "extends" || match[1] === "implements")) {
      addLocal("default", withoutPrivateMembers(statement));
      info.exported.set("default", { local: "default", typeOnly: false });
      continue;
    }
    // `const a: A, b: B` declares two names
    if ((match = /^(export )?(?:declare )?(?:const|let|var) (?!enum\b)(.*?);?$/.exec(flat))) {
      const exported = match[1] !== undefined;
      for (const part of splitTopLevel(group(match, 2))) {
        const name = DECLARATOR.exec(part);
        if (!name) throw new Error(`A declaration that the report does not know, in ${file}:\n${statement}`);
        addLocal(group(name, 1), statement);
        if (exported) info.exported.set(group(name, 1), { local: group(name, 1), typeOnly: false });
      }
      continue;
    }
    match = DECLARATION.exec(flat);
    if (match) {
      const name = group(match, 3);
      addLocal(name, withoutPrivateMembers(statement));
      if (match[1] !== undefined) info.exported.set(match[2] !== undefined ? "default" : name, { local: name, typeOnly: false });
      continue;
    }
    // `export default <expression>`
    if (/^export default /.test(flat)) {
      addLocal("default", statement);
      info.exported.set("default", { local: "default", typeOnly: false });
      continue;
    }
    throw new Error(`A statement that the report does not know, in ${file}:\n${statement}`);
  }
  return info;
}
