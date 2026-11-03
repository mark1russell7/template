/**
 * The rule `no-stray-lockfiles`: a repository that uses pnpm keeps no lock file of npm or Yarn.
 */
import { hasFile, type Break, type Rule, type RuleContext } from "../rule.ts";

/** The names of the lock files that pnpm does not read. */
const STRAY_NAMES: ReadonlySet<string> = new Set(["package-lock.json", "yarn.lock"]);

/** This function tells if the repository uses pnpm: it has a `pnpm-lock.yaml` at its root, or a `packageManager` that starts with `pnpm`. */
function usesPnpm(context: RuleContext): boolean {
  const manager = context.rootPackage.manifest["packageManager"];
  return hasFile(context.root, "pnpm-lock.yaml") || (typeof manager === "string" && manager.startsWith("pnpm"));
}

export const noStrayLockfiles: Rule = {
  id: "no-stray-lockfiles",
  title: "A repository that uses pnpm has no `package-lock.json` and no `yarn.lock` outside `node_modules`.",
  reason: "pnpm does not read these files, so a stray file does not agree with the dependencies, and a review does not see it. A stray `package-lock.json` went through a review in a pnpm repository.",
  fix: "Remove the file from git with `git rm <file>`.",
  sources: ["vex", "coeval", "client", "crawler"].map((repo) => ({ repo, rule: "no-stray-lockfiles", doc: "pnpm-lock.yaml (the only lock file of the repository)" })),
  options: {},
  check(context) {
    if (!usesPnpm(context)) return [];
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const breaks: Break[] = [];
    for (const file of files) {
      const segments = file.split("/");
      if (segments.includes("node_modules") || !STRAY_NAMES.has(segments.at(-1) ?? "")) continue;
      breaks.push({ file, message: `Git keeps the lock file ${file} in a repository that uses pnpm.`, fix: `Remove ${file}: this repository uses pnpm` });
    }
    return breaks;
  },
};
