/**
 * The rule `home-package`: a change does not add a function that belongs in the home of another area (the map of homes).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addedLines } from "../change.ts";
import { HOME_EXPORTS } from "../home-exports.ts";
import { HOMES, type Home } from "../map.ts";
import type { Break, Rule, RuleContext } from "../rule.ts";
import { byCode } from "../workspace.ts";

/** The files of code that the rule reads. A declaration file has no functions of its own. */
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIPPED = /(?:^|\/)(?:node_modules|build|dist|vendor)\/|\.d\.[cm]?ts$/;

/** A declaration of a function: `function name`, or `const name = (` / `= function` / `= <T>(`, with `export` and `async`. */
const DECLARATION = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*(?:\*\s*)?([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function\b|<[A-Za-z])/;

/** One signature of a home, as a regular expression of a whole name. */
interface Signature {
  readonly home: Home;
  readonly pattern: RegExp;
}

/** This function gives the signatures of the homes that a repository can use: on npm, or in a repository with a pin. */
export function signaturesOf(homes: readonly Home[]): Signature[] {
  return homes.filter((home) => home.state === "published" || home.state === "unpublished").flatMap((home) => (home.signatures ?? []).map((source) => ({ home, pattern: new RegExp(`^(?:${source})$`) })));
}

/** This function gives the name of the function that a line declares, or undefined. */
export function declaredName(line: string): string | undefined {
  const match = DECLARATION.exec(line);
  return match?.[1] ?? match?.[2];
}

/** This function gives the repository of the root as owner/name, in lower case: the remote origin, or GITHUB_REPOSITORY. */
export function repoOf(context: RuleContext): string | undefined {
  const url = context.git(["remote", "get-url", "origin"])?.trim();
  const match = url === undefined ? null : /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  if (match?.[1] !== undefined) return match[1].toLowerCase();
  const env = context.env["GITHUB_REPOSITORY"];
  return env === undefined || env === "" ? undefined : env.toLowerCase();
}

/** This function gives the message of a break: the home, and if the home already exports the name. */
export function messageOf(file: string, name: string, home: Home): string {
  const exporter = home.packages.find((pkg) => HOME_EXPORTS[pkg]?.names.includes(name) === true);
  const where = home.packages.length === 0 ? home.repo : home.packages.map((pkg) => `\`${pkg}\``).join(", ");
  const use = home.state === "unpublished" ? ` (not on npm: use a github: specifier pinned to a commit of ${home.repo})` : "";
  return exporter === undefined
    ? `${file} adds \`${name}\`, a function of the area ${home.title} (${home.area}). Its home is ${where}${use}, which does not export \`${name}\` yet: add it to the home in a pull request of ${home.repo}, then import it.`
    : `${file} adds \`${name}\`, a function of the area ${home.title} (${home.area}). Import \`${name}\` from \`${exporter}\`${use} in place of a local copy.`;
}

export const homePackage: Rule = {
  id: "home-package",
  title: "A change does not add a function that belongs in the home of another area: a name that a home of the map of homes gives as its signature.",
  reason:
    "Each area of code has one home package (conventions map). A local copy of a helper of another area drifts from the home and splits the fixes: on 2026-11-02 the fleet had 68 local statistics functions (median, quantile, bootstrap and more) in 14 repositories, while @mark1russell7/rigor-statistics was on npm. The check examines only the lines that a change adds, so the copies that exist do not break, and the count can only go down.",
  fix: "Import the function from its home. If the home does not have it, add it to the home in a pull request of the home repository, then import it. A function that only has the name of a signature and does another thing gets a new name.",
  sources: [{ repo: "fleet", rule: "direction-18", doc: "docs/STRATEGY.md (2026-11-02, one map of homes, checked when the code is written)" }],
  options: {
    scope: {
      type: "string",
      default: "change",
      description: "`change`: only the lines that the change adds (a pull request, or `--base`). `all`: each line of each tracked file, for a sweep of the copies that exist.",
    },
  },
  check(context, options) {
    const scope = options["scope"];
    if (scope !== "change" && scope !== "all") throw new Error(`The option scope is "change" or "all", not ${JSON.stringify(scope)}.`);
    const repo = repoOf(context);
    const signatures = signaturesOf(HOMES).filter((signature) => signature.home.repo.toLowerCase() !== repo);
    if (signatures.length === 0) return [];
    let files: readonly string[];
    let added: ReadonlyMap<string, ReadonlySet<number>> | undefined;
    if (scope === "change") {
      added = addedLines(context);
      if (added === undefined) return { skipped: "no change: the rule examines the lines that a pull request or --base adds (option scope: all examines each line)" };
      files = [...added.keys()];
    } else {
      const tracked = context.gitFiles();
      if (tracked === undefined) return { skipped: "the root is not in a git repository" };
      files = tracked;
    }
    const breaks: Break[] = [];
    for (const file of files.filter((path) => CODE_FILE.test(path) && !SKIPPED.test(path)).sort(byCode)) {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      const lines = added?.get(file);
      text.split(/\r?\n/).forEach((line, index) => {
        if (lines !== undefined && !lines.has(index + 1)) return;
        const name = declaredName(line);
        if (name === undefined) return;
        const signature = signatures.find((item) => item.pattern.test(name));
        if (signature !== undefined) breaks.push({ file, line: index + 1, message: messageOf(file, name, signature.home) });
      });
    }
    return breaks;
  },
};
