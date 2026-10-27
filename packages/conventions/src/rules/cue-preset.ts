/**
 * The rule `cue-preset`: the `tsconfig.json` of each package extends a preset of `@mark1russell7/cue`.
 * No config of a package turns off a strict option of its preset.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { codePackages, hasFile, inFolder, lineOf, readJsonc, type Break, type Rule } from "../rule.ts";

/** The compiler options that make the type check strict. A package does not turn them off. */
export const STRICT_OPTIONS = [
  "strict",
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "strictBuiltinIteratorReturn",
  "noImplicitThis",
  "useUnknownInCatchVariables",
  "alwaysStrict",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "noPropertyAccessFromIndexSignature",
] as const;

/** The options that `strict` turns on when a config does not set them. */
const STRICT_FAMILY = new Set<string>([
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "strictBuiltinIteratorReturn",
  "noImplicitThis",
  "useUnknownInCatchVariables",
  "alwaysStrict",
]);

type Json = Readonly<Record<string, unknown>>;

const asObject = (value: unknown): Json => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {});

/** This function gives the `extends` list of a tsconfig. */
const extendsOf = (config: Json): string[] => {
  const value = config["extends"];
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
};

/** The compiler options that a config gets from the configs that it extends. */
interface Inherited {
  readonly options: Json;
  /** False when the config extends a config that the rule cannot read. */
  readonly complete: boolean;
}

/**
 * This function gives the compiler options of the configs that `config` extends, with the options of
 * a later config over an earlier one.
 */
function inheritedOptions(config: Json, dir: string, depth = 0): Inherited {
  if (depth > 10) return { options: {}, complete: false };
  let options: Json = {};
  let complete = true;
  for (const base of extendsOf(config)) {
    let file: string | undefined;
    if (base.startsWith(".")) file = resolve(dir, base.endsWith(".json") ? base : `${base}.json`);
    else {
      try {
        file = createRequire(join(dir, "package.json")).resolve(base);
      } catch {
        file = undefined;
      }
    }
    const parent = file === undefined ? undefined : readJsonc(file);
    if (parent === undefined || file === undefined) {
      complete = false;
      continue;
    }
    const above = inheritedOptions(asObject(parent), dirname(file), depth + 1);
    complete &&= above.complete;
    options = { ...options, ...above.options, ...asObject(asObject(parent)["compilerOptions"]) };
  }
  return { options, complete };
}

/**
 * This function tells if a config that extends configs with the options `inherited` turns on the
 * option. When the rule cannot read each config, it gives true: the package turns off a strict option.
 */
function inheritedOn(option: string, inherited: Inherited): boolean {
  if (!inherited.complete) return true;
  const value = inherited.options[option];
  if (typeof value === "boolean") return value;
  return STRICT_FAMILY.has(option) && inherited.options["strict"] === true;
}

export const cuePreset: Rule = {
  id: "cue-preset",
  title: "The `tsconfig.json` of each package extends a preset of `@mark1russell7/cue`, and no config of a package turns off a strict option.",
  reason:
    "`pnpm package add` writes the configs from a preset, so each package checks its types with the same strict options. A config by hand or a strict option turned off lets the packages drift apart.",
  fix: "Make the package with `pnpm package add <name> --preset=<preset>`, or set `extends` to `@mark1russell7/cue/ts/config/<preset>.json`. Correct the code, not the strict option.",
  sources: [
    { repo: "client", rule: "cue-config", doc: "CLAUDE.md:64" },
    { repo: "client", rule: "no-manual-tsconfig", doc: "CLAUDE.md:64" },
    { repo: "Graph", rule: "cue-preset-strict", doc: "docs/architecture/ecosystem-and-structure.md:58" },
    { repo: "Graph", rule: "strict-preset", doc: "docs/architecture/ecosystem-and-structure.md:58" },
    { repo: "Graph", rule: "new-package-via-cli", doc: "CLAUDE.md:14" },
    { repo: "coeval", rule: "package-scaffold", doc: "CLAUDE.md:16" },
    { repo: "crawler", rule: "package-scaffold", doc: "CLAUDE.md:16" },
    { repo: "headroom", rule: "package-scaffold", doc: "CLAUDE.md:30" },
    { repo: "Vex", rule: "package-scaffold", doc: "CLAUDE.md:22" },
  ],
  options: {
    prefix: { type: "string", default: "@mark1russell7/cue/", description: "The start of the `extends` path of a preset." },
  },
  check(context, options) {
    const prefix = typeof options["prefix"] === "string" ? options["prefix"] : "@mark1russell7/cue/";
    const breaks: Break[] = [];
    for (const info of codePackages(context)) {
      if (!hasFile(info.dir, "tsconfig.json")) continue;
      for (const name of ["tsconfig.json", "tsconfig.test.json"]) {
        const path = join(info.dir, name);
        const file = inFolder(info.folder, name);
        const value = readJsonc(path);
        if (value === undefined) {
          if (hasFile(info.dir, name)) breaks.push({ file, message: `${name} is not JSON.`, fix: "Correct the JSON." });
          continue;
        }
        const config = asObject(value);
        if (name === "tsconfig.json" && !extendsOf(config).some((base) => base.startsWith(prefix))) {
          const line = lineOf(readFileSync(path, "utf8"), '"extends"');
          breaks.push({ file, ...(line === undefined ? {} : { line }), message: `tsconfig.json does not extend a preset of ${prefix.replace(/\/$/, "")}.` });
        }
        const own = asObject(config["compilerOptions"]);
        const inherited = inheritedOptions(config, info.dir);
        for (const option of STRICT_OPTIONS) {
          if (own[option] !== false || !inheritedOn(option, inherited)) continue;
          breaks.push({ file, message: `${name} turns off the strict option ${option}.`, fix: `Remove "${option}": false, and correct the code that it hides.` });
        }
      }
    }
    return breaks;
  },
};
