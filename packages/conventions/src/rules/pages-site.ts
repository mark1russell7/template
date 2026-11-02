/**
 * The rule `pages-site`: a public repository has a site. A workflow uses the Pages workflow of the template, and the
 * call deploys.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import type { Rule } from "../rule.ts";
import { WORKFLOW, blockEnd, indentOf, keyValue, workflowLines } from "../workflow.ts";
import { repositoryIsPublic } from "./license-file.ts";

/** The Pages workflow of the template, as a call from another repository and as a call from the template itself. */
export const PAGES_WORKFLOWS: readonly string[] = ["mark1russell7/template/.github/workflows/reusable-pages.yml", "./.github/workflows/reusable-pages.yml"];

/** A call of the Pages workflow: its line (from 1), and false when its job sets `deploy: false`. */
export interface PagesCall {
  readonly line: number;
  readonly deploys: boolean;
}

/** This function gives each call of a workflow of `workflows` in the text of a workflow file. The ref after `@` can be any ref. */
export function pagesCalls(text: string, workflows: readonly string[] = PAGES_WORKFLOWS): PagesCall[] {
  const lines = workflowLines(text);
  const names = new Set(workflows.map((name) => name.toLowerCase()));
  const calls: PagesCall[] = [];
  lines.forEach((line, index) => {
    const uses = keyValue(line, "uses");
    if (uses === undefined || !names.has((uses.split("@")[0] ?? "").toLowerCase())) return;
    // The job of the call is the nearest line above it with a smaller indent
    let job = index - 1;
    while (job >= 0 && ((lines[job] ?? "").trim() === "" || indentOf(lines[job] ?? "") >= indentOf(line))) job -= 1;
    const body = job < 0 ? [line] : lines.slice(job, blockEnd(lines, job));
    calls.push({ line: index + 1, deploys: !body.some((text) => keyValue(text, "deploy") === "false") });
  });
  return calls;
}

export const pagesSite: Rule = {
  id: "pages-site",
  title: "A public repository has a workflow that calls the Pages workflow of the template (`reusable-pages.yml`, any ref), and the call deploys.",
  reason:
    "Each public project has a site with its Releases page and its Status page, so a reader sees the versions and the open work. On 2026-11-02 eight public repositories had no site: typeset, algebra, headroom, release-train, optional, ste-lint, lag-hud and template.",
  fix: 'Add `.github/workflows/pages.yml` with a job `uses: mark1russell7/template/.github/workflows/reusable-pages.yml@<commit> # main` and the permissions of CI.md ("Pages"). Give `build`, `out` and `roadmap: docs/ROADMAP.md`. After the build, the job starts `site-pages build`, which adds the Releases page and the Status page. Then set the Pages source to "GitHub Actions": `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow`.',
  sources: ["vex", "crawler", "client", "coeval"].map((repo) => ({ repo, rule: "pages-site", doc: ".github/workflows/pages.yml (a call of reusable-pages.yml of the template)" })),
  options: {
    workflows: { type: "strings", default: PAGES_WORKFLOWS, description: "The workflows that deploy a site, without the ref after `@`." },
  },
  check(context, options) {
    const visible = repositoryIsPublic(context);
    if (visible === undefined) return { skipped: "outside a GitHub Actions run, the rule cannot tell if the repository is public" };
    if (!visible) return [];
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const calls = files
      .filter((path) => WORKFLOW.test(path))
      .sort(byCode)
      .flatMap((file) => pagesCalls(readFileSync(join(context.root, file), "utf8"), options["workflows"] as readonly string[]).map((call) => ({ file, ...call })));
    if (calls.some((call) => call.deploys)) return [];
    // A call with `deploy: false` builds a test site only, for example in actions-test.yml of the template
    const tests = calls.length === 0 ? "" : ` The calls in ${[...new Set(calls.map((call) => call.file))].join(", ")} have deploy: false.`;
    return [{ file: ".github/workflows/pages.yml", message: `The repository is public, and no workflow deploys its site with the Pages workflow of the template.${tests}` }];
  },
};
