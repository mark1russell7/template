/**
 * The rule `required-scripts`: the root `package.json` keeps the scripts that the shared CI starts.
 */
import { DEPENDENCY_FIELDS, hasFile, lineOf, specifiersOf, type Break, type RuleContext, type Rule } from "../rule.ts";

/** The package of the STE linter. */
const STE_LINT = "@mark1russell7/ste-lint";

/** The configuration file of the STE linter. */
const STE_CONFIG = "ste.config.json";

/** The examples of the scripts that the fix shows. */
const EXAMPLES: Readonly<Record<string, string>> = { "lint:ste": "ste-lint", typecheck: "pnpm -r run typecheck" };

/**
 * This function tells if the repository uses the STE prose standard: the root `package.json` has a
 * dependency on `@mark1russell7/ste-lint`, or the root has a `ste.config.json`.
 */
export function usesSteLint(context: RuleContext): boolean {
  const manifest = context.rootPackage.manifest;
  if (DEPENDENCY_FIELDS.some((field) => specifiersOf(manifest, field).some(([name]) => name === STE_LINT))) return true;
  return hasFile(context.root, STE_CONFIG);
}

export const requiredScripts: Rule = {
  id: "required-scripts",
  title: "The root `package.json` has the script `typecheck`, and also `lint:ste` when the repository uses `ste-lint`.",
  reason:
    "The shared CI starts each script of its list that `package.json` has, and it skips the others. Thus a removed script turns its check off, and nothing shows it.",
  fix: 'Add the script, for example `"lint:ste": "ste-lint"` or `"typecheck": "pnpm -r run typecheck"`.',
  sources: [
    { repo: "client", rule: "ste-prose", doc: "CLAUDE.md:5" },
    { repo: "coeval", rule: "ste-prose", doc: "CLAUDE.md:5" },
    { repo: "crawler", rule: "ste-prose", doc: "CLAUDE.md:5" },
    { repo: "Graph", rule: "ste-prose", doc: "CLAUDE.md:5" },
    { repo: "headroom", rule: "ste-prose", doc: "CLAUDE.md:19" },
    { repo: "systems", rule: "lint-ste-in-ci", doc: "CLAUDE.md:24" },
    { repo: "Vex", rule: "ste-prose", doc: "CLAUDE.md:5" },
    { repo: "coeval", rule: "tsconfig-test", doc: "CLAUDE.md:18" },
    { repo: "crawler", rule: "tsconfig-test", doc: "CLAUDE.md:18" },
    { repo: "headroom", rule: "tsconfig-test", doc: "CLAUDE.md:32" },
    { repo: "Vex", rule: "tsconfig-test", doc: "CLAUDE.md:23" },
  ],
  options: {
    scripts: { type: "strings", default: ["typecheck"], description: "The scripts that the root `package.json` has." },
    steScripts: {
      type: "strings",
      default: ["lint:ste"],
      description: "The scripts that the root `package.json` has when the repository uses `ste-lint` (a dependency on `@mark1russell7/ste-lint`, or a `ste.config.json` at the root).",
    },
  },
  check(context, options) {
    const always = Array.isArray(options["scripts"]) ? options["scripts"] : ["typecheck"];
    const ste = Array.isArray(options["steScripts"]) ? options["steScripts"] : ["lint:ste"];
    const wanted = [...new Set([...always, ...(usesSteLint(context) ? ste : [])])];
    const value = context.rootPackage.manifest["scripts"];
    const scripts = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const line = lineOf(context.rootPackage.text, '"scripts"');
    return wanted
      .filter((name) => typeof scripts[name] !== "string" || scripts[name] === "")
      .map((name): Break => {
        const example = EXAMPLES[name];
        const why = ste.includes(name) && !always.includes(name) ? " The repository uses ste-lint." : "";
        return {
          file: context.rootPackage.file,
          ...(line === undefined ? {} : { line }),
          message: `The root package.json has no script "${name}".${why}`,
          fix: example === undefined ? `Add the script "${name}".` : `Add the script, for example "${name}": "${example}".`,
        };
      });
  },
};
