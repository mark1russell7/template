/**
 * The rule `security-one-job`: the security scans of a repository run in one job, with the action `security-scan` of the
 * template. The deprecated shared workflow `reusable-security.yml` gives three scan jobs, and the caller adds the summary
 * job `Security OK`. Each job asks for its own runner, so a run waits in the queue for four runners in place of one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";
import { WORKFLOW, type Splice, applySplices, blockEnd, childKeys, indentOf, keyValue, workflowLines } from "../workflow.ts";
import { listItems } from "./gate-trigger.ts";

/** The first commit of the template with the action `security-scan` (pull request 206). Renovate and the template sync move the pin after the fix. */
export const SECURITY_SCAN_COMMIT: string = "8a01259f04dce1d6a2fa351b758c6d283e9f7fc9";

/** The inputs of the action `security-scan`. The shared workflow has the same inputs and also `timeout-minutes`. */
export const SECURITY_SCAN_INPUTS: readonly string[] = ["fail-on-severity", "dependency-review", "dependency-review-scopes", "osv", "osv-lockfile", "codeql", "codeql-languages", "codeql-build-mode"];

/** The time limit of the job when the caller gives none: the default of `timeout-minutes` of the shared workflow. */
export const SECURITY_TIMEOUT_MINUTES = 30;

const REUSABLE = /(^|\/)\.github\/workflows\/reusable-security\.ya?ml(@|$)/;

/** The keys that a job of the shared workflow can have, and that the fix can replace. */
const CALLER_KEYS = new Set(["uses", "permissions", "with", "name"]);

/** A job of the shared workflow in a workflow file: the line of its key (from 0), and its id. */
export interface SecurityCaller {
  readonly line: number;
  readonly id: string;
}

/** This function gives the lines from `start` to the last line of the block that is not empty. */
function trimmedEnd(lines: readonly string[], start: number): number {
  let end = blockEnd(lines, start);
  while (end > start + 1 && (lines[end - 1] ?? "").trim() === "") end -= 1;
  return end;
}

/** This function gives the id of the job of the line `at`. */
const idOf = (line: string): string => {
  const text = line.trim();
  const colon = text.indexOf(":");
  return (colon < 0 ? text : text.slice(0, colon)).replace(/^["']|["']$/g, "");
};

/** This function gives the jobs of a workflow that use the shared workflow `reusable-security.yml`. */
export function securityCallers(text: string): SecurityCaller[] {
  const lines = workflowLines(text);
  const jobs = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "jobs") !== undefined);
  if (jobs < 0) return [];
  const found: SecurityCaller[] = [];
  for (const job of childKeys(lines, jobs)) {
    const uses = childKeys(lines, job)
      .map((at) => keyValue(lines[at] ?? "", "uses"))
      .find((value) => value !== undefined);
    if (uses !== undefined && REUSABLE.test(uses)) found.push({ line: job, id: idOf(lines[job] ?? "") });
  }
  return found;
}

/** This function gives the ids of the jobs in `needs` of the job of the line `job`. */
function needsOf(lines: readonly string[], job: number): string[] {
  for (const at of childKeys(lines, job)) {
    const value = keyValue(lines[at] ?? "", "needs");
    if (value === undefined) continue;
    if (value !== "" && !value.startsWith("[")) return [value];
    return listItems(lines, at, value)?.items ?? [];
  }
  return [];
}

/**
 * This function puts one job in place of the job of the shared workflow and its summary job. If it cannot, it gives the
 * reason that a person must change the file. The new job keeps the id of the summary job and the name `Security OK`, which the ruleset
 * needs. It gives the inputs of the caller to the action, and `timeout-minutes` to the job.
 */
export function withOneJob(text: string, commit: string = SECURITY_SCAN_COMMIT): { text: string } | { reason: string } {
  const lines = workflowLines(text);
  const callers = securityCallers(text);
  if (callers.length !== 1) return { reason: `the file has ${String(callers.length)} jobs that use reusable-security.yml, and the fix changes only one` };
  const caller = callers[0];
  if (caller === undefined) return { reason: "no job uses reusable-security.yml" };
  const jobs = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "jobs") !== undefined);
  const dependents = childKeys(lines, jobs).filter((job) => needsOf(lines, job).includes(caller.id));
  if (dependents.length !== 1) return { reason: `${String(dependents.length)} jobs need the job ${caller.id}, and the fix needs exactly one summary job` };
  const summary = dependents[0];
  if (summary === undefined) return { reason: "no summary job" };
  const summaryNeeds = needsOf(lines, summary);
  if (summaryNeeds.length !== 1) return { reason: `the summary job needs ${summaryNeeds.join(", ")}, and the fix replaces only a summary job of the scans` };
  const summaryName = childKeys(lines, summary)
    .map((at) => keyValue(lines[at] ?? "", "name"))
    .find((value) => value !== undefined);
  if (summaryName !== "Security OK") return { reason: `the summary job has the name ${summaryName ?? "(none)"}, not Security OK, which the ruleset needs` };

  const inputs: string[] = [];
  let timeout = String(SECURITY_TIMEOUT_MINUTES);
  for (const at of childKeys(lines, caller.line)) {
    const key = idOf(lines[at] ?? "");
    if (!CALLER_KEYS.has(key)) return { reason: `the job ${caller.id} has the key ${key}, and the fix cannot keep it` };
    if (key !== "with") continue;
    for (const input of childKeys(lines, at)) {
      const name = idOf(lines[input] ?? "");
      const value = keyValue(lines[input] ?? "", name) ?? "";
      if (value === "" || value.startsWith("|") || value.startsWith(">") || trimmedEnd(lines, input) > input + 1) return { reason: `the input ${name} has a value of more than one line` };
      if (name === "timeout-minutes") timeout = value;
      else if (SECURITY_SCAN_INPUTS.includes(name)) inputs.push(name);
      else return { reason: `the action security-scan has no input ${name}` };
    }
  }

  const raw = text.split(/\r?\n/);
  const pad = " ".repeat(indentOf(raw[caller.line] ?? ""));
  const withLines = childKeys(lines, caller.line).find((at) => idOf(lines[at] ?? "") === "with");
  const inputLines = withLines === undefined ? [] : childKeys(lines, withLines).filter((at) => inputs.includes(idOf(lines[at] ?? ""))).map((at) => `${pad}        ${(raw[at] ?? "").trim()}`);
  const job = [
    `${pad}${idOf(lines[summary] ?? "")}:`,
    `${pad}  name: Security OK`,
    `${pad}  runs-on: ubuntu-latest`,
    `${pad}  timeout-minutes: ${timeout}`,
    `${pad}  permissions:`,
    `${pad}    contents: read`,
    `${pad}    security-events: write`,
    `${pad}    actions: read`,
    `${pad}  steps:`,
    `${pad}    - uses: mark1russell7/template/.github/actions/security-scan@${commit} # main`,
    ...(inputLines.length > 0 ? [`${pad}      with:`, ...inputLines] : []),
  ];
  const splices: Splice[] = [{ at: caller.line, remove: trimmedEnd(lines, caller.line) - caller.line, insert: job }];
  // The summary job goes, with the empty line before it, or else with the empty line after it.
  const blank = (at: number): boolean => at >= 0 && at < raw.length - 1 && (raw[at] ?? "").trim() === "";
  const start = blank(summary - 1) ? summary - 1 : summary;
  const end = trimmedEnd(lines, summary) + (start === summary && blank(trimmedEnd(lines, summary)) ? 1 : 0);
  splices.push({ at: start, remove: end - start, insert: [] });
  return { text: applySplices(text, splices) };
}

export const securityOneJob: Rule = {
  id: "security-one-job",
  title: "The security scans run in one job: the action `security-scan`, not the shared workflow `reusable-security.yml`.",
  reason:
    "Each job of a run asks for its own runner. reusable-security.yml gives three scan jobs, and the caller adds the summary job Security OK, so each run waits in the queue for four runners, and the summary job waits again after the scans. On 2026-11-06, in a full queue, the scan jobs of systems waited 23 to 40 minutes each. The action security-scan runs the same scans with the same inputs in one job, which is the check Security OK.",
  fix: "Replace the job that uses reusable-security.yml and its summary job with one job Security OK that runs the action security-scan (CI.md, Security). Give the inputs to the action, and timeout-minutes to the job.",
  sources: [
    { repo: "template", rule: "security", doc: "pull request 206 (2026-11-05): the action security-scan, and reusable-security.yml deprecated" },
    { repo: "template", rule: "ci", doc: "CI.md, Security: the job of a caller of security-scan, and the change from the old workflow" },
    { repo: "optional", rule: "security", doc: ".github/workflows/security.yml (2026-11-06): the job security of reusable-security.yml and the summary job Security OK, the form that the fix changes" },
    { repo: "systems", rule: "ci", doc: "Security runs 42159170199 to 42172625422 (2026-11-06): three scan jobs, each waited 5.7 to 40.7 minutes for a runner" },
  ],
  options: {},
  check(context) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const breaks: Break[] = [];
    for (const file of files.filter((path) => WORKFLOW.test(path)).sort(byCode)) {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      const callers = securityCallers(text);
      if (callers.length === 0) continue;
      const after = withOneJob(text);
      for (const caller of callers) {
        breaks.push({
          file,
          line: caller.line + 1,
          message: `The job ${caller.id} of ${file} uses reusable-security.yml: its scans ask for three runners and its summary job for a fourth.`,
          ...("text" in after ? { edits: [{ file, before: text, after: after.text }] } : { fix: `A person must change it, because ${after.reason}. ${securityOneJob.fix}` }),
        });
      }
    }
    return breaks;
  },
};
