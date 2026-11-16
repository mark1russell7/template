/**
 * The rule `publish-text-safe`: the text that npm puts in the publish document of a public package has no line in the
 * shape of an attack. It also has no token of a known service. This text is each README file of the package folder,
 * and each key and each string of `package.json`. The document holds the whole manifest with `publishConfig`, so
 * `scripts`, `repository`, `bugs`, `config` and `bin` go to the registry with `description` and `keywords`.
 *
 * The registry screens the document. On 2026-11-15 it refused a document with the shape of a SQL probe (E403), and the
 * error did not name the cause. The registry also shows the text to each reader, and its mirrors keep each version.
 *
 * The walk of the manifest is `findSecretShapesInValue` of `@mark1russell7/text/redact`. The shapes of the tokens are
 * `SECRET_SHAPES` of the same module, the home of the redaction of secrets. This file has no copy of these patterns. A
 * break gives the line and the name of the shape, not the token.
 *
 * This rule does not wait `RULE_WARN_DAYS`: it fails from its release day. The wait gives the owners time to fix the
 * breaks of a new rule. On 2026-11-16 a first read of the local clones used the attack shapes of this file. It found
 * 1 true example, the README of text 0.0.7 (in 2 old clones), and 0 false hits. Thus the wait protects no repository.
 * A wait of 14 days lets a repeat of the text case pass with only a warning.
 *
 * At 11:32 UTC of the same day, one read of both scopes took 446 README files and 664 manifests (56,049 keys and
 * strings) of the local clones. It found 0 attack shapes and 0 tokens. The sessions add, pull and remove clones during
 * a day, so each count is the count of one read.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findSecretShapes, findSecretShapesInValue, redactSecretShapes, SECRET_SHAPES, type SecretShape, type ValueShapeMatch } from "@mark1russell7/text/redact";
import { inFolder, lineOf, versionedPackages, type Break, type Rule } from "../rule.ts";

/** A shape of an attack in a text: an id, the words for the message, the pattern and the evidence of a refusal. */
export interface AttackShape {
  readonly id: string;
  /** The shape in words, for the message of a break. */
  readonly what: string;
  readonly pattern: RegExp;
  /**
   * The evidence that the npm registry refused a publish with this shape: the error, the package and the day. The
   * value is `null` when no refusal of the shape is on record.
   */
  readonly seen: string | null;
}

/**
 * The shapes of the attacks. Only the shape `sql-boolean` has a refusal on record: it stopped each publish of
 * @mark1russell7/text 0.0.7. The other three shapes are patterns that follow the SQL rules of the OWASP Core Rule Set,
 * and no refusal of them is on record. They are breaks too. A false break names its line and costs one reword. A miss
 * costs an E403 that does not name its cause, and on 2026-11-15 this cost hours.
 *
 * A script tag is not here: @mark1russell7/site-pages 0.5.4 has one in its README, and its publish passed.
 */
export const ATTACK_SHAPES: readonly AttackShape[] = Object.freeze([
  {
    id: "sql-boolean",
    what: "a SQL probe: AND or OR, a number, a comparison and a number",
    pattern: /\b(?:and|or)\s+\d+\s*(?:=|<>|!=)\s*\d+(?!\w)/i,
    seen: "E403, @mark1russell7/text 0.0.7, 2026-11-15",
  },
  {
    id: "sql-tautology",
    what: "a SQL tautology: a quote, AND or OR, and two equal values",
    pattern: /(['"])\s*(?:or|and)\s+(['"]?)(\w+)\2\s*=\s*\2\3(?!\w)/i,
    seen: null,
  },
  { id: "sql-union", what: "a SQL UNION SELECT", pattern: /\bunion\s+(?:all\s+)?select\b/i, seen: null },
  { id: "sql-drop", what: "a SQL DROP after a semicolon", pattern: /;\s*drop\s+(?:table|database)\b/i, seen: null },
]);

/** A line of a text with the shape of an attack: the line (from 1), the shape and the matched text. */
export interface AttackLine {
  readonly line: number;
  readonly shape: AttackShape;
  readonly text: string;
}

/** This function gives each line of `text` with the shape of an attack, one time for each shape, in the order of the lines. */
export function attackLines(text: string, shapes: readonly AttackShape[] = ATTACK_SHAPES): AttackLine[] {
  const found: AttackLine[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const shape of shapes) {
      const match = shape.pattern.exec(line);
      if (match !== null) found.push({ line: index + 1, shape, text: match[0] });
    }
  });
  return found;
}

/** The attack shapes in the form of the shapes of text, for the walk of a value. The label is the field `what`. */
const ATTACKS_AS_SECRET_SHAPES: readonly SecretShape[] = Object.freeze(
  ATTACK_SHAPES.map((shape) => Object.freeze({ id: shape.id, label: shape.what, pattern: shape.pattern })),
);

/**
 * This function gives each match of an attack shape in each key and each string of `value`, with the path to the
 * string. It is `findSecretShapesInValue` of text with the attack shapes. The order is the order of the document.
 */
export function attacksInValue(value: unknown, shapes: readonly AttackShape[] = ATTACK_SHAPES): ValueShapeMatch[] {
  const asSecretShapes = shapes === ATTACK_SHAPES ? ATTACKS_AS_SECRET_SHAPES : shapes.map((shape) => ({ id: shape.id, label: shape.what, pattern: shape.pattern }));
  return findSecretShapesInValue(value, asSecretShapes);
}

/** A token of a known service in a text: the line of its start (from 1) and its shape. It does not hold the token. */
export interface SecretLine {
  readonly line: number;
  readonly shape: SecretShape;
}

/**
 * This function gives the line and the shape of each token in `text`, in the order of the text. A private key block
 * can go across lines: its line is the line of its start. The result has no text of the token.
 */
export function secretLines(text: string, shapes: readonly SecretShape[] = SECRET_SHAPES): SecretLine[] {
  const byId = new Map(shapes.map((shape) => [shape.id, shape]));
  const found: SecretLine[] = [];
  let line = 1;
  let at = 0;
  // findSecretShapes gives the matches in the order of their start, so the count of the line ends goes forward only.
  for (const match of findSecretShapes(text, shapes)) {
    for (; at < match.start; at++) if (text.charCodeAt(at) === 10) line++;
    const shape = byId.get(match.shape);
    if (shape !== undefined) found.push({ line, shape });
  }
  return found;
}

/** The names of the README files that npm packs from the folder of a package, with each case and extension. */
const README = /^readme(?:\.[\w-]+)?$/i;

/**
 * This function gives a text with each token of a known service as `[secret]`. A break message holds a matched text
 * and the keys of a path. A token can be in each of them: in the span of `sql-tautology`, in a key, or in the key of
 * a parent. Each part goes through this function before its cut to 60 characters. A token that the cut divides has
 * no shape for a later pass. Each finished message goes through it again.
 */
const secretFree = (text: string): string => redactSecretShapes(text);

/** This function gives a matched text for a message, with no token, no line end and at most 60 characters. */
const shown = (text: string): string => {
  const free = secretFree(text);
  return JSON.stringify(free.length > 60 ? `${free.slice(0, 57)}...` : free);
};

/** This function gives the path of a match in words for a message, with each token in a key as `[secret]`. */
const shownPath = (path: readonly (string | number)[]): string => fieldOf(path.map((part) => (typeof part === "string" ? secretFree(part) : part)));

/** This function gives the end of the message of an attack shape: the refusal on record, or the source of the shape. */
const refusalOf = (shape: AttackShape): string =>
  shape.seen === null
    ? "The shape follows a SQL rule of the OWASP Core Rule Set, so the npm registry can refuse the publish (E403). No refusal of it is on record."
    : `The npm registry refused a publish with this shape (${shape.seen}).`;

/** This function gives the end of the message of a token. It names the shape, and it does not show the token. */
const tokenOf = (shape: Pick<SecretShape, "id" | "label">): string =>
  `${shape.label} (${shape.id}). npm shows this text to each reader of the package. Revoke the secret at its service, and then remove it.`;

/** A name of a key that a path shows after a dot. Each other key goes in brackets as JSON, for example `exports["./a"]`. */
const PLAIN_KEY = /^[A-Za-z_$][\w$-]*$/;

/** This function gives the path to a string of a manifest in words, for example `scripts.build` or `keywords[1]`. */
export function fieldOf(path: readonly (string | number)[]): string {
  return path
    .map((part, index) => (typeof part === "number" ? `[${part}]` : PLAIN_KEY.test(part) ? `${index === 0 ? "" : "."}${part}` : `[${JSON.stringify(part)}]`))
    .join("");
}

/** This function gives the key or the string at the end of a path in a value, or `undefined` if no string is there. */
function stringAt(value: unknown, path: readonly (string | number)[], inKey: boolean): string | undefined {
  if (inKey) {
    const key = path[path.length - 1];
    return typeof key === "string" ? key : undefined;
  }
  let at: unknown = value;
  for (const part of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string | number, unknown>)[part];
  }
  return typeof at === "string" ? at : undefined;
}

/**
 * This function gives the line of the string at the end of a path in the text of a manifest. It finds each key of the
 * path after the line of the key before it, as `"key":` and then as `"key"`. An index of an array keeps the line of
 * its key. For a string that is not a key, it then finds the string as JSON after that line. When a part is not in the
 * text, the line of the part before stays. An example is a key that the file writes with an escape.
 *
 * A key with the same name in an earlier object under the same parent gives an earlier line. An example is the path
 * `a.x` in `{"a": {"z": {"x": 1}, "x": "bad"}}`. The search of the string corrects this for a value with a distinct
 * text, but not for a match in a key. Only the line is wrong: the path and the shape of the break stay correct.
 */
export function pathLine(text: string, path: readonly (string | number)[], leaf?: string): number | undefined {
  let line: number | undefined;
  for (const part of path) {
    if (typeof part === "number") continue;
    const name = JSON.stringify(part);
    line = lineOf(text, `${name}:`, line ?? 1) ?? lineOf(text, name, line ?? 1) ?? line;
  }
  if (leaf !== undefined) line = lineOf(text, JSON.stringify(leaf), line ?? 1) ?? line;
  return line;
}

export const publishTextSafe: Rule = {
  id: "publish-text-safe",
  title: "The text that npm puts in the publish document of a public package (each README, and each key and string of `package.json`) has no line in the shape of an attack, and no token of a known service.",
  reason:
    "The npm registry screens the publish document, and it refused a document with the shape of a SQL probe. On 2026-11-15 and 2026-11-16, each publish of @mark1russell7/text 0.0.7 failed with E403. An example in its README had AND, a number, an equal sign and a number. The error does not name the cause, so the release looked like a fault of the trust of the package. A new README example went out, and the same trust published 0.0.7. The document holds the whole manifest, so a shape in `scripts` or a token in `repository.url` goes to the same screen. A token in this text goes to each reader of the package, and the mirrors of the registry keep each version, so a later fix does not remove the token.",
  fix: "Write the example or the value with other words, for example `partsAt(\"A wide river\", [[2, 6]])`. For a token, revoke it at its service first, and then write a fake value, for example `TOKEN-EXAMPLE`. A changed README or manifest of a released package needs a PATCH version.",
  sources: [
    { repo: "text", rule: "publish-text-safe", doc: "packages/text/README.md (0.0.7, pull request 32)" },
    { repo: "text", rule: "secret-shapes", doc: "packages/text/src/redact.ts (SECRET_SHAPES, findSecretShapesInValue, 0.0.8)" },
    { repo: "private", rule: "publish-text-safe", doc: "docs/STRATEGY.md (2026-11-16, the publish document has no attack shape and no token)" },
  ],
  options: {},
  failsFrom: "2026-11-16",
  check(context) {
    const breaks: Break[] = [];
    // The one way out of a break: each finished message goes through the redaction again.
    const push = (found: Break): void => {
      breaks.push({ ...found, message: secretFree(found.message) });
    };
    const byId = new Map(ATTACK_SHAPES.map((shape) => [shape.id, shape]));
    const secretById = new Map(SECRET_SHAPES.map((shape) => [shape.id, shape]));
    for (const pkg of versionedPackages(context)) {
      const name = String(pkg.manifest["name"]);
      let names: string[];
      try {
        names = readdirSync(pkg.dir).filter((file) => README.test(file)).sort();
      } catch {
        names = [];
      }
      for (const file of names) {
        let text: string;
        try {
          text = readFileSync(join(pkg.dir, file), "utf8");
        } catch {
          continue;
        }
        for (const hit of attackLines(text)) {
          push({
            file: inFolder(pkg.folder, file),
            line: hit.line,
            message: `The README of ${name} has ${shown(hit.text)}, ${hit.shape.what} (${hit.shape.id}). ${refusalOf(hit.shape)}`,
          });
        }
        for (const hit of secretLines(text)) {
          push({ file: inFolder(pkg.folder, file), line: hit.line, message: `The README of ${name} has ${tokenOf(hit.shape)}` });
        }
      }
      // The whole manifest: each key and each string, in the order of the document. One break for each shape of a
      // string. A match that the rule cannot read still gives a break, with no matched text: a gate shows such a case.
      const done = new Set<string>();
      for (const match of attacksInValue(pkg.manifest)) {
        const once = `${match.inKey}:${JSON.stringify(match.path)}:${match.shape}`;
        if (done.has(once)) continue;
        done.add(once);
        const shape = byId.get(match.shape);
        const value = stringAt(pkg.manifest, match.path, match.inKey);
        const line = pathLine(pkg.text, match.path, match.inKey ? undefined : value);
        const what = shape === undefined ? `the shape ${match.shape}` : `${shape.what} (${shape.id})`;
        const has = value === undefined ? `${what}, in a text that the rule cannot read` : `${shown(value.slice(match.start, match.end))}, ${what}`;
        push({
          file: pkg.file,
          ...(line === undefined ? {} : { line }),
          message: `The ${match.inKey ? "key" : "field"} "${shownPath(match.path)}" of ${name} has ${has}.${shape === undefined ? "" : ` ${refusalOf(shape)}`}`,
        });
      }
      for (const match of findSecretShapesInValue(pkg.manifest)) {
        const once = `secret:${match.inKey}:${JSON.stringify(match.path)}:${match.shape}`;
        if (done.has(once)) continue;
        done.add(once);
        const shape = secretById.get(match.shape) ?? { id: match.shape, label: "a token of a known service" };
        const line = pathLine(pkg.text, match.path, match.inKey ? undefined : stringAt(pkg.manifest, match.path, false));
        push({
          file: pkg.file,
          ...(line === undefined ? {} : { line }),
          message: `The ${match.inKey ? "key" : "field"} "${shownPath(match.path)}" of ${name} has ${tokenOf(shape)}`,
        });
      }
    }
    return breaks;
  },
};
