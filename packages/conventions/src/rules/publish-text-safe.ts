/**
 * The rule `publish-text-safe`: the text that npm puts in the publish document of a public package has no line in the
 * shape of an attack. This text is each README file of the package folder, the field `description` and the field
 * `keywords`. The registry screens the document. On 2026-11-15 it refused a document with the shape of a SQL probe
 * (E403), and the error did not name the cause.
 *
 * This rule does not wait `RULE_WARN_DAYS`: it fails from its release day. The wait gives the owners time to fix the
 * breaks of a new rule. On 2026-11-16 a first read of the local clones used the shapes of this file. It found 1 true
 * example, the README of text 0.0.7 (in 2 old clones), and 0 false hits. Thus the wait protects no repository. A wait
 * of 14 days lets a repeat of the text case pass with only a warning.
 *
 * At 11:32 UTC of the same day, one read of 446 README files and 664 manifests of the local clones found 0 hits. The
 * sessions add, pull and remove clones during a day, so each count is the count of one read.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/** The names of the README files that npm packs from the folder of a package, with each case and extension. */
const README = /^readme(?:\.[\w-]+)?$/i;

/** This function gives a matched text for a message, with no line end and at most 60 characters. */
const shown = (text: string): string => JSON.stringify(text.length > 60 ? `${text.slice(0, 57)}...` : text);

/** This function gives the end of the message of an attack shape: the refusal on record, or the source of the shape. */
const refusalOf = (shape: AttackShape): string =>
  shape.seen === null
    ? "The shape follows a SQL rule of the OWASP Core Rule Set, so the npm registry can refuse the publish (E403). No refusal of it is on record."
    : `The npm registry refused a publish with this shape (${shape.seen}).`;

export const publishTextSafe: Rule = {
  id: "publish-text-safe",
  title: "The text that npm puts in the publish document of a public package (each README, `description` and `keywords`) has no line in the shape of an attack.",
  reason:
    "The npm registry screens the publish document, and it refused a document with the shape of a SQL probe. On 2026-11-15 and 2026-11-16, each publish of @mark1russell7/text 0.0.7 failed with E403. An example in its README had AND, a number, an equal sign and a number. The error does not name the cause, so the release looked like a fault of the trust of the package. A new README example went out, and the same trust published 0.0.7.",
  fix: "Write the example with other words or values, for example `partsAt(\"A wide river\", [[2, 6]])`. A changed README of a released package needs a PATCH version.",
  sources: [
    { repo: "text", rule: "publish-text-safe", doc: "packages/text/README.md (0.0.7, pull request 32)" },
    { repo: "private", rule: "publish-text-safe", doc: "docs/STRATEGY.md (2026-11-16, the publish document has no attack shape and no token)" },
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
            message: `The README of ${name} has ${shown(hit.text)}, ${hit.shape.what} (${hit.shape.id}). ${refusalOf(hit.shape)}`,
          });
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
            message: `The field "${field}" of ${name} has ${shown(hit.text)}, ${hit.shape.what} (${hit.shape.id}). ${refusalOf(hit.shape)}`,
          });
        }
      }
    }
    return breaks;
  },
};
