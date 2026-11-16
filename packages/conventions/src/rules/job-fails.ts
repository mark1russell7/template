/**
 * The rule `job-fails`: a failed job fails its run and each job that reads it. When a job with `continue-on-error`
 * fails, `needs.<job>.result` is `success`. Thus a summary job of a gate passes over a job that crashed. A test step with
 * `continue-on-error`, or a test command with `|| true`, hides a failed test in the same way. The rule `pipe-fails`
 * holds the third form, a pipe with no `pipefail`.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { byCode } from "../workspace.ts";
import { lineOf, type Break, type Rule } from "../rule.ts";
import { WORKFLOW, blockEnd, childKeys, indentOf, keyValue, listEnd, listItems, shellCode, workflowLines } from "../workflow.ts";

/**
 * A command that starts tests or checks. It is vitest, jest, mocha, pytest, `playwright test` or `node --test`. It can
 * also be a script `test`, `check` or `e2e` (also `check:types`) of pnpm, npm, yarn or bun.
 */
const TEST_COMMAND =
  /\b(?:vitest|jest|mocha|pytest)\b|\bplaywright\s+test\b|\bnode\s+(?:--[\w-]+\s+)*--test\b|\b(?:pnpm|npm|yarn|bun)\b[^;&|]*?\s(?:run\s+)?(?:test|check|e2e)(?::[\w:.-]+)?(?=\s|$)/;

/** A `||` with a command after it that does not fail: `true`, `:`, `exit 0`, `echo` or `printf`. */
const SWALLOW = /\|\|\s*(?:(?:true|:|exit\s+0)(?=\s*(?:$|[;&|)]))|(?:echo|printf)\b)/;

/** An entry of the option `advisory`: `<file>#<job> until <YYYY-MM-DD>: <reason>`. */
const ENTRY = /^([^\s#/]+\.ya?ml)#([\w-]+)\s+until\s+(\d{4}-\d{2}-\d{2})\s*:\s*(\S.*)$/;

/** This function tells if a line of a script starts tests or checks. A word in a quote or a comment starts no test. */
export function startsTests(line: string): boolean {
  return TEST_COMMAND.test(shellCode(line));
}

/** This function tells if a line of a script starts tests and then hides their failure with `||`. */
export function swallowsTests(line: string): boolean {
  const text = shellCode(line);
  const test = TEST_COMMAND.exec(text);
  return test !== null && SWALLOW.test(text.slice(test.index + test[0].length));
}

/** A place in a workflow where a failure does not fail its job or its run. */
export interface HiddenFailure {
  /** The id of the job. */
  readonly job: string;
  /** The line, from 1. */
  readonly line: number;
  /** The key `continue-on-error` of the job (`job`) or of a test step (`step`), or a test command with `||` (`or`). */
  readonly kind: "job" | "step" | "or";
  /** The value of `continue-on-error`, or the text of the command. */
  readonly value: string;
}

/** The keys of one step that the rule reads. */
interface StepKeys {
  id?: string;
  continueOnError?: { readonly line: number; readonly value: string };
  run?: { readonly line: number; readonly lines: readonly string[] };
}

/** This function reads the keys of the step between the lines `start` and `end`. */
function stepKeys(lines: readonly string[], start: number, end: number): StepKeys {
  const indent = indentOf(lines[start] ?? "") + 2;
  const keys: StepKeys = {};
  for (let at = start; at < end; at++) {
    const line = lines[at] ?? "";
    if (at !== start && (line.trim() === "" || indentOf(line) !== indent)) continue;
    const id = keyValue(line, "id");
    if (id !== undefined) keys.id = id;
    const value = keyValue(line, "continue-on-error");
    if (value !== undefined) keys.continueOnError = { line: at, value };
    const run = keyValue(line, "run");
    if (run === undefined) continue;
    if (!/^[|>]/.test(run)) {
      keys.run = { line: at, lines: [run] };
      continue;
    }
    const body: string[] = [];
    for (let next = at + 1; next < end; next++) {
      const text = lines[next] ?? "";
      if (text.trim() !== "" && indentOf(text) <= indent) break;
      body.push(text);
    }
    keys.run = { line: at + 1, lines: body };
  }
  return keys;
}

/** This function gives each place of a workflow where a failure does not fail its job or its run. It does not read comments. */
export function hiddenFailures(text: string): HiddenFailure[] {
  const lines = workflowLines(text);
  const jobs = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "jobs") !== undefined);
  if (jobs < 0) return [];
  const found: HiddenFailure[] = [];
  for (const jobLine of childKeys(lines, jobs)) {
    const job = /^\s*["']?([^"':\s]+)["']?\s*:/.exec(lines[jobLine] ?? "")?.[1] ?? "";
    const keys = childKeys(lines, jobLine);
    for (const at of keys) {
      const value = keyValue(lines[at] ?? "", "continue-on-error");
      if (value !== undefined && value !== "false") found.push({ job, line: at + 1, kind: "job", value });
    }
    const steps = keys.find((at) => keyValue(lines[at] ?? "", "steps") !== undefined);
    if (steps === undefined) continue;
    const jobEnd = blockEnd(lines, jobLine);
    const starts = listItems(lines, steps);
    starts.forEach((start, order) => {
      const end = starts[order + 1] ?? listEnd(lines, steps);
      const step = stepKeys(lines, start, end);
      const script = step.run?.lines ?? [];
      const coe = step.continueOnError;
      if (coe !== undefined && coe.value !== "false" && script.some(startsTests)) {
        // A later step that reads the outcome of this step sees the failure, so the failure is not hidden
        const read = step.id !== undefined && lines.slice(end, jobEnd).some((line) => line.includes(`steps.${step.id}.outcome`));
        if (!read) found.push({ job, line: coe.line + 1, kind: "step", value: coe.value });
      }
      script.forEach((line, offset) => {
        if (swallowsTests(line)) found.push({ job, line: (step.run?.line ?? 0) + offset + 1, kind: "or", value: line.trim() });
      });
    });
  }
  return found;
}

/** An entry of the option `advisory`: a job that keeps a hidden failure until a day, with its reason. */
export interface Advisory {
  /** The name of the workflow file, for example `ci.yml`. */
  readonly file: string;
  readonly job: string;
  /** The last day of the exception (`YYYY-MM-DD`). */
  readonly until: string;
  readonly reason: string;
}

/** This function reads an entry of the option `advisory`, or gives undefined when the entry has another form. */
export function parseAdvisory(entry: string): Advisory | undefined {
  const match = ENTRY.exec(entry.trim());
  if (match === null) return undefined;
  const [, file = "", job = "", until = "", reason = ""] = match;
  return { file, job, until, reason };
}

/** The text of each kind of hidden failure, for the message of a break. */
const WHAT: Readonly<Record<HiddenFailure["kind"], (failure: HiddenFailure, file: string) => string>> = {
  job: (failure, file) =>
    `The job ${failure.job} of ${file} has continue-on-error: ${failure.value}. When it fails, needs.${failure.job}.result is success, and the run passes.`,
  step: (failure, file) =>
    `A test step of the job ${failure.job} of ${file} has continue-on-error: ${failure.value}, and no later step reads its outcome. A failed test does not fail the job.`,
  or: (failure, file) => `A test command of the job ${failure.job} of ${file} ends with a "||" that does not fail: ${failure.value}. A failed test does not fail the step.`,
};

export const jobFails: Rule = {
  id: "job-fails",
  title: "A failed job fails its run and each job that reads it: no `continue-on-error` on a job or a test step, and no `|| true` after a test.",
  reason:
    "When a job with `continue-on-error` fails, `needs.<job>.result` is `success`, so a summary job of a gate passes over a crash. On 2026-11-05 the gate Speed OK of coeval stayed green over a failed job of this form.",
  fix: "Remove `continue-on-error` from the job or the test step, and `|| true` from the test command. A job that must not stop a merge stays out of the `needs` of the gate: its failure stays red, and the gate passes. To keep the key for a time, add `<file>#<job> until <YYYY-MM-DD>: <reason>` to the option `advisory`.",
  sources: [
    { repo: "coeval", rule: "gate", doc: "run 42034457935 (2026-11-05): a job with continue-on-error ended in failure, and needs.<job>.result read success, so Speed OK passed" },
    { repo: "vex", rule: "workflow-faults", doc: "vex-testkit src/workflow-faults.ts (2026-11-04): continue-on-error and || after a test hide a failed property" },
    { repo: "lag", rule: "ci", doc: "ci.yml (2026-11-16): the jobs safari and ios have continue-on-error: true" },
  ],
  options: {
    advisory: {
      type: "strings",
      default: [],
      description:
        "The jobs that keep a hidden failure for a time, each as `<file>#<job> until <YYYY-MM-DD>: <reason>`. An entry covers the job and its steps. It fails after its day, and when its job hides no failure.",
    },
  },
  failsFrom: "2026-12-07",
  check(context, options) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const today = context.today ?? new Date().toISOString().slice(0, 10);
    const config = context.rootPackage;
    const breaks: Break[] = [];
    const entryLine = (entry: string): number => lineOf(config.text, JSON.stringify(entry)) ?? 1;
    const live = new Map<string, Advisory>();
    const entries = new Map<string, string>();
    for (const entry of (options["advisory"] ?? []) as readonly string[]) {
      const advisory = parseAdvisory(entry);
      if (advisory === undefined) {
        breaks.push({ file: config.file, line: entryLine(entry), message: `The entry "${entry}" of the option advisory has another form than "<file>#<job> until <YYYY-MM-DD>: <reason>".` });
        continue;
      }
      const key = `${advisory.file}#${advisory.job}`;
      entries.set(key, entry);
      if (advisory.until < today) {
        breaks.push({ file: config.file, line: entryLine(entry), message: `The exception ${key} ended on ${advisory.until}. Remove continue-on-error from the job, or give a new day with its reason.` });
      } else live.set(key, advisory);
    }
    const hidden = new Set<string>();
    for (const file of files.filter((path) => WORKFLOW.test(path)).sort(byCode)) {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      for (const failure of hiddenFailures(text)) {
        const key = `${basename(file)}#${failure.job}`;
        hidden.add(key);
        if (live.has(key)) continue;
        breaks.push({ file, line: failure.line, message: WHAT[failure.kind](failure, file) });
      }
    }
    for (const [key, entry] of entries) {
      if (!hidden.has(key)) breaks.push({ file: config.file, line: entryLine(entry), message: `The exception ${key} of the option advisory names no job with a hidden failure. Remove it.` });
    }
    return breaks;
  },
};
