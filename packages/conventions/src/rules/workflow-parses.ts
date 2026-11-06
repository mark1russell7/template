/**
 * The rule `workflow-parses`: each workflow file and each action file of `.github` parses as YAML.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";

/** A file that GitHub reads as YAML: a workflow, or the file `action.yml` of an action of the repository. */
export const GITHUB_YAML: RegExp = /^\.github\/(?:workflows\/[^/]+|actions\/(?:[^/]+\/)*action)\.ya?ml$/;

/** A fault of the YAML of a file: its line and column (from 1), and the first line of the message of the parser. */
export interface YamlFault {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/** This function gives the faults of a YAML text. A text with no fault gives an empty list. */
export function yamlFaults(text: string): YamlFault[] {
  const faults: YamlFault[] = [];
  for (const document of parseAllDocuments(text, { prettyErrors: true })) {
    for (const error of document.errors) {
      const at = error.linePos?.[0];
      // The pretty message repeats the lines of the file after its first line
      faults.push({ line: at?.line ?? 1, column: at?.col ?? 1, message: (error.message.split("\n")[0] ?? error.code).replace(/:$/, "") });
    }
  }
  return faults;
}

export const workflowParses: Rule = {
  id: "workflow-parses",
  title: "Each workflow file and each file `action.yml` of `.github` parses as YAML.",
  reason:
    "GitHub refuses a workflow that does not parse, and starts no job. A workflow that starts only on a schedule, a dispatch or `workflow_run` does not start on its pull request, so no check finds the fault before the merge. On 2026-11-06 a line at column 1 ended a block `run: |`, and main went red.",
  fix: "Correct the YAML at the line of the break. A line of a block scalar (`run: |`) has the indent of the block, also a line of a string with quotes: write `\\n` in place of a real line break.",
  sources: [
    { repo: "layout-contract", rule: "memory-probe", doc: "run 42172612147 (2026-11-06): GitHub refused memory-probe.yml, and the run had no jobs" },
    { repo: "highways", rule: "predicate-dump", doc: "predicate-dump.yml starts only on a schedule and a dispatch, and the monthly census of algebra reads its dumps" },
    { repo: "algebra", rule: "study-monthly", doc: "study-monthly.yml starts only on a schedule and a dispatch, and refreshes the data of the site" },
  ],
  options: {},
  check(context) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const breaks: Break[] = [];
    for (const file of files.filter((path) => GITHUB_YAML.test(path)).sort(byCode)) {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      // A fault often causes more faults after it, so the break names the first fault of the file and counts the others
      const [first, ...more] = yamlFaults(text);
      if (first === undefined) continue;
      const others = more.length === 0 ? "" : ` The parser finds ${more.length} more ${more.length === 1 ? "fault" : "faults"} after it.`;
      breaks.push({ file, line: first.line, message: `${file} does not parse as YAML, so GitHub starts no job of it: ${first.message}.${others}` });
    }
    return breaks;
  },
};
