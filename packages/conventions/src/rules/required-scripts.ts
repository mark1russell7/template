/**
 * The rule `required-scripts`: the root `package.json` keeps the scripts that the shared CI starts.
 */
import { lineOf, type Break, type Rule } from "../rule.ts";

export const requiredScripts: Rule = {
  id: "required-scripts",
  title: "The root `package.json` has the scripts `lint:ste` and `typecheck`.",
  reason:
    "The shared CI starts each script of its list that `package.json` has, and it skips the others. Thus a removed script turns its check off, and nothing shows it.",
  fix: 'Add the script back, for example `"lint:ste": "ste-lint"` or `"typecheck": "pnpm -r run typecheck"`.',
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
    scripts: { type: "strings", default: ["lint:ste", "typecheck"], description: "The scripts that the root `package.json` has." },
  },
  check(context, options) {
    const wanted = Array.isArray(options["scripts"]) ? options["scripts"] : ["lint:ste", "typecheck"];
    const value = context.rootPackage.manifest["scripts"];
    const scripts = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const line = lineOf(context.rootPackage.text, '"scripts"');
    return wanted
      .filter((name) => typeof scripts[name] !== "string" || scripts[name] === "")
      .map((name): Break => ({ file: context.rootPackage.file, ...(line === undefined ? {} : { line }), message: `The root package.json has no script "${name}".` }));
  },
};
