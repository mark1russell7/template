/**
 * The rule `api-report-script`: a repository with a public package has the root script that checks its API reports.
 */
import { codePackages, DEPENDENCY_FIELDS, lineOf, specifiersOf, type Break, type Edit, type PackageInfo, type Rule } from "../rule.ts";
import { isPublic } from "./license-file.ts";

/** The package of the reports. */
const API_REPORT = "@mark1russell7/api-report";

/** The range that the fix adds. The train moves it after that. */
export const API_REPORT_RANGE = "^0.3.1";

/** The command of the script. */
const COMMAND = "api-report check";

/**
 * This function gives `text` with one more entry in the block `field` of a `package.json` file. The entry goes in the
 * order of the names when `sorted` is true, else at the end. It gives undefined when the block is not on separate lines.
 */
function addEntry(text: string, field: string, name: string, value: string, sorted: boolean): string | undefined {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  "${field}": {`);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^ {2}\},?$/.test(line));
  if (end < 0) return undefined;
  const entry = `    ${JSON.stringify(name)}: ${JSON.stringify(value)}`;
  const nameOf = (line: string): string => line.trim().slice(1).split('"')[0] ?? "";
  const next = sorted ? lines.findIndex((line, index) => index > start && index < end && nameOf(line) > name) : -1;
  if (next >= 0) lines.splice(next, 0, `${entry},`);
  else {
    if (end - 1 > start) lines[end - 1] = `${lines[end - 1] ?? ""},`;
    lines.splice(end, 0, entry);
  }
  return lines.join(eol);
}

/** This function adds a block with one entry after the last block of the root object. */
function addBlock(text: string, field: string, name: string, value: string): string | undefined {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const end = lines.lastIndexOf("}");
  if (end < 1) return undefined;
  lines[end - 1] = `${lines[end - 1] ?? ""},`;
  lines.splice(end, 0, `  ${JSON.stringify(field)}: {`, `    ${JSON.stringify(name)}: ${JSON.stringify(value)}`, "  }");
  return lines.join(eol);
}

/** This function gives the text of the root `package.json` with the script and the dependency, or undefined. */
function withScript(root: PackageInfo, script: string): string | undefined {
  const add = (text: string, field: string, name: string, value: string, sorted: boolean): string | undefined =>
    root.manifest[field] === undefined ? addBlock(text, field, name, value) : addEntry(text, field, name, value, sorted);
  const scripted = add(root.text, "scripts", script, COMMAND, false);
  if (scripted === undefined) return undefined;
  const has = DEPENDENCY_FIELDS.some((field) => specifiersOf(root.manifest, field).some(([name]) => name === API_REPORT));
  return has ? scripted : add(scripted, "devDependencies", API_REPORT, API_REPORT_RANGE, true);
}

export const apiReportScript: Rule = {
  id: "api-report-script",
  title: "A repository with a public package has the root script `check:api`.",
  reason:
    "The shared CI starts each script of its list that `package.json` has, and it skips the others. On 2026-11-04, 8 of the 12 repositories without the script had a public package, so a change of their API had no check.",
  fix: 'Add the script `"check:api": "api-report check"` and a dev dependency on `@mark1russell7/api-report`. Then build and start `api-report update`. The release train writes the first report in its update.',
  sources: [{ repo: "template", rule: "api-report", doc: "CLAUDE.md:27" }],
  options: {
    script: { type: "string", default: "check:api", description: "The root script that checks the API reports." },
  },
  check(context, options) {
    const script = typeof options["script"] === "string" ? options["script"] : "check:api";
    const published = codePackages(context).filter(isPublic);
    if (published.length === 0) return [];
    const root = context.rootPackage;
    const value = root.manifest["scripts"];
    const scripts = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    if (typeof scripts[script] === "string" && scripts[script] !== "") return [];
    const names = published.map((pkg) => String(pkg.manifest["name"] ?? pkg.folder));
    const line = lineOf(root.text, '"scripts"');
    const after = withScript(root, script);
    const edits: readonly Edit[] = after === undefined ? [] : [{ file: root.file, before: root.text, after }];
    const item: Break = {
      file: root.file,
      ...(line === undefined ? {} : { line }),
      message: `The root package.json has no script "${script}", and the repository has a public package: ${names.join(", ")}.`,
      ...(edits.length > 0 ? { edits } : {}),
    };
    return [item];
  },
};
