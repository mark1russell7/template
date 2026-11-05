/**
 * The rule `pipe-fails`: a failure on the left of a pipe fails its step. With no `shell` key, GitHub starts a step with
 * `bash -e {0}`, which has no `pipefail`. So `tests | tee out.txt` gives the exit code of `tee`, and the step passes when the tests fail.
 * The key `shell: bash` starts it with `bash --noprofile --norc -eo pipefail {0}`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";
import { WORKFLOW, childKeys, indentOf, keyValue, workflowLines } from "../workflow.ts";

/** This function gives the words that end the here-documents of a line of a script. */
function hereWords(line: string): string[] {
  return [...line.matchAll(/<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/g)].map((match) => match[1] ?? "");
}

/**
 * This function tells if a script has a pipe. It does not read the text of quotes, of comments and of here-documents, and an `||` is not a pipe.
 * A `|` of a `case` pattern counts as a pipe. The fix for such a script is harmless.
 */
export function hasPipe(script: string): boolean {
  let quote = "";
  let until: string[] = [];
  for (const line of script.split(/\r?\n/)) {
    if (until.length > 0) {
      if (line.trim() === until[0]) until = until.slice(1);
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const char = line.charAt(i);
      if (quote !== "") {
        if (char === "\\" && quote === '"') i += 1;
        else if (char === quote) quote = "";
      } else if (char === "\\") i += 1;
      else if (char === '"' || char === "'") quote = char;
      else if (char === "#" && (i === 0 || /\s/.test(line.charAt(i - 1)))) break;
      else if (char === "|") {
        if (line.charAt(i + 1) !== "|") return true;
        i += 1;
      }
    }
    if (quote === "") until = hereWords(line);
  }
  return false;
}

/** This function gives the value of `defaults.run.shell` in the block under the line `index`. The value `-1` reads the top of the file. */
function defaultShell(lines: readonly string[], index: number): string | undefined {
  const keys = index < 0 ? lines.flatMap((line, at) => (line.trim() !== "" && indentOf(line) === 0 ? [at] : [])) : childKeys(lines, index);
  const defaults = keys.find((at) => keyValue(lines[at] ?? "", "defaults") !== undefined);
  if (defaults === undefined) return undefined;
  const run = childKeys(lines, defaults).find((at) => keyValue(lines[at] ?? "", "run") !== undefined);
  if (run === undefined) return undefined;
  for (const at of childKeys(lines, run)) {
    const value = keyValue(lines[at] ?? "", "shell");
    if (value !== undefined) return value;
  }
  return undefined;
}

/** A step with a `run` key: the line of the key (from 0), its script, and its `shell`, from the step, the job or the workflow. */
interface RunStep {
  readonly line: number;
  readonly script: string;
  readonly shell: string | undefined;
}

/** This function gives the steps with a `run` key. It reads only the steps of the jobs. */
export function runSteps(lines: readonly string[]): RunStep[] {
  const jobs = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "jobs") !== undefined);
  if (jobs < 0) return [];
  const found: RunStep[] = [];
  const workflowShell = defaultShell(lines, -1);
  for (const job of childKeys(lines, jobs)) {
    const jobShell = defaultShell(lines, job);
    const steps = childKeys(lines, job).find((at) => keyValue(lines[at] ?? "", "steps") !== undefined);
    if (steps === undefined) continue;
    const dashes = stepStarts(lines, steps);
    dashes.forEach((dash, order) => {
      const end = dashes[order + 1] ?? blockAfter(lines, steps);
      const indent = indentOf(lines[dash] ?? "") + 2;
      let run: number | undefined;
      let shell: string | undefined;
      for (let at = dash; at < end; at++) {
        const line = lines[at] ?? "";
        const atKey = at === dash || (line.trim() !== "" && indentOf(line) === indent);
        if (!atKey) continue;
        if (keyValue(line, "run") !== undefined) run = at;
        shell = keyValue(line, "shell") ?? shell;
      }
      if (run === undefined) return;
      const value = keyValue(lines[run] ?? "", "run") ?? "";
      const scalar = /^[|>]/.test(value);
      const body: string[] = scalar ? [] : [value];
      if (scalar) {
        for (let at = run + 1; at < end; at++) {
          const line = lines[at] ?? "";
          if (line.trim() !== "" && indentOf(line) <= indent) break;
          body.push(line);
        }
      }
      found.push({ line: run, script: body.join("\n"), shell: shell ?? jobShell ?? workflowShell });
    });
  }
  return found;
}

/** This function gives the end of the list of steps under the key at the line `steps`. A list can have the same indent as its key. */
function blockAfter(lines: readonly string[], steps: number): number {
  const indent = indentOf(lines[steps] ?? "");
  for (let at = steps + 1; at < lines.length; at++) {
    const line = lines[at] ?? "";
    if (line.trim() === "") continue;
    if (indentOf(line) < indent || (indentOf(line) === indent && !line.trimStart().startsWith("- "))) return at;
  }
  return lines.length;
}

/** This function gives the lines of the items of the list of steps. */
function stepStarts(lines: readonly string[], steps: number): number[] {
  const end = blockAfter(lines, steps);
  let indent: number | undefined;
  const starts: number[] = [];
  for (let at = steps + 1; at < end; at++) {
    const line = lines[at] ?? "";
    if (line.trim() === "") continue;
    indent ??= indentOf(line);
    if (indentOf(line) === indent && line.trimStart().startsWith("- ")) starts.push(at);
  }
  return starts;
}

/** This function tells if a shell hides a failure on the left of a pipe. A shell that is not bash or sh has other rules, and the rule does not read it. */
export function hidesFailure(shell: string | undefined): boolean {
  if (shell === undefined) return true;
  if (shell === "bash" || shell.includes("pipefail")) return false;
  return /^(bash|sh)(\s|$)/.test(shell);
}

/** This function gives the text with `defaults.run.shell` before its key `jobs`, or undefined when the file has its own `defaults`. */
export function withBashDefault(text: string): string | undefined {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (lines.some((line) => indentOf(line) === 0 && keyValue(line, "defaults") !== undefined)) return undefined;
  const jobs = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "jobs") !== undefined);
  if (jobs < 0) return undefined;
  lines.splice(jobs, 0, "defaults:", "  run:", "    shell: bash", "");
  return lines.join(eol);
}

export const pipeFails: Rule = {
  id: "pipe-fails",
  title: "A failure on the left of a pipe fails its step: each step with a pipe has `pipefail`.",
  reason:
    "With no `shell` key, GitHub has no `pipefail`, so `tests | tee out.txt` passes when the tests fail. On 2026-11-05 a read of 25 jobs of a required gate found 4 failed tests in jobs that concluded success.",
  fix: "Add `defaults: { run: { shell: bash } }` to the workflow, or `shell: bash` to the step, or `set -o pipefail` to the script. Then read the next run: a step that turns red had a failure that the pipe hid.",
  sources: [{ repo: "coeval", rule: "pipe-fails", doc: "K228 (2026-11-05): a required gate with no pipefail did not fail on 4 of 25 jobs" }],
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
      const after = withBashDefault(text);
      for (const step of runSteps(workflowLines(text))) {
        if (!hidesFailure(step.shell) || !hasPipe(step.script) || step.script.includes("pipefail")) continue;
        breaks.push({
          file,
          line: step.line + 1,
          message: `A step of ${file} has a pipe and no \`pipefail\`. The step passes when a command on the left of the pipe fails.`,
          ...(after === undefined ? {} : { edits: [{ file, before: text, after }] }),
        });
      }
    }
    return breaks;
  },
};
