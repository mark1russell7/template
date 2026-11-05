/**
 * The rule `gate-after-cancel`: a summary job of a gate does not start after a cancel. A job with `if: always()` still
 * asks for a runner when its run is cancelled, and the new run of the pull request waits behind it. With `!cancelled()`, the
 * job concludes `cancelled` with no runner, and it still starts after a failure, a skip and a time limit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";
import { WORKFLOW, childKeys, indentOf, keyValue, workflowLines } from "../workflow.ts";

/** The condition of a summary job. */
export const NOT_CANCELLED = "${{ !cancelled() }}";

const ALWAYS_ONLY = /^(\$\{\{\s*)?always\(\)(\s*\}\})?$/;

/** A job with `always()` in its condition: the line of the key (from 0), and `only` when the condition is `always()` and nothing else. */
export interface AlwaysGate {
  readonly line: number;
  readonly only: boolean;
}

/** This function tells if a job is a summary job: its name ends with ` OK`, or a step uses the action `gate-summary`. */
function isSummary(lines: readonly string[], job: number): boolean {
  const end = lines.findIndex((line, at) => at > job && line.trim() !== "" && indentOf(line) <= indentOf(lines[job] ?? ""));
  const body = lines.slice(job + 1, end < 0 ? lines.length : end);
  const keys = childKeys(lines, job);
  const name = keys.map((at) => keyValue(lines[at] ?? "", "name")).find((value) => value !== undefined);
  return name?.endsWith(" OK") === true || body.some((line) => (keyValue(line, "uses") ?? "").includes("/actions/gate-summary@"));
}

/** This function gives the summary jobs of a workflow with `always()` in the condition of the job. It does not read the condition of a step. */
export function alwaysGates(text: string): AlwaysGate[] {
  const lines = workflowLines(text);
  const jobs = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "jobs") !== undefined);
  if (jobs < 0) return [];
  const found: AlwaysGate[] = [];
  for (const job of childKeys(lines, jobs)) {
    if (!isSummary(lines, job)) continue;
    for (const at of childKeys(lines, job)) {
      const condition = keyValue(lines[at] ?? "", "if");
      if (condition === undefined || !condition.includes("always()")) continue;
      found.push({ line: at, only: ALWAYS_ONLY.test(condition) });
    }
  }
  return found;
}

/** This function gives the text with `!cancelled()` as the condition of each summary job that has only `always()`. It keeps the line endings and each other line. */
export function withNotCancelled(text: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  for (const gate of alwaysGates(text)) {
    if (gate.only) lines[gate.line] = `${" ".repeat(indentOf(lines[gate.line] ?? ""))}if: ${NOT_CANCELLED}`;
  }
  return lines.join(eol);
}

export const gateAfterCancel: Rule = {
  id: "gate-after-cancel",
  title: "A summary job of a gate does not start after a cancel: its condition is `!cancelled()`, not `always()`.",
  reason:
    "A job with `if: always()` asks for a runner after a cancel, and the new run waits behind it. On 2026-11-05 a new run waited 22.6 of 23.4 minutes for such jobs of the run that it replaced. A test of each case showed that `!cancelled()` holds the gate: after a cancel the job concludes `cancelled` with no runner, and the pull request stays blocked. After a failure, a skip and a time limit the job starts and fails or passes as before.",
  fix: "Write `if: ${{ !cancelled() }}` in the summary job. Do not add other parts to this condition: a job that an `if` skips counts as a pass for a required check.",
  sources: [
    { repo: "highways", rule: "ci", doc: "runs 41971833871 and 41978983438 (2026-11-05): the new run waited behind the summary jobs of the cancelled run" },
    { repo: "template", rule: "gate", doc: "pull request 189 (2026-11-05): the test of a cancel in the queue, a cancel in a job, a time limit, a failed need and a skipped need" },
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
      const gates = alwaysGates(text);
      const after = withNotCancelled(text);
      for (const gate of gates) {
        breaks.push({
          file,
          line: gate.line + 1,
          message: `A summary job of ${file} has \`always()\` in its condition. After a cancel it asks for a runner, and the new run waits behind it.`,
          ...(gate.only ? { edits: [{ file, before: text, after }] } : { fix: `A person must change it, because the condition has other parts. ${gateAfterCancel.fix}` }),
        });
      }
    }
    return breaks;
  },
};
