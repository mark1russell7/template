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
}

/** A mode of the reader of a template literal. */
type Mode = { readonly kind: "template" } | { readonly kind: "part"; readonly depth: number };

const BLOCK_HEADER = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+class|class|interface|const\s+enum|enum|namespace|module|global)\b/;

/**
 * This function splits the text of a declaration file into its top-level statements. It removes the
 * comments, the blank lines and the spaces at the ends of the lines.
 */
export function statementsOf(source: string): string[] {
  // The declarations of a bin file keep its `#!` line
  const text = source.replace(/\r\n?/g, "\n").replace(/^#![^\n]*\n?/, "");
  const statements: string[] = [];
  let current = "";
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
    if (lines.length > 0) statements.push(lines.join("\n"));
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
      index = end < 0 ? text.length : end + 2;
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

/** The names of an export or import list: `a, type b, c as d`. */
function specifiersOf(list: string, typeOnly: boolean): { imported: string; exported: string; typeOnly: boolean }[] {
  return list
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const match = /^(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+|"[^"]*"))?$/.exec(part);
      if (!match?.[2]) throw new Error(`An export list part that the report does not know: ${part}`);
      return { imported: match[2], exported: match[3] ?? match[2], typeOnly: typeOnly || match[1] !== undefined };
    });
}

/** This function removes the private members of a class: they are not part of the API. */
function withoutPrivateMembers(statement: string): string {
  return statement
    .split("\n")
    .filter((line) => !/^\s+(?:private\s+(?:static\s+)?(?:readonly\s+)?[\w$]+\??;|#private;)$/.test(line))
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
  };
  const addLocal = (name: string, statement: string): void => {
    info.locals.set(name, [...(info.locals.get(name) ?? []), statement]);
  };
  const addAmbient = (label: string, statement: string): void => {
    info.ambient.set(label, [...(info.ambient.get(label) ?? []), statement]);
  };
  for (const statement of statementsOf(source)) {
    const flat = statement.replace(/\s+/g, " ");
    for (const found of flat.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) info.references.add(found[1] ?? "");
    let match: RegExpExecArray | null;
    if ((match = /^import (type )?(.+?) from ["']([^"']+)["'];?$/.exec(flat))) {
      const typeOnly = match[1] !== undefined;
      const from = group(match, 3);
      info.references.add(from);
      let clause = group(match, 2).trim();
      const defaultName = /^([\w$]+)\s*(?:,|$)/.exec(clause);
      if (defaultName) {
        info.imports.set(group(defaultName, 1), { from, imported: "default", typeOnly });
        clause = clause.slice(defaultName[0].length).trim();
      }
      const namespace = /^\* as ([\w$]+)$/.exec(clause);
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
    if ((match = /^(export )?import (type )?([\w$]+) = require\(["']([^"']+)["']\);?$/.exec(flat))) {
      const name = group(match, 3);
      info.references.add(group(match, 4));
      info.imports.set(name, { from: group(match, 4), imported: "export=", typeOnly: match[2] !== undefined });
      if (match[1] !== undefined) info.exported.set(name, { local: name, typeOnly: false });
      continue;
    }
    // `import A = N.B`: an alias of a name of a namespace
    if ((match = /^(export )?import ([\w$]+) = [\w$.]+;?$/.exec(flat))) {
      const name = group(match, 2);
      addLocal(name, statement);
      if (match[1] !== undefined) info.exported.set(name, { local: name, typeOnly: false });
      continue;
    }
    if ((match = /^export (type )?\* as ([\w$]+) from ["']([^"']+)["'];?$/.exec(flat))) {
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
    if ((match = /^export = ([\w$]+);?$/.exec(flat))) {
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
    if ((match = /^export as namespace ([\w$]+);?$/.exec(flat))) {
      addAmbient(`export as namespace ${group(match, 1)}`, statement);
      continue;
    }
    // `export default x`: the default export is a name of the module
    if ((match = /^export default ([\w$]+);?$/.exec(flat))) {
      info.exported.set("default", { local: group(match, 1), typeOnly: false });
      continue;
    }
    // A default function or class without a name
    match = /^export default (?:declare )?(?:abstract )?(?:class|function\*?)(?![\w$])\s*([\w$]*)/.exec(flat);
    if (match && (match[1] === "" || match[1] === "extends" || match[1] === "implements")) {
      addLocal("default", withoutPrivateMembers(statement));
      info.exported.set("default", { local: "default", typeOnly: false });
      continue;
    }
    // `const a: A, b: B` declares two names
    if ((match = /^(export )?(?:declare )?(?:const|let|var) (?!enum\b)(.*?);?$/.exec(flat))) {
      const exported = match[1] !== undefined;
      for (const part of splitTopLevel(group(match, 2))) {
        const name = /^\s*([\w$]+)/.exec(part);
        if (!name) throw new Error(`A declaration that the report does not know, in ${file}:\n${statement}`);
        addLocal(group(name, 1), statement);
        if (exported) info.exported.set(group(name, 1), { local: group(name, 1), typeOnly: false });
      }
      continue;
    }
    match = /^(export )?(default )?(?:declare )?(?:abstract )?(?:const (?=enum))?(?:function|class|interface|type|enum|namespace|module) ([\w$]+)/.exec(flat);
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
