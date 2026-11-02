/**
 * The rule `gate-trigger`: a workflow that runs on pull requests starts on each pull request, with no path filter. The
 * ruleset needs the summary check "<Name> OK" of each gate. A workflow with `on.pull_request.paths` does not start
 * on each pull request, so its check is not always there, and the ruleset cannot ask for it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";
import { WORKFLOW, blockEnd, childIndent, childKeys, indentOf, keyValue, valueOf, workflowLines } from "../workflow.ts";

const TRIGGERS = ["pull_request", "pull_request_target"] as const;
const FILTERS = ["paths", "paths-ignore"] as const;

/** A path filter of a pull request trigger: the line (from 1), the trigger and the key. */
export interface PathFilter {
  readonly line: number;
  readonly trigger: string;
  readonly key: string;
}

/** This function gives the path filters of the pull request triggers of a workflow. */
export function prPathFilters(text: string): PathFilter[] {
  const lines = workflowLines(text);
  const on = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "on") !== undefined);
  if (on < 0) return [];
  // `on: pull_request` and `on: [push, pull_request]` have no filter
  if ((keyValue(lines[on] ?? "", "on") ?? "") !== "") return [];
  const found: PathFilter[] = [];
  for (const at of childKeys(lines, on)) {
    for (const trigger of TRIGGERS) {
      const value = keyValue(lines[at] ?? "", trigger);
      if (value === undefined) continue;
      // The flow form: `pull_request: { paths: [...] }`
      for (const key of FILTERS) if (new RegExp(`(^|[{,\\s])${key}\\s*:`).test(value)) found.push({ line: at + 1, trigger, key });
      for (const child of childKeys(lines, at)) for (const key of FILTERS) if (keyValue(lines[child] ?? "", key) !== undefined) found.push({ line: child + 1, trigger, key });
    }
  }
  return found;
}

/** The commit of the template with the actions `changes` and `gate-summary`. Renovate updates the pins after the fix. */
export const ACTIONS_COMMIT: string = "f05c6eeb35e33a040bdfdcd7d07a1d2c00640f8d";

/** A change of the lines: at the index `at`, remove `remove` lines and put `insert` in their place. */
interface Splice {
  readonly at: number;
  readonly remove: number;
  readonly insert: readonly string[];
}

/** This function gives the items of a list value: the flow form `[a, "b"]`, or the block form under the line `index`. */
function listItems(lines: readonly string[], index: number, value: string): { items: string[]; end: number } | undefined {
  if (value.startsWith("[") && value.endsWith("]")) {
    const items = value.slice(1, -1).split(",").map((item) => valueOf(item)).filter((item) => item !== "");
    return { items, end: index + 1 };
  }
  if (value !== "") return undefined;
  const indent = indentOf(lines[index] ?? "");
  const items: string[] = [];
  let end = index + 1;
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const deeper = indentOf(line) > indent || (indentOf(line) === indent && line.trimStart().startsWith("- "));
    if (!deeper) break;
    if (!line.trimStart().startsWith("- ")) return undefined;
    items.push(valueOf(line.trimStart().slice(2)));
    end = i + 1;
  }
  return { items, end };
}

/** This function gives the name of the summary check of a workflow: its name with "OK", in the form that ruleset-ci-ok.ts reads. */
export function summaryName(workflowName: string): string {
  const words = workflowName.replace(/[^A-Za-z0-9]+/g, " ").trim();
  const name = words === "" ? "Gate" : words.charAt(0).toUpperCase() + words.slice(1);
  return `${name} OK`;
}

/** This function puts an expression into the value of an `if`, as YAML that keeps it. */
const ifValue = (expression: string): string => {
  const value = `\${{ ${expression} }}`;
  return value.includes(": ") || value.includes(" #") ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : value;
};

/**
 * This function converts a gate workflow with a path filter on its pull request trigger. The trigger loses the filter,
 * and a job `changes` gets the same patterns. Each other job needs it and runs only on a match. A summary job
 * `<Name> OK` with the action gate-summary needs each job. The function gives the new text, or the reason why a
 * person must convert the workflow.
 */
export function convertGate(text: string, file: string, commit: string = ACTIONS_COMMIT): { text: string } | { reason: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const original = text.split(/\r?\n/);
  const lines = workflowLines(text);
  const top = (key: string): number => lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, key) !== undefined);
  const on = top("on");
  const jobsAt = top("jobs");
  if (on < 0 || jobsAt < 0) return { reason: "the workflow has no on block or no jobs block" };
  const splices: Splice[] = [];
  const filters: Record<string, string[]> = {};
  for (const at of childKeys(lines, on)) {
    const trigger = TRIGGERS.find((name) => keyValue(lines[at] ?? "", name) !== undefined);
    if (trigger === undefined) continue;
    if ((keyValue(lines[at] ?? "", trigger) ?? "") !== "") return { reason: `on.${trigger} has the flow form` };
    let filtered = false;
    for (const child of childKeys(lines, at)) {
      const key = FILTERS.find((name) => keyValue(lines[child] ?? "", name) !== undefined);
      if (key === undefined) continue;
      const list = listItems(lines, child, keyValue(lines[child] ?? "", key) ?? "");
      if (list === undefined) return { reason: `on.${trigger}.${key} is not a list` };
      const before = filters[key];
      if (before !== undefined && before.join("\n") !== list.items.join("\n")) return { reason: `the triggers have different ${key}` };
      filters[key] = list.items;
      splices.push({ at: child, remove: list.end - child, insert: [] });
      filtered = true;
    }
    if (filtered) {
      const pad = " ".repeat(indentOf(lines[at] ?? ""));
      splices.push({ at, remove: 0, insert: [`${pad}# Each pull request starts this workflow, so its summary check is always there. The job changes skips the`, `${pad}# work when the pull request changes no file of the gate (CI.md of the template, "A gate with paths").`] });
    }
  }
  if (Object.keys(filters).length === 0) return { reason: "the workflow has no path filter on a pull request trigger" };

  const jobs = childKeys(lines, jobsAt);
  const first = jobs[0];
  if (first === undefined) return { reason: "the workflow has no job" };
  const ids = jobs.map((at) => (lines[at] ?? "").trim().replace(/:$/, ""));
  const jobIndent = " ".repeat(indentOf(lines[first] ?? ""));
  const unit = " ".repeat((childIndent(lines, first) ?? indentOf(lines[first] ?? "") + 2) - jobIndent.length);
  const nameAt = top("name");
  const name = summaryName(nameAt >= 0 ? (keyValue(lines[nameAt] ?? "", "name") ?? "") : (file.split("/").pop() ?? "").replace(/\.ya?ml$/, ""));
  const summaryId = name.toLowerCase().replaceAll(" ", "-");
  for (const id of ["changes", summaryId]) if (ids.includes(id)) return { reason: `the workflow already has a job ${id}` };

  const needsOf = new Map<string, string[]>();
  const own = new Set<string>();
  for (const [index, at] of jobs.entries()) {
    const id = ids[index] ?? "";
    const keys = childKeys(lines, at);
    const pad = " ".repeat(childIndent(lines, at) ?? indentOf(lines[at] ?? "") + unit.length);
    const needsAt = keys.find((key) => keyValue(lines[key] ?? "", "needs") !== undefined);
    const ifAt = keys.find((key) => keyValue(lines[key] ?? "", "if") !== undefined);
    if (needsAt === undefined) {
      needsOf.set(id, []);
      splices.push({ at: at + 1, remove: 0, insert: [`${pad}needs: changes`] });
    } else {
      const value = keyValue(lines[needsAt] ?? "", "needs") ?? "";
      const list = value === "" || value.startsWith("[") ? listItems(lines, needsAt, value) : { items: [value], end: needsAt + 1 };
      if (list === undefined) return { reason: `the needs of the job ${id} is not a list` };
      needsOf.set(id, list.items);
      if (value === "") {
        const item = lines.findIndex((line, i) => i > needsAt && line.trim() !== "");
        splices.push({ at: item, remove: 0, insert: [`${" ".repeat(indentOf(lines[item] ?? ""))}- changes`] });
      } else {
        splices.push({ at: needsAt, remove: 1, insert: [`${pad}needs: [${["changes", ...list.items].join(", ")}]`] });
      }
    }
    if (ifAt === undefined) {
      splices.push({ at: at + 1, remove: 0, insert: [`${pad}if: needs.changes.outputs.match == 'true'`] });
    } else {
      let old = keyValue(lines[ifAt] ?? "", "if") ?? "";
      if (/^[>|]/.test(old)) return { reason: `the if of the job ${id} has more than one line` };
      const whole = /^\$\{\{(.*)\}\}$/.exec(old);
      if (whole !== null) old = (whole[1] ?? "").trim();
      if (old.includes("${{")) return { reason: `the if of the job ${id} has a part in \${{ }}` };
      own.add(id);
      splices.push({ at: ifAt, remove: 1, insert: [`${pad}if: ${ifValue(`needs.changes.outputs.match == 'true' && (${old})`)}`] });
    }
  }
  // A job with its own if can be skipped when the gate runs, and so can each job that needs such a job
  const skippable = new Set(own);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, needs] of needsOf) {
      if (skippable.has(id) || !needs.some((need) => skippable.has(need))) continue;
      skippable.add(id);
      grew = true;
    }
  }

  const action = (step: string): string => `mark1russell7/template/.github/actions/${step}@${commit} # main`;
  const block = (indent: string, key: string, items: readonly string[]): string[] => [`${indent}${key}: |`, ...items.map((item) => `${indent}${unit}${item}`)];
  const job = jobIndent + unit;
  const step = job + unit;
  const grouped = top("concurrency") >= 0;
  const group = (id: string): string[] => (grouped ? [] : [`${job}concurrency:`, `${job}${unit}group: \${{ github.workflow }}-${id}-\${{ github.ref }}`, `${job}${unit}cancel-in-progress: true`]);
  const changes = [
    `${jobIndent}changes:`,
    `${job}runs-on: ubuntu-latest`,
    `${job}timeout-minutes: 5`,
    ...group("changes"),
    `${job}permissions:`,
    `${job}${unit}contents: read`,
    `${job}${unit}pull-requests: read`,
    `${job}outputs:`,
    `${job}${unit}match: \${{ steps.changes.outputs.match }}`,
    `${job}steps:`,
    `${step}- id: changes`,
    `${step}  uses: ${action("changes")}`,
    `${step}  with:`,
    ...block(`${step}  ${unit}`, "paths", filters["paths"] ?? ["**"]),
    ...(filters["paths-ignore"] === undefined ? [] : block(`${step}  ${unit}`, "paths-ignore", filters["paths-ignore"])),
    "",
  ];
  const allow = ids.filter((id) => skippable.has(id));
  const summary = [
    "",
    `${jobIndent}${summaryId}:`,
    `${job}name: ${name}`,
    `${job}if: always()`,
    `${job}needs: [${["changes", ...ids].join(", ")}]`,
    `${job}runs-on: ubuntu-latest`,
    `${job}timeout-minutes: 2`,
    ...group(summaryId),
    `${job}permissions: {}`,
    `${job}steps:`,
    `${step}- uses: ${action("gate-summary")}`,
    `${step}  with:`,
    `${step}  ${unit}needs: \${{ toJSON(needs) }}`,
    ...(allow.length === 0 ? [] : [`${step}  ${unit}allow-skip: ${allow.join(" ")}`]),
  ];
  let last = blockEnd(lines, jobsAt);
  while (last > jobsAt + 1 && (lines[last - 1] ?? "").trim() === "") last -= 1;
  splices.push({ at: first, remove: 0, insert: changes }, { at: last, remove: 0, insert: summary });

  // From the end to the start, so each index stays correct. At one index, a splice that removes lines goes first, so it
  // removes only the old lines. Then the inserts go in, the later one first, so they keep their order.
  const out = [...original];
  for (const item of splices.map((value, order) => ({ ...value, order })).sort((a, b) => b.at - a.at || b.remove - a.remove || b.order - a.order)) out.splice(item.at, item.remove, ...item.insert);
  return { text: out.join(eol) };
}

export const gateTrigger: Rule = {
  id: "gate-trigger",
  title: "A workflow that runs on pull requests starts on each pull request: it has no on.pull_request.paths or paths-ignore.",
  reason:
    'The ruleset requires the summary check "<Name> OK" of each gate. A workflow with a path filter does not start on a pull request that changes no file of the filter, so its check is not there, and the ruleset cannot require it. Then a pull request can merge before such a gate ends. On 2026-11-02, 19 such workflows in 11 repositories fed no required check.',
  fix: 'Remove the paths from on.pull_request. Add a job "changes" with the action mark1russell7/template/.github/actions/changes and the same paths, and "if: needs.changes.outputs.match == \'true\'" on each gate job. Add a job "<Name> OK" with "if: always()", "needs" with each job, and the action gate-summary (CI.md, "A gate with paths"). Then start ruleset-ci-ok.ts again. A workflow that is not a gate can go in the option allow.',
  sources: [{ repo: "fleet", rule: "gate-trigger", doc: "docs/STRATEGY.md (2026-11-02, a gate with paths feeds a required summary)" }],
  options: {
    allow: { type: "strings", default: [], description: "The file names of the workflows that can filter pull requests by path, because they are not a gate (for example a preview)." },
  },
  check(context, options) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const workflows = files.filter((path) => WORKFLOW.test(path)).sort(byCode);
    if (workflows.length === 0) return { skipped: "the repository has no workflow" };
    const allow = Array.isArray(options["allow"]) ? (options["allow"] as readonly string[]) : [];
    const breaks: Break[] = [];
    for (const file of workflows) {
      if (allow.includes(file.slice(file.lastIndexOf("/") + 1))) continue;
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      const filters = prPathFilters(text);
      const first = filters[0];
      if (first === undefined) continue;
      const keys = filters.map((filter) => `on.${filter.trigger}.${filter.key}`).join(" and ");
      const converted = convertGate(text, file);
      breaks.push({
        file,
        line: first.line,
        message: `${file}: ${keys}, so the workflow does not start on each pull request, and the ruleset cannot ask for its summary check.`,
        ...("text" in converted ? { edits: [{ file, before: text, after: converted.text }] } : { fix: `A person must convert it, because ${converted.reason}. ${gateTrigger.fix}` }),
      });
    }
    return breaks;
  },
};
