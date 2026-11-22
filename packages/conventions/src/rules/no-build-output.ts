/**
 * The rule `no-build-output`: git does not keep build output.
 */
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";

/** The folders of build output. */
const FOLDERS = ["dist", "build"];

/**
 * The folders of reports. A test run with coverage writes `coverage` next to the `package.json` of
 * the run. A source folder with the same name in another place, for example a shared action, is not a report.
 */
const REPORTS = ["coverage"];

export const noBuildOutput: Rule = {
  id: "no-build-output",
  title: "Git keeps no build output: no tracked file is in a folder named `dist` or `build`, or in a `coverage` folder next to a `package.json`.",
  reason:
    "The release workflow builds each package from the source, and CI makes the coverage reports. Such files in git go stale, make noise in each diff, and a user can get old code from a git install.",
  fix: "Remove the folder from git with `git rm -r --cached <folder>`, and keep its name in `.gitignore`.",
  sources: [
    { repo: "client", rule: "no-build-output", doc: "CLAUDE.md:48" },
    { repo: "client", rule: "no-dist", doc: "CLAUDE.md:48" },
    { repo: "client", rule: "no-dist-commit", doc: "CLAUDE.md:48" },
  ],
  options: {
    folders: { type: "strings", default: FOLDERS, description: "The names of the folders of build output." },
    reports: { type: "strings", default: REPORTS, description: "The names of the folders of reports. Such a folder breaks the rule only next to a `package.json`." },
  },
  check(context, options) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const names = new Set(Array.isArray(options["folders"]) ? options["folders"] : FOLDERS);
    const reports = new Set(Array.isArray(options["reports"]) ? options["reports"] : REPORTS);
    const tracked = new Set(files);
    const counts = new Map<string, number>();
    for (const file of files) {
      const segments = file.split("/");
      const index = segments
        .slice(0, -1)
        .findIndex((segment, at) => names.has(segment) || (reports.has(segment) && tracked.has([...segments.slice(0, at), "package.json"].join("/"))));
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
