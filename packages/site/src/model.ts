/**
 * The model of the two explorers of the page, with no DOM. The package preview gives the files of a preset for a package
 * name, and the differences from a second preset. The workflow explorer gives the state of each job and step for an
 * event and its inputs.
 */

import { evaluate, stateOf, UNKNOWN, type Reference, type Value } from "./expr.ts";
import type { ScaffoldData, ScaffoldFile, ScaffoldPreset, Workflow, WorkflowInput } from "./types.ts";

/** The files of a preset, with the package name and the scope of the visitor in place of the marks of the build. */
export function personalize(data: ScaffoldData, preset: ScaffoldPreset, name: string, scope: string): { files: ScaffoldFile[]; install: string[] } {
  const swap = (text: string): string => text.split(data.scopeMark).join(scope).split(data.nameMark).join(name);
  return { files: preset.files.map((file) => ({ path: swap(file.path), text: swap(file.text) })), install: preset.install.map(swap) };
}

/** The difference of a file from the file at the same path of a second preset. */
export type FileMark = "same" | "changed" | "added";

/** This function gives the mark of each file of a preset, and the files of the second preset that it does not have. */
export function compareFiles(files: readonly ScaffoldFile[], base: readonly ScaffoldFile[] | undefined): { marks: Map<string, FileMark>; removed: string[] } {
  const marks = new Map<string, FileMark>();
  if (base === undefined) {
    for (const file of files) marks.set(file.path, "same");
    return { marks, removed: [] };
  }
  const byPath = new Map(base.map((file) => [file.path, file.text]));
  for (const file of files) {
    const other = byPath.get(file.path);
    marks.set(file.path, other === undefined ? "added" : other === file.text ? "same" : "changed");
  }
  const paths = new Set(files.map((file) => file.path));
  return { marks, removed: base.map((file) => file.path).filter((path) => !paths.has(path)) };
}

/**
 * This function marks each line of a text that the second text does not have. A line that is two times in the text
 * and one time in the second text gets one mark. Without a second text, no line has a mark.
 */
export function lineMarks(text: string, base: string | undefined): boolean[] {
  const lines = text.replace(/\n$/, "").split("\n");
  if (base === undefined) return lines.map(() => false);
  const counts = new Map<string, number>();
  for (const line of base.replace(/\n$/, "").split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  return lines.map((line) => {
    const left = counts.get(line) ?? 0;
    if (left > 0) {
      counts.set(line, left - 1);
      return false;
    }
    return true;
  });
}

/** A row of the file tree: a folder or a file, with its depth. */
export interface TreeRow {
  readonly kind: "folder" | "file";
  /** The path of the file, or of the folder. */
  readonly path: string;
  /** The last part of the path. */
  readonly label: string;
  readonly depth: number;
}

/** This function gives the rows of the tree of some file paths: each folder before its files, the folders first. */
export function treeRows(paths: readonly string[]): TreeRow[] {
  type Node = { folders: Map<string, Node>; files: string[] };
  const root: Node = { folders: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.get(part);
      if (next === undefined) {
        next = { folders: new Map(), files: [] };
        node.folders.set(part, next);
      }
      node = next;
    }
    node.files.push(path);
  }
  const rows: TreeRow[] = [];
  const walk = (node: Node, prefix: string, depth: number): void => {
    for (const [name, child] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix ? `${prefix}/${name}` : name;
      rows.push({ kind: "folder", path, label: name, depth });
      walk(child, path, depth + 1);
    }
    for (const path of [...node.files].sort((a, b) => a.localeCompare(b))) rows.push({ kind: "file", path, label: path.split("/").pop() ?? path, depth });
  };
  walk(root, "", 0);
  return rows;
}

/** The events of a caller that the workflow explorer offers. */
export const EVENTS = ["push", "pull_request", "schedule", "workflow_dispatch", "workflow_run"] as const;

/** An event of a caller. */
export type EventName = (typeof EVENTS)[number];

/** The value of an input from its default text. A boolean input gets a boolean, and a number input gets a number. */
export function inputDefault(input: WorkflowInput): Value {
  if (input.type === "boolean") return input.default === "true";
  if (input.type === "number") return input.default === "" ? 0 : Number(input.default);
  return input.default.includes("${{") ? UNKNOWN : input.default;
}

/**
 * This function gives the value of a context path for an event of the caller and the inputs. A value that the page
 * cannot know before the run is `UNKNOWN`. The caller pushes to `main`. A `workflow_run` is a CI run of a push to `main` that passed.
 */
export function contextValue(path: string, event: EventName, inputs: ReadonlyMap<string, Value>): Value {
  if (path.startsWith("inputs.")) return inputs.has(path.slice(7)) ? (inputs.get(path.slice(7)) as Value) : UNKNOWN;
  if (path === "github.event_name") return event;
  const pr = event === "pull_request";
  if (path === "github.ref") return pr ? UNKNOWN : "refs/heads/main";
  if (path === "github.ref_name") return pr ? UNKNOWN : "main";
  if (path === "github.event.repository.default_branch") return "main";
  if (path.startsWith("github.event.workflow_run.")) {
    if (event !== "workflow_run") return null;
    const run: Record<string, string> = { conclusion: "success", event: "push", head_branch: "main" };
    return run[path.slice("github.event.workflow_run.".length)] ?? UNKNOWN;
  }
  if (path.startsWith("github.event.pull_request.")) return pr ? UNKNOWN : null;
  return UNKNOWN;
}

/** The state of a job or of a step. */
export type RunState = "runs" | "skipped" | "unknown";

/** A step in the explorer, with its state and the context values that its condition read. */
export interface StepView {
  readonly label: string;
  readonly if: string;
  readonly state: RunState;
  readonly refs: readonly Reference[];
}

/** A job in the explorer. */
export interface JobView {
  readonly id: string;
  readonly if: string;
  readonly needs: readonly string[];
  readonly state: RunState;
  readonly refs: readonly Reference[];
  /** This text tells how a job that it needs stops it, or makes its state unknown. It is empty when no job blocks it. */
  readonly blockedBy: string;
  readonly steps: readonly StepView[];
}

/** This function evaluates a condition. A condition that the evaluator does not know gives the state unknown. */
function judge(condition: string, lookup: (path: string) => Value): { state: RunState; refs: readonly Reference[] } {
  try {
    const result = evaluate(condition, lookup);
    return { state: stateOf(result.value), refs: result.refs };
  } catch {
    return { state: "unknown", refs: [] };
  }
}

/** This function gives the state of each job and step of a workflow for an event of the caller and values of the inputs. */
export function explore(workflow: Workflow, event: EventName, values: ReadonlyMap<string, Value>): JobView[] {
  const inputs = new Map<string, Value>(workflow.inputs.map((input) => [input.name, values.has(input.name) ? (values.get(input.name) as Value) : inputDefault(input)]));
  const lookup = (path: string): Value => contextValue(path, event, inputs);
  const states = new Map<string, RunState>();
  const views: JobView[] = [];
  for (const job of workflow.jobs) {
    const own = judge(job.if, lookup);
    // A job runs after the jobs that it needs pass, unless its condition has always() or a check of the results.
    const free = /\b(always|failure|cancelled)\s*\(/.test(job.if);
    const needed = job.needs.map((id) => ({ id, state: states.get(id) ?? "unknown" }));
    let state = own.state;
    let blockedBy = "";
    const skipped = needed.find((n) => n.state === "skipped");
    const open = needed.find((n) => n.state === "unknown");
    if (!free && state !== "skipped" && skipped) {
      state = "skipped";
      blockedBy = `It needs ${skipped.id}, which does not run.`;
    } else if (!free && state === "runs" && open) {
      state = "unknown";
      blockedBy = `It needs ${open.id}, which the run decides.`;
    }
    states.set(job.id, state);
    const steps = job.steps.map((step): StepView => {
      const result = judge(step.if, lookup);
      return { label: step.label, if: step.if, state: state === "skipped" ? "skipped" : result.state === "runs" && state === "unknown" ? "unknown" : result.state, refs: result.refs };
    });
    views.push({ id: job.id, if: job.if, needs: job.needs, state, refs: own.refs, blockedBy, steps });
  }
  return views;
}

/** This function gives the inputs that the conditions of a workflow read, in the order of the workflow. */
export function conditionInputs(workflow: Workflow): WorkflowInput[] {
  const names = new Set<string>();
  const conditions = workflow.jobs.flatMap((job) => [job.if, ...job.steps.map((step) => step.if)]);
  for (const condition of conditions) {
    for (const match of condition.matchAll(/\binputs\.([A-Za-z_][\w-]*)/g)) if (match[1]) names.add(match[1]);
  }
  return workflow.inputs.filter((input) => names.has(input.name));
}
