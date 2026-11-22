/**
 * The readers of GitHub workflow files. The rules that read workflows share them.
 *
 * - The line reader reads by the indent of the lines. It knows the block form, the inline values of keys and the block
 *   scalars (`|` and `>`) that the workflows of the template use. `readWorkflow` gives the parts of a shared workflow
 *   that the site of the template shows.
 * - `parseWorkflow` reads with the YAML parser of the package `yaml`. It gives the facts that a security gate needs: the
 *   triggers, the permissions, the secrets that each job reads, and the steps. A gate uses this reader, not the line reader.
 */
import { parseAllDocuments, type Document } from "yaml";
import { errorMessage } from "@mark1russell7/text";
import { isObject } from "./config.ts";

/** A workflow file. */
export const WORKFLOW: RegExp = /^\.github\/workflows\/[^/]+\.ya?ml$/;

export const indentOf = (line: string): number => line.length - line.trimStart().length;

/** This function gives the lines of a workflow, with each line of a comment made empty. */
export const workflowLines = (text: string): string[] => text.split(/\r?\n/).map((line) => (line.trimStart().startsWith("#") ? "" : line));

/**
 * This function gives a line of a shell script with each quoted text as `""` and with no comment. A word in a quote or a
 * comment is thus not a command. A double quote can hold `\"`. A quote that does not close stays as it is.
 *
 * The function reads the line one time. The regular expression `"(?:[^"\\]|\\.)*"` starts a new search at each `"`.
 * On a line of many `\"` with no closing quote, its time is the square of the length (CodeQL `js/polynomial-redos`).
 * Here, a failed search for the closing `"` reads the line to its end. Each later `"` then has no closing quote too.
 * Thus each kind of quote fails at most one time.
 */
export function shellCode(line: string): string {
  let out = "";
  let open: { readonly double: boolean; readonly single: boolean } = { double: true, single: true };
  let i = 0;
  while (i < line.length) {
    const char = line.charAt(i);
    const double = char === '"' && open.double;
    if (double || (char === "'" && open.single)) {
      let end = i + 1;
      while (end < line.length && line.charAt(end) !== char) end += double && line.charAt(end) === "\\" ? 2 : 1;
      if (end < line.length) {
        out += '""';
        i = end + 1;
        continue;
      }
      open = double ? { ...open, double: false } : { ...open, single: false };
    }
    out += char;
    i += 1;
  }
  const comment = out.search(/(?:^|\s)#/);
  return comment >= 0 ? out.slice(0, comment) : out;
}

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

/** This function gives the end of the list under the key at the line `key`, for example `steps`. A list can have the same indent as its key. */
export function listEnd(lines: readonly string[], key: number): number {
  const indent = indentOf(lines[key] ?? "");
  for (let at = key + 1; at < lines.length; at++) {
    const line = lines[at] ?? "";
    if (line.trim() === "") continue;
    if (indentOf(line) < indent || (indentOf(line) === indent && !line.trimStart().startsWith("- "))) return at;
  }
  return lines.length;
}

/** This function gives the lines of the items (`- `) of the list under the key at the line `key`. */
export function listItems(lines: readonly string[], key: number): number[] {
  const end = listEnd(lines, key);
  let indent: number | undefined;
  const starts: number[] = [];
  for (let at = key + 1; at < end; at++) {
    const line = lines[at] ?? "";
    if (line.trim() === "") continue;
    indent ??= indentOf(line);
    if (indentOf(line) === indent && line.trimStart().startsWith("- ")) starts.push(at);
  }
  return starts;
}

/** A change of the lines: at the index `at`, remove `remove` lines and put `insert` in their place. */
export interface Splice {
  readonly at: number;
  readonly remove: number;
  readonly insert: readonly string[];
}

/**
 * This function applies changes to the lines of `text`, and keeps its line ends. The changes go from the end to the
 * start, so each index stays correct. At one index, a splice that removes lines goes first, so it removes only the old
 * lines. Then the inserts go in, the later one first, so they keep their order.
 */
export function applySplices(text: string, splices: readonly Splice[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out = text.split(/\r?\n/);
  for (const item of splices.map((value, order) => ({ ...value, order })).sort((a, b) => b.at - a.at || b.remove - a.remove || b.order - a.order)) out.splice(item.at, item.remove, ...item.insert);
  return out.join(eol);
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

/** A shared workflow of the repository, or a composite action in the same form. */
export interface Workflow {
  /** The file name, for example `reusable-pages.yml`. */
  readonly file: string;
  /** The value `action` marks a composite action of {@link readAction}. A workflow has no value here. */
  readonly kind?: "action";
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
      const steps: WorkflowStep[] = stepsEntry ? stepsOf(lines, stepsEntry.line) : [];
      const uses = keys.get("uses")?.value;
      if (steps.length === 0 && uses) steps.push({ label: `calls ${actionOf(uses)}`, if: "", uses: actionOf(uses) });
      jobs.push({ id, if: keys.get("if")?.value ?? "", needs: listOf(lines, keys.get("needs")), steps });
    }
  }
  return { file, name: top.get("name")?.value ?? file, summary: summaryOf(raw), inputs, jobs };
}

/** This function gives the steps of the list under the line `index`. */
function stepsOf(lines: readonly string[], index: number): WorkflowStep[] {
  const items = itemsOf(lines, index);
  const last = blockEnd(lines, index);
  return items.map((start, n) => {
    const step = entries(lines, start, items[n + 1] ?? last, indentOf(lines[start] ?? "") + 2);
    return { label: stepLabel(step), if: step.get("if")?.value ?? "", uses: actionOf(step.get("uses")?.value ?? "") };
  });
}

/**
 * This function reads a composite action (`action.yml`) in the form of a workflow. The steps of `runs` are the steps of
 * one job `steps`. An input of a composite action has no type, so an input with the default `true` or `false` gets the
 * type `boolean`. The value of such an input is still a string for the runner. The description of the action is the
 * summary. An action that is not composite gives no job.
 */
export function readAction(file: string, text: string): Workflow {
  const lines = workflowLines(text);
  const top = entries(lines, 0, lines.length, 0);
  const inputs: WorkflowInput[] = [];
  const inputsEntry = top.get("inputs");
  if (inputsEntry) {
    for (const [name, entry] of childrenOf(lines, inputsEntry.line)) {
      const keys = childrenOf(lines, entry.line);
      const value = keys.get("default")?.value ?? "";
      inputs.push({
        name,
        type: value === "true" || value === "false" ? "boolean" : "string",
        description: keys.get("description")?.value ?? "",
        default: value,
        required: keys.get("required")?.value === "true",
      });
    }
  }
  const runs = top.get("runs");
  const keys = runs ? childrenOf(lines, runs.line) : new Map<string, Entry>();
  const stepsEntry = keys.get("using")?.value === "composite" ? keys.get("steps") : undefined;
  const jobs: WorkflowJob[] = stepsEntry ? [{ id: "steps", if: "", needs: [], steps: stepsOf(lines, stepsEntry.line) }] : [];
  return { file, kind: "action", name: top.get("name")?.value ?? file, summary: top.get("description")?.value ?? "", inputs, jobs };
}

/** A fault of the YAML of a file: its line and column (from 1), and the first line of the message of the parser. */
export interface YamlFault {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/** This constant is the options of the parser. With `prettyErrors`, each error has its line and its column. */
const PARSE = { prettyErrors: true } as const;

/** This function gives the errors of the parser for each document of a text. */
function faultsOf(documents: readonly Document.Parsed[]): YamlFault[] {
  const faults: YamlFault[] = [];
  for (const document of documents) {
    for (const error of document.errors) {
      const at = error.linePos?.[0];
      // The pretty message repeats the lines of the file after its first line
      faults.push({ line: at?.line ?? 1, column: at?.col ?? 1, message: (error.message.split("\n")[0] ?? error.code).replace(/:$/, "") });
    }
  }
  return faults;
}

/** This function gives the faults of a YAML text. A text with no fault gives an empty list. */
export function yamlFaults(text: string): YamlFault[] {
  return faultsOf(parseAllDocuments(text, PARSE));
}

/**
 * The permissions of a workflow or a job (`permissions`).
 *
 * - `null`: the key is not there. A job then gets the permissions of its workflow, and a workflow gets the default of the
 *   repository.
 * - A text: `read-all`, `write-all`, or another value as JSON text (`permissions:` with no value gives `null` as text).
 * - A record: the level of each scope, for example `{ contents: "read" }`. The record `{}` gives no scope to the token.
 */
export type WorkflowPermissions = string | Readonly<Record<string, string>> | null;

/** A step of a job, as the YAML parser reads it. */
export interface ParsedStep {
  /** The name of the step, or else its action, its first command or its id, as in {@link WorkflowStep}. */
  readonly label: string;
  /** The condition of the step (`if`), or an empty text. */
  readonly if: string;
  /** The action of the step (`uses`), with no pin, or an empty text. */
  readonly uses: string;
  /** The secrets that the expressions of the step read. The name `*` is the whole context, as in `toJSON(secrets)`. */
  readonly secrets: readonly string[];
}

/** A job of a workflow, as the YAML parser reads it. */
export interface ParsedJob {
  readonly id: string;
  /** The condition of the job (`if`), or an empty text. */
  readonly if: string;
  readonly needs: readonly string[];
  /** The workflow that the job calls (`uses`), with no pin, or an empty text. */
  readonly uses: string;
  readonly permissions: WorkflowPermissions;
  /** The secrets that the job and its steps read. The name `inherit` is `secrets: inherit`, and `*` is the whole context. */
  readonly secrets: readonly string[];
  readonly steps: readonly ParsedStep[];
}

/** The facts of a workflow file from the YAML parser. */
export interface ParsedWorkflow {
  /** The file name, for example `ci.yml`. */
  readonly file: string;
  /** The value of `name`, or the file name. */
  readonly name: string;
  /** The events of `on`, in the order of the file. */
  readonly triggers: readonly string[];
  readonly permissions: WorkflowPermissions;
  /** The secrets that each part of the file reads, with each job. */
  readonly secrets: readonly string[];
  readonly jobs: readonly ParsedJob[];
  /**
   * The faults of the file. GitHub starts no job of a file that does not parse, so a file with a fault gives no trigger
   * and no job. A gate fails on each fault. The reader also refuses two documents in one file. It refuses a version of
   * YAML that is not 1.2, because YAML 1.1 reads the key `on` as `true`.
   */
  readonly faults: readonly YamlFault[];
}

/** This function gives the text of a value of the parser: a string as it is, and another value as JSON text. */
const textOf = (value: unknown): string => (typeof value === "string" ? value : (JSON.stringify(value) ?? ""));

/** This function gives the text of a key that can be absent, with no space at its ends. No value gives an empty text. */
const optionalText = (value: unknown): string => (value === undefined || value === null ? "" : textOf(value).trim());

/** This function gives the values of a key that holds one value or a list of values. */
const listValues = (value: unknown): string[] => (value === undefined || value === null ? [] : Array.isArray(value) ? value.map(textOf) : [textOf(value)]);

/** This function gives the permissions of a workflow or of a job. */
function permissionsOf(owner: Readonly<Record<string, unknown>>): WorkflowPermissions {
  if (!Object.hasOwn(owner, "permissions")) return null;
  const value = owner["permissions"];
  if (!isObject(value)) return textOf(value);
  return Object.fromEntries(Object.entries(value).map(([scope, level]) => [scope, textOf(level)]));
}

/** This function gives the events of the key `on`: one event, a list of events, or a map with an event as each key. */
function triggersOf(on: unknown): string[] {
  if (isObject(on)) return Object.keys(on);
  return listValues(on);
}

/**
 * This regular expression finds a reference to a secret in an expression: `secrets.NAME`, `secrets['NAME']`, or the
 * context `secrets` with no name. The names of the contexts of GitHub are not case-sensitive.
 */
const SECRET = /(?<![\w.-])secrets(?![\w-])\s*(?:\.\s*([A-Za-z_][\w-]*)|\[\s*'([^']*)'\s*\])?/gi;

/**
 * This function gives the expressions of a text: the parts between `${{` and `}}`. An expression with no `}}` goes to
 * the end of the text, so a reference in it still counts.
 */
function expressionsOf(text: string): string[] {
  const out: string[] = [];
  let at = text.indexOf("${{");
  while (at >= 0) {
    const end = text.indexOf("}}", at + 3);
    out.push(text.slice(at + 3, end < 0 ? undefined : end));
    if (end < 0) break;
    at = text.indexOf("${{", end + 2);
  }
  return out;
}

/**
 * This function adds the secrets that a value of the parser reads: each string in it, and in its lists and maps. The
 * value of a key `if` is an expression also with no `${{ }}`, as GitHub reads it. The keys of a map are not expressions.
 */
function addSecrets(value: unknown, key: string, into: Set<string>, seen: Set<object>): void {
  if (typeof value === "string") {
    for (const body of key === "if" ? [value] : expressionsOf(value)) for (const match of body.matchAll(SECRET)) into.add(match[1] ?? match[2] ?? "*");
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  // An alias of YAML gives the same object at two places of the value, so each object counts one time
  seen.add(value);
  if (Array.isArray(value)) for (const item of value) addSecrets(item, "", into, seen);
  else for (const [name, item] of Object.entries(value)) addSecrets(item, name, into, seen);
}

/** This function gives the secrets that a value of the parser reads. */
function secretsOf(value: unknown): Set<string> {
  const secrets = new Set<string>();
  addSecrets(value, "", secrets, new Set());
  return secrets;
}

/** This function reads a step: the same label as the line reader gives, its condition, its action and its secrets. */
function parsedStep(value: unknown): ParsedStep {
  const step = isObject(value) ? value : {};
  const uses = actionOf(optionalText(step["uses"]));
  const label = optionalText(step["name"]) || uses || (optionalText(step["run"]).split("\n")[0] ?? "") || optionalText(step["id"]) || "step";
  return { label, if: optionalText(step["if"]), uses, secrets: [...secretsOf(step)] };
}

/** This function reads a job. */
function parsedJob(id: string, value: unknown): ParsedJob {
  const job = isObject(value) ? value : {};
  const secrets = secretsOf(job);
  if (job["secrets"] === "inherit") secrets.add("inherit");
  return {
    id,
    if: optionalText(job["if"]),
    needs: listValues(job["needs"]),
    uses: actionOf(optionalText(job["uses"])),
    permissions: permissionsOf(job),
    secrets: [...secrets],
    steps: Array.isArray(job["steps"]) ? job["steps"].map(parsedStep) : [],
  };
}

/** This function gives the line (from 1) of the offset `at` of a text. */
const lineAt = (text: string, at: number): number => text.slice(0, at).split("\n").length;

/**
 * This function reads a workflow file with the YAML parser. The file name goes into the result. It does not throw: each
 * problem is a fault of the result. A file with a fault gives no trigger and no job.
 */
export function parseWorkflow(file: string, text: string): ParsedWorkflow {
  const documents = parseAllDocuments(text, PARSE);
  const faults = faultsOf(documents);
  const [first, second] = documents;
  if (second !== undefined) faults.push({ line: lineAt(text, second.range[0]), column: 1, message: `The file has ${documents.length} YAML documents, and a workflow is one document` });
  const version = first?.directives?.yaml.version ?? "1.2";
  if (version !== "1.2") faults.push({ line: 1, column: 1, message: `The file asks for YAML ${version}, and the reader takes only YAML 1.2` });
  const none: ParsedWorkflow = { file, name: file, triggers: [], permissions: null, secrets: [], jobs: [], faults };
  if (first === undefined || faults.length > 0) return none;
  try {
    const top: unknown = first.toJS();
    if (!isObject(top)) return none;
    const jobs = isObject(top["jobs"]) ? Object.entries(top["jobs"]).map(([id, job]) => parsedJob(id, job)) : [];
    const secrets = secretsOf(top);
    if (jobs.some((job) => job.secrets.includes("inherit"))) secrets.add("inherit");
    return { file, name: optionalText(top["name"]) || file, triggers: triggersOf(top["on"]), permissions: permissionsOf(top), secrets: [...secrets], jobs, faults };
  } catch (error) {
    // The parser throws for too many aliases, and a deep value can stop the stack
    return { ...none, faults: [{ line: 1, column: 1, message: errorMessage(error) }] };
  }
}
