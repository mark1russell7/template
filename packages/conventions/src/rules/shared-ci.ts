/**
 * The rule `shared-ci`: a repository uses the shared workflows and actions of the template, and keeps no copy of them.
 * Its `ci.yml` uses the shared workflow `reusable-ci.yml` of the template. No workflow file and no action of the
 * repository has the name of a shared workflow or a shared action. The template itself is the home, so the rule does
 * not examine it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";
import { WORKFLOW, readWorkflow } from "../workflow.ts";

/** The shared workflows of the template, by file name. */
export const SHARED_WORKFLOWS: readonly string[] = [
  "reusable-ai-review.yml",
  "reusable-ci.yml",
  "reusable-codex-review.yml",
  "reusable-mutation.yml",
  "reusable-pages-check.yml",
  "reusable-pages.yml",
  "reusable-release-build.yml",
  "reusable-release-tag.yml",
  "reusable-security.yml",
];

/** The shared actions of the template, by folder name under `.github/actions`. */
export const SHARED_ACTIONS: readonly string[] = ["build-ref", "changes", "changeset-check", "coverage", "data-stamps", "gate-summary", "green-main", "npm-publish", "pages-build", "security-scan", "setup-cue", "setup-playwright", "site-check", "site-config", "site-pages"];

/** The `uses` value of a job that calls the shared CI, with no pin. */
export const SHARED_CI = "mark1russell7/template/.github/workflows/reusable-ci.yml";

/** The action folder of a path: `.github/actions/<name>/action.yml` gives `<name>`. */
const ACTION = /^\.github\/actions\/([^/]+)\//;

/** The file name of a path. */
const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** This function tells if a job of a workflow text uses the shared CI of the template. */
export function callsSharedCi(file: string, text: string): boolean {
  return readWorkflow(file, text).jobs.some((job) => job.steps.some((step) => step.uses === SHARED_CI));
}

export const sharedCi: Rule = {
  id: "shared-ci",
  title: "`ci.yml` calls the shared workflow `reusable-ci.yml` of the template, and no workflow or action copies a shared one.",
  reason:
    "The shared CI is the one place where each check of a repository is set: the typecheck, the tests, the conventions, the API report and the summary check CI OK that the ruleset needs. A ci.yml with its own steps, or a copy of a shared workflow or action, does not get the fixes and the new checks of the template, and it drifts with no sign. On 2026-11-07, 3 of 19 repositories of the account ran CI steps of their own, and the rule was only text in each CLAUDE.md.",
  fix: "Make ci.yml call mark1russell7/template/.github/workflows/reusable-ci.yml at a pinned commit, and give the differences as its inputs (CI.md). Remove the local copy of a shared workflow or action, and call the one of the template. A repository that cannot call the shared CI turns the rule off with its reason.",
  sources: [
    { repo: "template", rule: "shared-workflows", doc: "CLAUDE.md: the workflows use the shared workflows and actions of the template; a repository changes only the inputs of its callers" },
    { repo: "template", rule: "ci", doc: "CI.md, CI: a caller of reusable-ci.yml needs no inputs, and gives each difference as an input" },
    { repo: "highways", rule: "ci", doc: ".github/workflows/ci.yml:1: the job ci is the shared CI (reusable-ci.yml, CI.md)" },
    { repo: "packing", rule: "ci", doc: ".github/workflows/ci.yml:1: the job ci is the shared CI (reusable-ci.yml, CI.md)" },
    { repo: "ste-lint", rule: "ci", doc: ".github/workflows/ci.yml (2026-11-07): its own steps, no call of reusable-ci.yml; the same in optional and lag" },
  ],
  options: {
    home: { type: "strings", default: ["template-monorepo"], description: "The names of the root packages that own the shared workflows. The rule does not examine them." },
    ciFile: { type: "string", default: ".github/workflows/ci.yml", description: "The workflow file that must call the shared CI." },
  },
  check(context, options) {
    const home = options["home"] as readonly string[];
    const name = context.rootPackage.manifest["name"];
    if (typeof name === "string" && home.includes(name)) return { skipped: `the repository is the home of the shared workflows (${name})` };
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const breaks: Break[] = [];
    for (const file of files.filter((path) => WORKFLOW.test(path)).sort(byCode)) {
      if (SHARED_WORKFLOWS.includes(baseName(file))) breaks.push({ file, message: `${file} has the name of a shared workflow of the template: it is a local copy, which does not get the fixes of the template.` });
    }
    const actions = new Set<string>();
    for (const file of files) {
      const folder = ACTION.exec(file)?.[1];
      if (folder !== undefined && SHARED_ACTIONS.includes(folder) && !actions.has(folder)) {
        actions.add(folder);
        breaks.push({ file: `.github/actions/${folder}`, message: `.github/actions/${folder} has the name of a shared action of the template: it is a local copy, which does not get the fixes of the template.` });
      }
    }
    const ciFile = options["ciFile"] as string;
    const path = join(context.root, ciFile);
    if (!existsSync(path)) breaks.push({ file: ciFile, message: `${ciFile} is missing, so no job calls the shared CI of the template.` });
    else if (!callsSharedCi(ciFile, readFileSync(path, "utf8"))) breaks.push({ file: ciFile, message: `No job of ${ciFile} calls ${SHARED_CI}: the CI runs its own steps, and does not get the checks of the template.` });
    return breaks;
  },
};
