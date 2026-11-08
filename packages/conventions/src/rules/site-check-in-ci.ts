/**
 * The rule `site-check-in-ci`: a repository that deploys a site with the Pages workflow checks the same site on each
 * pull request. The check `CI OK` needs the job of this check. The site values are in `.github/site.json`, and the deploy
 * starts on no pull request, directly or through a call.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_CONFIG_KEYS, SITE_CONFIG_PATH } from "@mark1russell7/site-pages/config";
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";
import { WORKFLOW, childKeys, indentOf, keyValue, readWorkflow, valueOf, workflowLines } from "../workflow.ts";
import { PAGES_WORKFLOWS, pagesCalls } from "./pages-site.ts";

/** The check workflow of the template, as a call from another repository and as a call from the template itself. */
export const CHECK_WORKFLOWS: readonly string[] = ["mark1russell7/template/.github/workflows/reusable-pages-check.yml", "./.github/workflows/reusable-pages-check.yml"];

/** The events of a pull request. A job of such an event must not get a write permission. */
const PULL_REQUEST: ReadonlySet<string> = new Set(["pull_request", "pull_request_target"]);

/** This function gives the key of a line with no quotes. A list item (`- push`) gives its value. */
function keyOf(line: string): string {
  let text = line.trimStart();
  if (text.startsWith("- ")) text = text.slice(2).trimStart();
  const colon = text.indexOf(":");
  return valueOf(colon < 0 ? text : text.slice(0, colon));
}

/** This function gives the events of the key `on` of a workflow: a block of keys, a block list, an inline list or one value. */
export function triggersOf(text: string): string[] {
  const lines = workflowLines(text);
  const on = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "on") !== undefined);
  if (on < 0) return [];
  const value = keyValue(lines[on] ?? "", "on") ?? "";
  if (value.startsWith("[")) return value.slice(1, -1).split(",").map(valueOf).filter(Boolean);
  if (value !== "") return [value];
  return childKeys(lines, on).map((index) => keyOf(lines[index] ?? ""));
}

/** This function gives the line of the job of the line `index`: the nearest line above it with a smaller indent, or -1. */
function jobAt(lines: readonly string[], index: number): number {
  let job = index - 1;
  while (job >= 0 && ((lines[job] ?? "").trim() === "" || indentOf(lines[job] ?? "") >= indentOf(lines[index] ?? ""))) job -= 1;
  return job;
}

/** This function gives the id of the job with the name `name`, or undefined. */
function jobNamed(lines: readonly string[], name: string): string | undefined {
  const jobs = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "jobs") !== undefined);
  if (jobs < 0) return undefined;
  const job = childKeys(lines, jobs).find((index) => childKeys(lines, index).some((key) => keyValue(lines[key] ?? "", "name") === name));
  return job === undefined ? undefined : keyOf(lines[job] ?? "");
}

export const siteCheckInCi: Rule = {
  id: "site-check-in-ci",
  title: "A repository that deploys a site with the Pages workflow has `.github/site.json`, gives no site value in the call, deploys on no pull request, and checks the site in a job that `CI OK` needs.",
  reason:
    "The deploy and the check of a pull request build the same site only when the values have one home. A job of a pull request with the permission `pages: write` is a risk, so the check is in its own workflow with read permissions. A check that `CI OK` does not need does not stop a merge: on 2026-11-08 the probe of a site ran only in the Pages workflow, and the required check did not wait for it.",
  fix: 'Move the inputs of the call of `reusable-pages.yml` into `.github/site.json` (CI.md, "The site config"). Remove `pull_request` from the `on` of the Pages workflow, and call it from no workflow of a pull request. Add a job `site` to `ci.yml` that uses `reusable-pages-check.yml` with `permissions: contents: read`, and add `site` to the `needs` of `CI OK`.',
  sources: [{ repo: "template", rule: "site-check-in-ci", doc: "CI.md (The site config)" }],
  options: {
    workflows: { type: "strings", default: PAGES_WORKFLOWS, description: "The workflows that deploy a site, without the ref after `@`." },
    checks: { type: "strings", default: CHECK_WORKFLOWS, description: "The workflows that check a site on a pull request, without the ref after `@`." },
    gate: { type: "string", default: "CI OK", description: "The name of the job that the ruleset requires. It needs the job of the check." },
  },
  check(context, options) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const gate = options["gate"] as string;
    const workflows = files
      .filter((path) => WORKFLOW.test(path))
      .sort(byCode)
      .map((file) => ({ file, text: readFileSync(join(context.root, file), "utf8") }));
    const deploys = workflows.flatMap(({ file, text }) =>
      pagesCalls(text, options["workflows"] as readonly string[])
        .filter((call) => call.deploys)
        .map((call) => ({ file, text, line: call.line })),
    );
    if (deploys.length === 0) return { skipped: "no workflow deploys a site with the Pages workflow" };
    const breaks: Break[] = [];
    if (!files.includes(SITE_CONFIG_PATH)) {
      breaks.push({ file: SITE_CONFIG_PATH, message: `The repository deploys a site, and it has no ${SITE_CONFIG_PATH}. The check of a pull request reads the site values there.` });
    }
    const triggersRead = new Set<string>();
    for (const { file, text, line } of deploys) {
      const lines = workflowLines(text);
      const job = jobAt(lines, line - 1);
      const withAt = job < 0 ? undefined : childKeys(lines, job).find((index) => keyValue(lines[index] ?? "", "with") !== undefined);
      for (const index of withAt === undefined ? [] : childKeys(lines, withAt)) {
        const key = keyOf(lines[index] ?? "");
        if (Object.hasOwn(SITE_CONFIG_KEYS, key)) breaks.push({ file, line: index + 1, message: `${file} gives the site value ${key} to the Pages workflow. Give it only in ${SITE_CONFIG_PATH}.` });
      }
      if (triggersRead.has(file)) continue;
      triggersRead.add(file);
      const events = triggersOf(text).filter((event) => PULL_REQUEST.has(event));
      if (events.length > 0) breaks.push({ file, message: `${file} deploys the site and starts on ${events.join(" and ")}, so a job of a pull request gets the permission pages: write.` });
      for (const caller of workflows) {
        const callerEvents = triggersOf(caller.text).filter((event) => PULL_REQUEST.has(event));
        if (callerEvents.length === 0) continue;
        workflowLines(caller.text).forEach((text, index) => {
          if ((keyValue(text, "uses") ?? "").split("@")[0] !== `./${file}`) return;
          breaks.push({ file: caller.file, line: index + 1, message: `${caller.file} starts on ${callerEvents.join(" and ")} and calls ${file}, which deploys the site. A job of a pull request gets the permission pages: write.` });
        });
      }
    }
    const checks = workflows.flatMap(({ file, text }) => pagesCalls(text, options["checks"] as readonly string[]).map((call) => ({ file, text, line: call.line })));
    if (checks.length === 0) {
      breaks.push({ file: ".github/workflows/ci.yml", message: `No job checks the site on a pull request. Add a job that uses reusable-pages-check.yml, and add it to the needs of ${gate}.` });
    }
    for (const { file, text, line } of checks) {
      const lines = workflowLines(text);
      const id = keyOf(lines[jobAt(lines, line - 1)] ?? "");
      const gateId = jobNamed(lines, gate);
      const needs = gateId === undefined ? undefined : readWorkflow(file, text).jobs.find((job) => job.id === gateId)?.needs;
      if (needs?.includes(id)) continue;
      breaks.push({
        file,
        line,
        message:
          gateId === undefined
            ? `${file} checks the site in the job ${id}, and the file has no job ${gate}, so a failed check does not stop a merge.`
            : `The job ${gate} of ${file} does not need the job ${id}, so a failed check of the site does not stop a merge.`,
      });
    }
    return breaks;
  },
};
