/**
 * A small reader of GitHub workflow files, by the indent of the lines. The rules that read workflows share it. It
 * knows the block form, the inline values of keys and the block scalars (`|` and `>`) that the workflows of the template
 * use. `readWorkflow` gives the parts of a shared workflow that the site of the template shows.
 */

/** A workflow file. */
export const WORKFLOW: RegExp = /^\.github\/workflows\/[^/]+\.ya?ml$/;

export const indentOf = (line: string): number => line.length - line.trimStart().length;

/** This function gives the lines of a workflow, with each line of a comment made empty. */
export const workflowLines = (text: string): string[] => text.split(/\r?\n/).map((line) => (line.trimStart().startsWith("#") ? "" : line));

/** This function removes a comment at the end of a value, and the quotes around it. */
export function valueOf(raw: string): string {
  // YAML starts a comment at a "#" after a space or a tab.
  const comment = raw.search(/\s#/);
  let value = (comment >= 0 ? raw.slice(0, comment) : raw).trim();
  const quote = value.charAt(0);
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1).trim();
  return value;
}

/** This function gives the value of the key `key` on a line, or undefined when the line has another key. A quoted key ("on") counts too. */
export function keyValue(line: string, key: string): string | undefined {
  let text = line.trimStart();
  if (text.startsWith("- ")) text = text.slice(2).trimStart();
  for (const form of [key, `"${key}"`, `'${key}'`]) if (text.startsWith(`${form}:`)) return valueOf(text.slice(form.length + 1));
  return undefined;
}

/** This function gives the end of the block under the line `index`. The end is the next line with the same indent or a smaller one. */
export function blockEnd(lines: readonly string[], index: number): number {
  const indent = indentOf(lines[index] ?? "");
  let end = index + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (line.trim() !== "" && indentOf(line) <= indent) break;
    end += 1;
  }
  return end;
}

/** This function gives the indent of the first key of the block under the line `index`, or undefined for an empty block. */
export function childIndent(lines: readonly string[], index: number): number | undefined {
  const end = blockEnd(lines, index);
  for (let i = index + 1; i < end; i++) if ((lines[i] ?? "").trim() !== "") return indentOf(lines[i] ?? "");
  return undefined;
}

/** This function gives the indexes of the keys of the block under the line `index`: the lines at the indent of its first key. */
export function childKeys(lines: readonly string[], index: number): number[] {
  const indent = childIndent(lines, index);
  if (indent === undefined) return [];
  const keys: number[] = [];
  for (let i = index + 1; i < blockEnd(lines, index); i++) if ((lines[i] ?? "").trim() !== "" && indentOf(lines[i] ?? "") === indent) keys.push(i);
  return keys;
}

export interface WorkflowInput {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  /** The default value, as YAML text. An empty text is no default. */
  readonly default: string;
  readonly required: boolean;
}

/** A step of a job. */
export interface WorkflowStep {
  /** The name of the step, or else its action, its id or its first command. */
  readonly label: string;
  /** The condition of the step (`if`), or an empty text. */
  readonly if: string;
  /** The action of the step (`uses`), with no pin, or an empty text. */
  readonly uses: string;
}

/** A job of a workflow. */
export interface WorkflowJob {
  readonly id: string;
  readonly if: string;
  readonly needs: readonly string[];
  readonly steps: readonly WorkflowStep[];
}

/** A shared workflow of the repository. */
export interface Workflow {
  /** The file name, for example `reusable-pages.yml`. */
  readonly file: string;
  /** The value of `name`. */
  readonly name: string;
  /** The first lines of the comment at the top of the file. */
  readonly summary: string;
  readonly inputs: readonly WorkflowInput[];
  readonly jobs: readonly WorkflowJob[];
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
