/**
 * The rule `summary-job`: each gate workflow of a repository (by default `ci.yml` and `security.yml`) has one summary job
 * `<Name> OK`. The ruleset of `main` names only the summary checks (CI.md, "The check of the ruleset"). Without a summary
 * job, the ruleset must name each job of the gate. Then it does not wait for a new job.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";
import { WORKFLOW, applySplices, blockEnd, childIndent, childKeys, indentOf, keyValue, workflowLines, type Splice } from "../workflow.ts";
import { isSummary } from "./gate-after-cancel.ts";
import { ACTIONS_COMMIT, listItems, skippableJobs, summaryJob, summaryName } from "./gate-trigger.ts";

/** The gate workflows of the template: each one gives one summary check that the ruleset names. */
export const SUMMARY_GATES: readonly string[] = ["ci.yml", "security.yml"];

/** The deprecated shared workflow of the scans. The rule `security-one-job` replaces its caller and the summary job with one job. */
const REUSABLE_SECURITY = /(^|\/)\.github\/workflows\/reusable-security\.ya?ml(@|$)/;

const PULL_REQUEST = /^(pull_request|pull_request_target)$/;

/** This function tells if a workflow starts on a pull request: `on: pull_request`, the flow form, or a key of the block. */
export function startsOnPullRequest(text: string): boolean {
  const lines = workflowLines(text);
  const on = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "on") !== undefined);
  if (on < 0) return false;
  const value = keyValue(lines[on] ?? "", "on") ?? "";
  if (value !== "") return value.replace(/^\[|\]$/g, "").split(",").some((item) => PULL_REQUEST.test(item.trim().replace(/^["']|["']$/g, "")));
  return childKeys(lines, on).some((at) => PULL_REQUEST.test((lines[at] ?? "").trim().replace(/:.*$/, "").replace(/^["']|["']$/g, "")));
}

/** This function tells if a workflow has a summary job: a job with a name that ends with ` OK`, or with the action gate-summary. */
export function hasSummaryJob(text: string): boolean {
  const lines = workflowLines(text);
  const jobs = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "jobs") !== undefined);
  return jobs >= 0 && childKeys(lines, jobs).some((job) => isSummary(lines, job));
}

/**
 * This function adds a summary job `<Name> OK` with the action gate-summary at the end of the jobs. It needs each job.
 * A job with its own `if`, and each job that needs one, can be skipped. The function gives the new text, or the reason
 * why a person must add the job.
 */
export function addSummaryJob(text: string, file: string, commit: string = ACTIONS_COMMIT): { text: string } | { reason: string } {
  const lines = workflowLines(text);
  const top = (key: string): number => lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, key) !== undefined);
  const jobsAt = top("jobs");
  if (jobsAt < 0) return { reason: "the workflow has no jobs block" };
  const jobs = childKeys(lines, jobsAt);
  const first = jobs[0];
  if (first === undefined) return { reason: "the workflow has no job" };
  const ids = jobs.map((at) => (lines[at] ?? "").trim().replace(/:$/, ""));
  const jobIndent = " ".repeat(indentOf(lines[first] ?? ""));
  const unit = " ".repeat((childIndent(lines, first) ?? indentOf(lines[first] ?? "") + 2) - jobIndent.length);
  const nameAt = top("name");
  const name = summaryName(nameAt >= 0 ? (keyValue(lines[nameAt] ?? "", "name") ?? "") : (file.split("/").pop() ?? "").replace(/\.ya?ml$/, ""));
  const id = name.toLowerCase().replaceAll(" ", "-");
  if (ids.includes(id)) return { reason: `the workflow already has a job ${id}` };

  const needsOf = new Map<string, string[]>();
  const own = new Set<string>();
  for (const [index, at] of jobs.entries()) {
    const job = ids[index] ?? "";
    const keys = childKeys(lines, at);
    const needsAt = keys.find((key) => keyValue(lines[key] ?? "", "needs") !== undefined);
    if (needsAt === undefined) needsOf.set(job, []);
    else {
      const value = keyValue(lines[needsAt] ?? "", "needs") ?? "";
      const list = value === "" || value.startsWith("[") ? listItems(lines, needsAt, value) : { items: [value], end: needsAt + 1 };
      if (list === undefined) return { reason: `the needs of the job ${job} is not a list` };
      needsOf.set(job, list.items);
    }
    if (keys.some((key) => keyValue(lines[key] ?? "", "if") !== undefined)) own.add(job);
  }
  const skippable = skippableJobs(needsOf, own);
  const summary = summaryJob({ jobIndent, unit, id, name, needs: ids, allow: ids.filter((job) => skippable.has(job)), grouped: top("concurrency") >= 0, commit });
  let last = blockEnd(lines, jobsAt);
  while (last > jobsAt + 1 && (lines[last - 1] ?? "").trim() === "") last -= 1;
  const splices: Splice[] = [{ at: last, remove: 0, insert: summary }];
  return { text: applySplices(text, splices) };
}

export const summaryJobRule: Rule = {
  id: "summary-job",
  title: "Each gate workflow (ci.yml, security.yml) has one summary job <Name> OK that needs each of its jobs.",
  reason:
    'The ruleset of main requires only the summary checks "CI OK" and "Security OK" (CI.md, "The check of the ruleset"). A gate with no summary job forces the ruleset to name each job: a new job is then not required, gh pr merge --auto merges before it ends, and a rename of a job blocks each pull request. On 2026-11-09, 21 of 43 public repositories of the account had a gate with no summary job.',
  fix: 'Add a job "<Name> OK" with "if: ${{ !cancelled() }}", "needs" with each job, and the action gate-summary (CI.md, "The check of the ruleset"). Then start ruleset-ci-ok.ts with --only-summary.',
  sources: [{ repo: "private", rule: "summary-job", doc: "docs/STRATEGY.md (2026-11-09, the audit of the summary checks of 43 public repositories)" }],
  options: {
    gates: { type: "strings", default: [...SUMMARY_GATES], description: "The file names of the gate workflows that must have a summary job." },
  },
  check(context, options) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const gates = Array.isArray(options["gates"]) ? (options["gates"] as readonly string[]) : SUMMARY_GATES;
    const workflows = files.filter((path) => WORKFLOW.test(path) && gates.includes(path.slice(path.lastIndexOf("/") + 1))).sort(byCode);
    if (workflows.length === 0) return { skipped: "the repository has no gate workflow" };
    const breaks: Break[] = [];
    for (const file of workflows) {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      // A workflow that does not start on a pull request gives no check to require; the rule security-one-job fixes the deprecated scans
      if (!startsOnPullRequest(text) || hasSummaryJob(text) || REUSABLE_SECURITY.test(text)) continue;
      const added = addSummaryJob(text, file);
      breaks.push({
        file,
        message: `${file} has no summary job "<Name> OK", so the ruleset must name each of its jobs.`,
        ...("text" in added ? { edits: [{ file, before: text, after: added.text }] } : { fix: `A person must add it, because ${added.reason}. ${summaryJobRule.fix}` }),
      });
    }
    return breaks;
  },
};
