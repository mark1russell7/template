/**
 * The rule `coverage-provider`: the shared CI starts the action `coverage`. Then each package whose test script starts
 * Vitest has `@vitest/coverage-v8` at the range of its Vitest. Without the provider, the action skips the package on
 * `main`, so the artifact `coverage` has no report of it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codePackages, DEPENDENCY_FIELDS, keyLine, specifiersOf, type Break, type PackageInfo, type Rule } from "../rule.ts";
import { childKeys, indentOf, keyValue, workflowLines } from "../workflow.ts";
import { addBlock, addEntry } from "./api-report-script.ts";
import { repositoryIsPublic } from "./license-file.ts";

/** The provider of the coverage of Vitest. */
export const COVERAGE_PROVIDER = "@vitest/coverage-v8";

/** The `uses` value of a job that calls the shared CI, from another repository or from the template itself. */
const SHARED_CI_CALL = /^(?:mark1russell7\/template\/|\.\/)\.github\/workflows\/reusable-ci\.ya?ml(?:@|$)/;

/** The inputs of the shared CI that start the action `coverage`. */
export interface CoverageInputs {
  /** The value of the input `coverage`, or an empty text when the caller does not give it (default false). */
  readonly coverage: string;
  /** The value of the input `coverage-on-main`, or an empty text when the caller does not give it (default true). */
  readonly onMain: string;
}

/** This function gives the id of the key of a line of YAML. */
const keyOf = (line: string): string => {
  const text = line.trim();
  const colon = text.indexOf(":");
  return (colon < 0 ? text : text.slice(0, colon)).replace(/^["']|["']$/g, "");
};

/** This function gives the coverage inputs of each job of a workflow text that calls the shared CI. */
export function coverageInputs(text: string): CoverageInputs[] {
  const lines = workflowLines(text);
  const jobs = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "jobs") !== undefined);
  if (jobs < 0) return [];
  const found: CoverageInputs[] = [];
  for (const job of childKeys(lines, jobs)) {
    const keys = childKeys(lines, job);
    const uses = keys.map((at) => keyValue(lines[at] ?? "", "uses")).find((value) => value !== undefined);
    if (uses === undefined || !SHARED_CI_CALL.test(uses)) continue;
    const inputs = new Map<string, string>();
    const block = keys.find((at) => keyOf(lines[at] ?? "") === "with");
    for (const at of block === undefined ? [] : childKeys(lines, block)) {
      const name = keyOf(lines[at] ?? "");
      inputs.set(name, (keyValue(lines[at] ?? "", name) ?? "").replace(/^["']|["']$/g, ""));
    }
    found.push({ coverage: inputs.get("coverage") ?? "", onMain: inputs.get("coverage-on-main") ?? "" });
  }
  return found;
}

/** This function gives the specifier of a dependency in a manifest, and its field, or undefined. */
function specifierOf(pkg: PackageInfo, name: string): { field: string; range: string } | undefined {
  for (const field of DEPENDENCY_FIELDS) {
    const found = specifiersOf(pkg.manifest, field).find(([key]) => key === name);
    if (found !== undefined) return { field, range: found[1] };
  }
  return undefined;
}

/** This function gives the test script of a package, or an empty text. */
function testScript(pkg: PackageInfo): string {
  const scripts = pkg.manifest["scripts"];
  if (typeof scripts !== "object" || scripts === null) return "";
  const test = (scripts as Record<string, unknown>)["test"];
  return typeof test === "string" ? test : "";
}

/** This function gives `text` with the range of a dependency in the block `field` changed to `range`, or undefined. */
function withRange(text: string, field: string, name: string, from: string, range: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  "${field}": {`);
  if (start < 0) return undefined;
  const entry = `${JSON.stringify(name)}: ${JSON.stringify(from)}`;
  const at = lines.findIndex((line, index) => index > start && line.trim().startsWith(entry));
  if (at < 0) return undefined;
  lines[at] = (lines[at] ?? "").replace(entry, `${JSON.stringify(name)}: ${JSON.stringify(range)}`);
  return lines.join(text.includes("\r\n") ? "\r\n" : "\n");
}

export const coverageProvider: Rule = {
  id: "coverage-provider",
  title: "When the shared CI starts the action `coverage`, each package with Vitest tests has `@vitest/coverage-v8` at the range of its Vitest.",
  reason:
    "On `main` of a public repository, the shared CI starts the action `coverage`, and the action skips a package with no `@vitest/coverage-v8`. The artifact `coverage` then has no report of it, and the atlas has no coverage of its functions. On 2026-11-09, 15 of 43 public repositories had no provider. Only `pnpm package add` adds it, and only to a new package. A provider at another range than Vitest fails to load.",
  fix: 'Add `"@vitest/coverage-v8"` to `devDependencies` at the range of `vitest`, in the manifest that has `vitest`. `conventions fix` writes it. Then start `pnpm install`. A repository that turns off the coverage of its CI (`coverage-on-main: false`) does not break.',
  sources: [
    { repo: "template", rule: "coverage-provider", doc: "packages/cli/src/commands/package/add.ts: the LOCKSTEP of @vitest/coverage-v8 and vitest in each new package" },
    { repo: "ireko", rule: "coverage-provider", doc: "packages/ireko/package.json: @vitest/coverage-v8 at the range of vitest, and the artifact coverage of ci.yml" },
    { repo: "codeatlas", rule: "coverage-provider", doc: "packages/*/package.json: @vitest/coverage-v8 at the range of vitest in each package with tests" },
  ],
  options: {},
  failsFrom: "2026-11-25",
  check(context) {
    const folder = join(context.root, ".github", "workflows");
    const calls = existsSync(folder)
      ? readdirSync(folder)
          .filter((file) => /\.ya?ml$/.test(file))
          .sort()
          .flatMap((file) => coverageInputs(readFileSync(join(folder, file), "utf8")))
      : [];
    if (calls.length === 0) return { skipped: "no workflow calls the shared CI of the template" };
    const isPublic = repositoryIsPublic(context);
    const runs = calls.some((call) => call.coverage === "true" || (call.onMain !== "false" && isPublic !== false));
    if (!runs) return { skipped: "the shared CI does not start the action coverage (coverage and coverage-on-main are off)" };

    const root = context.rootPackage;
    const breaks = new Map<string, Break>();
    for (const pkg of codePackages(context)) {
      if (!/\bvitest\b/.test(testScript(pkg))) continue;
      // pnpm links a dependency of the root in each package, so the root can hold Vitest and the provider
      const owner = specifierOf(pkg, "vitest") === undefined ? root : pkg;
      const vitest = specifierOf(owner, "vitest");
      if (vitest === undefined) continue;
      const providerAt = specifierOf(pkg, COVERAGE_PROVIDER) === undefined ? root : pkg;
      const provider = specifierOf(providerAt, COVERAGE_PROVIDER);
      const name = String(pkg.manifest["name"] ?? (pkg.folder === "" ? "the root" : pkg.folder));
      if (provider === undefined) {
        if (breaks.has(owner.file)) continue;
        // A catalog range needs an entry of the catalog too, so a person writes it
        const after = vitest.range.startsWith("catalog:")
          ? undefined
          : owner.manifest["devDependencies"] === undefined
            ? addBlock(owner.text, "devDependencies", COVERAGE_PROVIDER, vitest.range)
            : addEntry(owner.text, "devDependencies", COVERAGE_PROVIDER, vitest.range, true);
        const line = keyLine(owner.text, vitest.field, "vitest");
        breaks.set(owner.file, {
          file: owner.file,
          ...(line === undefined ? {} : { line }),
          message: `${name} starts Vitest in its test script, and no manifest gives it ${COVERAGE_PROVIDER}. The action coverage of the shared CI skips it.`,
          ...(after === undefined ? { fix: `Add "${COVERAGE_PROVIDER}": "${vitest.range}" to devDependencies of ${owner.file}.` } : { edits: [{ file: owner.file, before: owner.text, after }] }),
        });
        continue;
      }
      if (provider.range === vitest.range || breaks.has(providerAt.file)) continue;
      const after = withRange(providerAt.text, provider.field, COVERAGE_PROVIDER, provider.range, vitest.range);
      const line = keyLine(providerAt.text, provider.field, COVERAGE_PROVIDER);
      breaks.set(providerAt.file, {
        file: providerAt.file,
        ...(line === undefined ? {} : { line }),
        message: `${COVERAGE_PROVIDER} has the range ${provider.range} in ${providerAt.file}, and vitest has ${vitest.range}. The provider must have the range of Vitest.`,
        ...(after === undefined ? { fix: `Set "${COVERAGE_PROVIDER}" to "${vitest.range}" in ${providerAt.file}.` } : { edits: [{ file: providerAt.file, before: providerAt.text, after }] }),
      });
    }
    return [...breaks.values()];
  },
};
