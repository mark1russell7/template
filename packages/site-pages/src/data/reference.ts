/**
 * The file `reference.json` in the built output folder of a site, format `api-model/1`. The command
 * `api-report model` writes it. It has the public API of each package: the entries, their names, the
 * declarations and the doc comments. The build of the pages reads it, and writes the reference page.
 *
 * This package does not import `api-report`, because `api-report` depends on a package that bundles this
 * package. Thus the format is the contract between the two packages, and this file declares its types.
 */

import type { ReferenceDeclaration, ReferenceEntry, ReferenceFile, ReferenceName, ReferencePackage } from "./types.ts";

/** The name of the format. The command `api-report model` writes the same name. A reader refuses a different name. */
export const REFERENCE_FORMAT = "api-model/1";

/** The name of the file in the built output folder of a site. */
export const REFERENCE_FILE = "reference.json";

/** The kinds of a name of an entry. */
const NAME_KINDS: ReadonlySet<string> = new Set(["declaration", "namespace", "external", "ambient"]);

/** An error in the data of `reference.json`. The field `problems` has one line for each fault. */
export class ReferenceDataError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`${REFERENCE_FILE} is not correct: ${problems.join(" ")}`);
    this.name = "ReferenceDataError";
    this.problems = problems;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** This function gives the faults of one name of an entry. */
function nameProblems(value: unknown, where: string): string[] {
  if (!isRecord(value)) return [`${where} is not an object.`];
  const problems: string[] = [];
  if (typeof value["name"] !== "string" || value["name"] === "") problems.push(`${where} has no name.`);
  if (typeof value["key"] !== "string" || value["key"] === "") problems.push(`${where} has no key.`);
  if (typeof value["isType"] !== "boolean") problems.push(`${where} has no boolean isType.`);
  if (typeof value["kind"] !== "string" || !NAME_KINDS.has(value["kind"])) problems.push(`${where} has no known kind.`);
  return problems;
}

/** This function gives the faults of one package of the file. */
function packageProblems(value: unknown, index: number): string[] {
  const where = `Package ${index}`;
  if (!isRecord(value)) return [`${where} is not an object.`];
  const problems: string[] = [];
  if (typeof value["packageName"] !== "string" || value["packageName"] === "") problems.push(`${where} has no packageName.`);
  const entries = value["entries"];
  if (!Array.isArray(entries)) problems.push(`${where} has no list of entries.`);
  else {
    entries.forEach((entry: unknown, at) => {
      const place = `Entry ${at} of package ${index}`;
      if (!isRecord(entry) || typeof entry["subpath"] !== "string" || !Array.isArray(entry["names"])) problems.push(`${place} has no subpath and list of names.`);
      else entry["names"].forEach((name: unknown, n) => problems.push(...nameProblems(name, `Name ${n} of ${place.toLowerCase()}`)));
    });
  }
  const declarations = value["declarations"];
  if (!isRecord(declarations)) problems.push(`${where} has no object of declarations.`);
  else {
    for (const [key, declaration] of Object.entries(declarations)) {
      const ok = isRecord(declaration) && typeof declaration["text"] === "string" && (declaration["doc"] === undefined || typeof declaration["doc"] === "string");
      if (!ok) problems.push(`The declaration ${key} of package ${index} has no text, or a doc that is not a text.`);
    }
  }
  return problems;
}

/** This function gives the faults of a parsed `reference.json`, or an empty list. */
export function referenceProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["The file is not an object."];
  if (value["format"] !== REFERENCE_FORMAT) return [`The format is not ${REFERENCE_FORMAT}. Use the version of api-report that writes this format.`];
  const packages = value["packages"];
  if (!Array.isArray(packages) || packages.length === 0) return ["The file has no packages."];
  return packages.flatMap((item: unknown, index) => packageProblems(item, index));
}

/** This function gives a copy of a name with only its known fields. */
function cleanName({ name, key, isType, kind }: ReferenceName): ReferenceName {
  return { name, key, isType, kind };
}

/** This function gives a copy of a package with only its known fields. */
function cleanPackage({ packageName, entries, declarations }: ReferencePackage): ReferencePackage {
  // Object.fromEntries makes own fields, so a key such as "__proto__" does not change the prototype
  const clean: Record<string, ReferenceDeclaration> = Object.fromEntries(
    Object.entries(declarations).map(([key, { text, doc }]) => [key, doc === undefined ? { text } : { text, doc }]),
  );
  return { packageName, entries: entries.map(({ subpath, names }): ReferenceEntry => ({ subpath, names: names.map(cleanName) })), declarations: clean };
}

/**
 * This function reads the text of a `reference.json`, and gives the file with only its known fields.
 *
 * @throws ReferenceDataError when the text is not correct
 */
export function readReference(text: string): ReferenceFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ReferenceDataError([`The file is not JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const problems = referenceProblems(value);
  if (problems.length > 0) throw new ReferenceDataError(problems);
  return { format: REFERENCE_FORMAT, packages: (value as ReferenceFile).packages.map(cleanPackage) };
}
