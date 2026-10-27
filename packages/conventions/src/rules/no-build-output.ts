/**
 * The rule `no-build-output`: git does not keep build output.
 */
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";

export const noBuildOutput: Rule = {
  id: "no-build-output",
  title: "Git keeps no build output: no tracked file is in a folder named `dist` or `build`.",
  reason:
    "The release workflow builds each package from the source. Build output in git goes stale, makes noise in each diff, and a user can get old code from a git install.",
  fix: "Remove the folder from git with `git rm -r --cached <folder>`, and keep its name in `.gitignore`.",
  sources: [
    { repo: "client", rule: "no-build-output", doc: "CLAUDE.md:48" },
    { repo: "client", rule: "no-dist", doc: "CLAUDE.md:48" },
    { repo: "client", rule: "no-dist-commit", doc: "CLAUDE.md:48" },
  ],
  options: {
    folders: { type: "strings", default: ["dist", "build"], description: "The names of the folders of build output." },
  },
  check(context, options) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const names = new Set(Array.isArray(options["folders"]) ? options["folders"] : ["dist", "build"]);
    const counts = new Map<string, number>();
    for (const file of files) {
      const segments = file.split("/");
      const index = segments.slice(0, -1).findIndex((segment) => names.has(segment));
      if (index < 0) continue;
      const folder = segments.slice(0, index + 1).join("/");
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
    return [...counts.keys()].sort(byCode).map(
      (folder): Break => ({
        file: `${folder}/`,
        message: `Git keeps ${counts.get(folder) ?? 0} file(s) in ${folder}/.`,
        fix: `Start \`git rm -r --cached ${folder}\`, and keep ${folder.split("/").pop() ?? folder}/ in .gitignore.`,
      }),
    );
  },
};
