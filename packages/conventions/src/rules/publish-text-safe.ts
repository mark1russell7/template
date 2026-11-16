/**
 * The rule `publish-text-safe`: the text that npm puts in the publish document of a public package has no line in the
 * shape of an attack. It also has no token of a known service. This text is each README file of the package folder, the
 * field `description` and the field `keywords`. The registry screens the document, and it refuses a document with the
 * shape of a SQL probe (E403). The registry shows the text to each reader, and its mirrors keep a copy of each version.
 *
 * The shapes of the tokens come from `SECRET_SHAPES` of `@mark1russell7/text/redact`, the home of the redaction of
 * secrets. This file has no copy of these patterns. A break gives the line and the name of the shape, not the token.
 *
 * This rule does not wait `RULE_WARN_DAYS`: it fails from its release day. The wait gives the owners time to fix the
 * breaks of a new rule. On 2026-11-16 a measure of the shapes of this file read 448 README files and 660 manifests of
 * the local clones. It found 1 true example, the README of text 0.0.7 (in 2 old clones), and 0 false hits. A measure of
 * the token shapes of text 0.0.8 read 441 README files and 655 manifests of the same clones, and it found 0 tokens.
 *
 * Thus the wait protects no repository. A wait of 14 days lets a repeat of the text case pass with only a warning.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findSecretShapes, SECRET_SHAPES, type SecretShape } from "@mark1russell7/text/redact";
import { inFolder, lineOf, versionedPackages, type Break, type Rule } from "../rule.ts";

/** A shape of an attack in a text: an id, the words for the message, and the pattern. */
export interface AttackShape {
  readonly id: string;
  /** The shape in words, for the message of a break. */
  readonly what: string;
  readonly pattern: RegExp;
}

/**
 * The shapes of the attacks, as the screen of a web application finds them (the SQL rules of the OWASP Core Rule Set).
 * The first shape stopped each publish of @mark1russell7/text 0.0.7. The other shapes come from the same rule set.
 * A script tag is not here: @mark1russell7/site-pages 0.5.4 has one in its README, and its publish passed.
 */
export const ATTACK_SHAPES: readonly AttackShape[] = Object.freeze([
  { id: "sql-boolean", what: "a SQL probe: AND or OR, a number, a comparison and a number", pattern: /\b(?:and|or)\s+\d+\s*(?:=|<>|!=)\s*\d+(?!\w)/i },
  { id: "sql-tautology", what: "a SQL tautology: a quote, AND or OR, and two equal values", pattern: /(['"])\s*(?:or|and)\s+(['"]?)(\w+)\2\s*=\s*\2\3(?!\w)/i },
  { id: "sql-union", what: "a SQL UNION SELECT", pattern: /\bunion\s+(?:all\s+)?select\b/i },
  { id: "sql-drop", what: "a SQL DROP after a semicolon", pattern: /;\s*drop\s+(?:table|database)\b/i },
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

/** This function gives a matched text for a message, with no line end and at most 60 characters. */
const shown = (text: string): string => JSON.stringify(text.length > 60 ? `${text.slice(0, 57)}...` : text);

/** This function gives the end of the message of a token. It names the shape, and it does not show the token. */
const tokenOf = (shape: SecretShape): string =>
  `${shape.label} (${shape.id}). npm shows this text to each reader of the package. Revoke the secret at its service, and then remove it.`;

export const publishTextSafe: Rule = {
  id: "publish-text-safe",
  title: "The text that npm puts in the publish document of a public package (each README, `description` and `keywords`) has no line in the shape of an attack, and no token of a known service.",
  reason:
    "The npm registry screens the publish document, and it refuses a document with the shape of a SQL probe. On 2026-11-15 and 2026-11-16, each publish of @mark1russell7/text 0.0.7 failed with E403. An example in its README had AND, a number, an equal sign and a number. The error does not name the cause, so the release looked like a fault of the trust of the package. A new README example went out, and the same trust published 0.0.7. A token in this text goes to each reader of the package, and the mirrors of the registry keep each version, so a later fix does not remove the token.",
  fix: "Write the example with other words or values, for example `partsAt(\"A wide river\", [[2, 6]])`. For a token, revoke it at its service first, and then write a fake value, for example `TOKEN-EXAMPLE`. A changed README of a released package needs a PATCH version.",
  sources: [
    { repo: "text", rule: "publish-text-safe", doc: "packages/text/README.md (0.0.7, pull request 32)" },
    { repo: "text", rule: "secret-shapes", doc: "packages/text/src/redact.ts (SECRET_SHAPES, 0.0.8)" },
  ],
  options: {},
  failsFrom: "2026-11-16",
  check(context) {
    const breaks: Break[] = [];
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
          breaks.push({
            file: inFolder(pkg.folder, file),
            line: hit.line,
            message: `The README of ${name} has ${shown(hit.text)}, ${hit.shape.what} (${hit.shape.id}). The npm registry can refuse the publish (E403).`,
          });
        }
        for (const hit of secretLines(text)) {
          breaks.push({ file: inFolder(pkg.folder, file), line: hit.line, message: `The README of ${name} has ${tokenOf(hit.shape)}` });
        }
      }
      const keywords = pkg.manifest["keywords"];
      const fields: [string, string][] = [
        ...(typeof pkg.manifest["description"] === "string" ? [["description", pkg.manifest["description"]] as [string, string]] : []),
        ...(Array.isArray(keywords) ? keywords.filter((word): word is string => typeof word === "string").map((word) => ["keywords", word] as [string, string]) : []),
      ];
      for (const [field, value] of fields) {
        for (const hit of attackLines(value)) {
          const line = lineOf(pkg.text, `"${field}"`);
          breaks.push({
            file: pkg.file,
            ...(line === undefined ? {} : { line }),
            message: `The field "${field}" of ${name} has ${shown(hit.text)}, ${hit.shape.what} (${hit.shape.id}). The npm registry can refuse the publish (E403).`,
          });
        }
        for (const hit of secretLines(value)) {
          const line = lineOf(pkg.text, `"${field}"`);
          breaks.push({ file: pkg.file, ...(line === undefined ? {} : { line }), message: `The field "${field}" of ${name} has ${tokenOf(hit.shape)}` });
        }
      }
    }
    return breaks;
  },
};
