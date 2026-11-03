/**
 * A small reader of the shared workflow files, by the indent of the lines. It reads the parts that the workflow
 * explorer shows: the inputs of `workflow_call`, the jobs, their `needs` and `if`, and the steps with their `if`.
 * It knows the block form, the inline values and the block scalars (`|` and `>`) that the workflows of the template use.
 */

import type { Workflow, WorkflowInput, WorkflowJob, WorkflowStep } from "./types.ts";

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** This function removes a comment at the end of a value, and the quotes around it. */
export function valueOf(raw: string): string {
  const comment = raw.search(/\s#/);
  let value = (comment >= 0 ? raw.slice(0, comment) : raw).trim();
  const quote = value.charAt(0);
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
  return value;
}

/** This function gives the end of the block under the line `index`: the next line with the same indent or a smaller one. */
function blockEnd(lines: readonly string[], index: number): number {
  const indent = indentOf(lines[index] ?? "");
  let end = index + 1;
  while (end < lines.length && ((lines[end] ?? "").trim() === "" || indentOf(lines[end] ?? "") > indent)) end += 1;
  return end;
}

/** A key of a block: its line and its value. A block scalar gives its text. A nested block gives an empty text. */
interface Entry {
  readonly line: number;
  readonly value: string;
}

/** This function gives the text of a block scalar (`|`, `|-`, `>`, `>-`) under the line `index`. */
function scalar(lines: readonly string[], index: number, style: string): string {
  const body = lines.slice(index + 1, blockEnd(lines, index));
  const indent = Math.min(...body.filter((l) => l.trim() !== "").map(indentOf));
  const text = body.map((l) => l.slice(indent).trimEnd());
  return (style.startsWith(">") ? text.join(" ").replace(/\s+/g, " ") : text.join("\n")).trim();
}

/** This function gives the keys of the lines `start` to `end` at the indent `indent`. A first line can start with `- `. */
function entries(lines: readonly string[], start: number, end: number, indent: number): Map<string, Entry> {
  const map = new Map<string, Entry>();
  for (let i = start; i < end; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    let text = line;
    if (i === start && line.trimStart().startsWith("- ")) text = " ".repeat(indentOf(line) + 2) + line.trimStart().slice(2);
    if (indentOf(text) !== indent) continue;
    const match = /^\s*("[^"]+"|'[^']+'|[^\s:][^:]*):(?:\s(.*))?$/.exec(text);
    if (!match?.[1]) continue;
    const key = match[1].replace(/^["']|["']$/g, "");
    const raw = valueOf((match[2] ?? "").trim());
    map.set(key, { line: i, value: /^[|>][-+]?$/.test(raw) ? scalar(lines, i, raw) : raw });
  }
  return map;
}

/** This function gives the keys of the block under the line `index`. */
function childrenOf(lines: readonly string[], index: number): Map<string, Entry> {
  const end = blockEnd(lines, index);
  const first = lines.slice(index + 1, end).find((l) => l.trim() !== "");
  return first === undefined ? new Map() : entries(lines, index + 1, end, indentOf(first));
}

/** This function gives the first line of each item of the list under the line `index`. */
function itemsOf(lines: readonly string[], index: number): number[] {
  const end = blockEnd(lines, index);
  const items: number[] = [];
  let indent: number | undefined;
  for (let i = index + 1; i < end; i++) {
    const line = lines[i] ?? "";
    if (!line.trimStart().startsWith("- ") && line.trim() !== "-") continue;
    indent ??= indentOf(line);
    if (indentOf(line) === indent) items.push(i);
  }
  return items;
}

/** This function gives the values of a list: an inline list (`[a, b]`), one value, or a block list. */
function listOf(lines: readonly string[], entry: Entry | undefined): string[] {
  if (entry === undefined) return [];
  const inline = entry.value.trim();
  if (inline.startsWith("[")) return inline.slice(1, -1).split(",").map(valueOf).filter(Boolean);
  if (inline !== "") return [inline];
  return itemsOf(lines, entry.line).map((i) => valueOf((lines[i] ?? "").trimStart().slice(2)));
}

/** This function gives an action of a `uses` value with no pin: `actions/checkout@<sha> # v7` gives `actions/checkout`. */
const actionOf = (uses: string): string => uses.split("@", 1)[0] ?? uses;

/** This function gives the label of a step: its name, else its action, its id or its first command. */
function stepLabel(step: Map<string, Entry>): string {
  const name = step.get("name")?.value;
  if (name) return name;
  const uses = step.get("uses")?.value;
  if (uses) return actionOf(uses);
  const run = step.get("run")?.value.split("\n")[0];
  if (run) return run;
  return step.get("id")?.value ?? "step";
}

/** This function gives the summary of a workflow: the first paragraph of the comment at the top of the file. */
function summaryOf(lines: readonly string[]): string {
  const words: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("#")) break;
    const text = line.replace(/^#\s?/, "").trim();
    if (text === "") {
      if (words.length > 0) break;
      continue;
    }
    words.push(text);
  }
  return words.join(" ");
}

/** This function reads a shared workflow file. The file name goes into the result. */
export function readWorkflow(file: string, text: string): Workflow {
  const raw = text.split(/\r?\n/);
  const lines = raw.map((line) => (line.trimStart().startsWith("#") ? "" : line));
  const top = entries(lines, 0, lines.length, 0);
  const on = top.get("on");
  const call = on ? childrenOf(lines, on.line).get("workflow_call") : undefined;
  const inputsEntry = call ? childrenOf(lines, call.line).get("inputs") : undefined;
  const inputs: WorkflowInput[] = [];
  if (inputsEntry) {
    for (const [name, entry] of childrenOf(lines, inputsEntry.line)) {
      const keys = childrenOf(lines, entry.line);
      inputs.push({
        name,
        type: keys.get("type")?.value ?? "string",
        description: keys.get("description")?.value ?? "",
        default: keys.get("default")?.value ?? "",
        required: keys.get("required")?.value === "true",
      });
    }
  }
  const jobs: WorkflowJob[] = [];
  const jobsEntry = top.get("jobs");
  if (jobsEntry) {
    for (const [id, entry] of childrenOf(lines, jobsEntry.line)) {
      const keys = childrenOf(lines, entry.line);
      const stepsEntry = keys.get("steps");
      const steps: WorkflowStep[] = [];
      if (stepsEntry) {
        const items = itemsOf(lines, stepsEntry.line);
        const last = blockEnd(lines, stepsEntry.line);
        items.forEach((start, n) => {
          const step = entries(lines, start, items[n + 1] ?? last, indentOf(lines[start] ?? "") + 2);
          steps.push({ label: stepLabel(step), if: step.get("if")?.value ?? "", uses: actionOf(step.get("uses")?.value ?? "") });
        });
      }
      const uses = keys.get("uses")?.value;
      if (steps.length === 0 && uses) steps.push({ label: `calls ${actionOf(uses)}`, if: "", uses: actionOf(uses) });
      jobs.push({ id, if: keys.get("if")?.value ?? "", needs: listOf(lines, keys.get("needs")), steps });
    }
  }
  return { file, name: top.get("name")?.value ?? file, summary: summaryOf(raw), inputs, jobs };
}
