/**
 * The rule `push-main-only`: a workflow that starts on `push` and on `pull_request` limits `push` to the default branch.
 * It also has `workflow_dispatch`. Then a commit of a branch with an open pull request starts one run, not two. A person
 * can still start a run on a branch with no pull request.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import type { Break, Rule, RuleContext } from "../rule.ts";
import { WORKFLOW, applySplices, blockEnd, childIndent, childKeys, indentOf, keyValue, valueOf, workflowLines, type Splice } from "../workflow.ts";
import { listItems } from "./gate-trigger.ts";

/** The file of the release flow. A person changes it, with the rule `release-files`, so the fix does not write it. */
const RELEASE_FILE = "release.yml";

/** The patterns that match each branch. */
const EACH_BRANCH: ReadonlySet<string> = new Set(["*", "**"]);

/** A key of a block, in the quoted forms too. */
const KEY = /^\s*(?:"([^"]*)"|'([^']*)'|([^\s:]+))\s*:(\s.*)?$/;

/** A value with no filters: `{}`, `~` or `null`. */
const NO_FILTERS = /^(\{\s*\}|~|null)$/;

/** A text that shows that a workflow reads the tag of a run. */
const READS_TAGS = /refs\/tags|ref_type/i;

/** A workflow of the repository that a job calls. */
const LOCAL_CALL = /uses:\s*["']?\.\/(\.github\/workflows\/[^\s"'@]+)/g;

/** A text that names a branch: `refs/heads/<branch>`, or `ref_name == '<branch>'`. */
const NAMED_BRANCH = /refs\/heads\/([\w./-]+)|ref_name\s*[!=]=\s*["']([^"']+)["']/gi;

/** A trigger of a workflow: its name, the index of its line, and the text after its key. */
interface Trigger {
  readonly name: string;
  readonly at: number;
  readonly value: string;
}

/** The triggers of a workflow, with the form of `on`: a key on each line, a block list, `on: [a, b]`, or `on: { a: ... }`. */
interface Triggers {
  readonly form: "keys" | "items" | "flow" | "map";
  readonly on: number;
  /** The index after the last line of a flow value. */
  readonly end: number;
  readonly list: readonly Trigger[];
}

/** A filter of a trigger: its key, its lines and its values. The values are undefined when the rule cannot read them. */
interface Filter {
  readonly key: string;
  readonly at: number;
  readonly end: number;
  readonly items: readonly string[] | undefined;
}

/** The branches that the rule accepts, and the text of the workflows that a workflow calls. */
interface Facts {
  readonly branch: string;
  readonly more: readonly string[];
  readonly called: (text: string) => string;
}

/** A break of a workflow. */
interface Finding {
  readonly lines: readonly string[];
  readonly triggers: Triggers;
  readonly push: Trigger;
  readonly filters: readonly Filter[];
  /** The value `true` tells that `push` starts on more branches than the rule accepts. */
  readonly wide: boolean;
  /** The value `true` tells that the workflow has no `workflow_dispatch`. */
  readonly noDispatch: boolean;
}

/** This function tells if the brackets of a flow value are closed. */
function closed(text: string): boolean {
  let depth = 0;
  let quote = "";
  for (const char of text) {
    if (quote !== "") {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
  }
  return depth <= 0;
}

/** This function gives the whole text of a flow value that starts on the line `index`, and the index after its last line. */
function flowValue(lines: readonly string[], index: number, value: string): { text: string; end: number } {
  let text = value;
  let end = index + 1;
  while (!closed(text) && end < lines.length) {
    text += ` ${valueOf(lines[end] ?? "")}`;
    end += 1;
  }
  return { text, end };
}

/** This function splits the text in the outer brackets of a flow value, at each comma of the first level. */
function flowParts(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let part = "";
  for (const char of text.slice(1, -1)) {
    if (quote !== "") {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(part);
      part = "";
      continue;
    }
    part += char;
  }
  parts.push(part);
  return parts.map((item) => item.trim()).filter((item) => item !== "");
}

/** This function gives the key and the value of an entry of a flow map. */
function flowEntry(part: string): { key: string; value: string } {
  const colon = part.search(/:(\s|$)/);
  return colon < 0 ? { key: valueOf(part), value: "" } : { key: valueOf(part.slice(0, colon)), value: valueOf(part.slice(colon + 1)) };
}

/** This function gives the key and the value of a line of a block. */
function keyOf(line: string): { key: string; value: string } | undefined {
  const found = KEY.exec(line);
  if (found === null) return undefined;
  return { key: found[1] ?? found[2] ?? found[3] ?? "", value: valueOf(found[4] ?? "") };
}

const isItem = (line: string): boolean => line.trimStart().startsWith("- ");

/** This function reads the triggers of a workflow, in each form of `on`. */
function readTriggers(lines: readonly string[]): Triggers | undefined {
  const on = lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, "on") !== undefined);
  if (on < 0) return undefined;
  const value = keyValue(lines[on] ?? "", "on") ?? "";
  if (value === "") {
    const next = lines.findIndex((line, index) => index > on && line.trim() !== "");
    const first = lines[next] ?? "";
    if (next >= 0 && isItem(first)) {
      const list: Trigger[] = [];
      for (let index = next; index < lines.length; index++) {
        const line = lines[index] ?? "";
        if (line.trim() === "") continue;
        if (!isItem(line) || indentOf(line) !== indentOf(first)) break;
        list.push({ name: valueOf(line.trimStart().slice(2)), at: index, value: "" });
      }
      return { form: "items", on, end: on + 1, list };
    }
    const list = childKeys(lines, on).flatMap((at) => {
      const entry = keyOf(lines[at] ?? "");
      return entry === undefined ? [] : [{ name: entry.key, at, value: entry.value }];
    });
    return { form: "keys", on, end: on + 1, list };
  }
  const flow = flowValue(lines, on, value);
  if (value.startsWith("[")) return { form: "flow", on, end: flow.end, list: flowParts(flow.text).map((part) => ({ name: valueOf(part), at: on, value: "" })) };
  if (value.startsWith("{")) {
    const list = flowParts(flow.text).map((part) => {
      const entry = flowEntry(part);
      return { name: entry.key, at: on, value: entry.value };
    });
    return { form: "map", on, end: flow.end, list };
  }
  return { form: "flow", on, end: on + 1, list: [{ name: value, at: on, value: "" }] };
}

/** This function gives the filters of a trigger, in the block form and in the flow form. */
function filtersOf(lines: readonly string[], trigger: Trigger): Filter[] {
  if (trigger.value.startsWith("{")) {
    const flow = flowValue(lines, trigger.at, trigger.value);
    return flowParts(flow.text).map((part) => {
      const entry = flowEntry(part);
      const items = entry.value.startsWith("[") ? flowParts(entry.value).map(valueOf) : [entry.value];
      return { key: entry.key, at: trigger.at, end: flow.end, items };
    });
  }
  if (trigger.value !== "") return [];
  return childKeys(lines, trigger.at).flatMap((at) => {
    const entry = keyOf(lines[at] ?? "");
    if (entry === undefined) return [];
    const list = listItems(lines, at, entry.value);
    if (list !== undefined) return [{ key: entry.key, at, end: list.end, items: list.items }];
    return [{ key: entry.key, at, end: at + 1, items: /^[[{]/.test(entry.value) ? undefined : [entry.value] }];
  });
}

/** This function gives the break of a workflow, or undefined when the rule leaves the workflow alone. */
function findBreak(text: string, facts: Facts): Finding | undefined {
  const lines = workflowLines(text);
  const triggers = readTriggers(lines);
  if (triggers === undefined) return undefined;
  const push = triggers.list.find((trigger) => trigger.name === "push");
  const pull = triggers.list.find((trigger) => trigger.name === "pull_request");
  if (push === undefined || pull === undefined) return undefined;
  // A pull request trigger that does not start on a new commit does not run the commit two times
  const types = filtersOf(lines, pull).find((filter) => filter.key === "types");
  if (types?.items !== undefined && !types.items.includes("synchronize")) return undefined;
  const filters = filtersOf(lines, push);
  const has = (key: string): Filter | undefined => filters.find((filter) => filter.key === key);
  const branches = has("branches");
  // With only a tag filter, GitHub starts the workflow on tags and on no branch
  if (branches === undefined && has("branches-ignore") === undefined && (has("tags") ?? has("tags-ignore")) !== undefined) return undefined;
  const allowed = [facts.branch, ...facts.more];
  const items = branches?.items;
  const wide = items === undefined || items.length === 0 || !items.every((item) => allowed.includes(item));
  const noDispatch = !triggers.list.some((trigger) => trigger.name === "workflow_dispatch");
  if (!wide && !noDispatch) return undefined;
  return { lines, triggers, push, filters, wide, noDispatch };
}

/** This function gives the reason why a person must change the workflow, or undefined when the fix can write it. */
function refusal(file: string, text: string, finding: Finding, facts: Facts): string | undefined {
  if (file.slice(file.lastIndexOf("/") + 1) === RELEASE_FILE) return `${RELEASE_FILE} belongs to the release flow`;
  const { triggers, filters, wide } = finding;
  if (triggers.form === "map") return "on has the flow form of a map";
  if (triggers.end > triggers.on + 1) return "on is a flow value of more than one line";
  if (!wide) return undefined;
  if (filters.some((filter) => filter.key === "branches-ignore")) return "on.push has branches-ignore, and only a person can tell which ignored branches stay";
  const allowed = [facts.branch, ...facts.more];
  const branches = filters.find((filter) => filter.key === "branches");
  if (branches !== undefined) {
    if (branches.items === undefined) return "the rule cannot read on.push.branches";
    if (branches.at === finding.push.at) return "on.push.branches is in the flow form of a map";
    const named = branches.items.filter((item) => !EACH_BRANCH.has(item) && !allowed.includes(item));
    if (named.length > 0 || branches.items.length === 0) return `on.push.branches names ${named.join(", ") || "no branch"}. Remove them, or add them to the option branches of the rule`;
  }
  const others = [...`${workflowLines(text).join("\n")}\n${facts.called(text)}`.matchAll(NAMED_BRANCH)].map((match) => match[1] ?? match[2] ?? "").filter((name) => !allowed.includes(name));
  if (others.length > 0) return `the workflow reads the branch ${[...new Set(others)].join(", ")}, so a limit on push can stop a job`;
  return undefined;
}

/** This function gives a comment at the end of a line, with its space, or an empty text. */
const commentOf = (line: string): string => /\s+#.*$/.exec(line)?.[0] ?? "";

/** This function writes the fix of a break: the new filter of `push`, and `workflow_dispatch`. Each other line stays. */
function convert(text: string, file: string, finding: Finding, facts: Facts): string {
  const { lines, triggers, push, filters, wide, noDispatch } = finding;
  const original = text.split(/\r?\n/);
  const branches = filters.find((filter) => filter.key === "branches");
  // A push with no branch filter also starts on tags. A workflow that reads the tag keeps that start
  const tags = wide && branches === undefined && READS_TAGS.test(`${workflowLines(text).join("\n")}\n${facts.called(text)}`);
  const limit = `branches: [${facts.branch}]`;
  const limits = (pad: string): string[] => (wide ? [`${pad}${limit}`, ...(tags ? [`${pad}tags: ["**"]`] : [])] : []);
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dispatch = (pad: string): string[] => (noDispatch ? [`${pad}# A person starts a run on a branch with no pull request: gh workflow run ${name} --ref <branch>`, `${pad}workflow_dispatch:`] : []);
  const splices: Splice[] = [];

  if (triggers.form === "flow") {
    const line = original[triggers.on] ?? "";
    const body = triggers.list.flatMap((trigger) => [`  ${trigger.name}:`, ...(trigger === push ? limits("    ") : [])]);
    splices.push({ at: triggers.on, remove: 1, insert: [`${line.slice(0, line.indexOf(":") + 1)}${commentOf(line)}`, ...body, ...dispatch("  ")] });
  } else if (triggers.form === "items") {
    const pad = " ".repeat(Math.max(indentOf(lines[triggers.list[0]?.at ?? 0] ?? ""), 2));
    for (const trigger of triggers.list) {
      splices.push({ at: trigger.at, remove: 1, insert: [`${pad}${trigger.name}:${commentOf(original[trigger.at] ?? "")}`, ...(trigger === push ? limits(`${pad}  `) : [])] });
    }
    splices.push({ at: (triggers.list.at(-1)?.at ?? triggers.on) + 1, remove: 0, insert: dispatch(pad) });
  } else {
    const line = original[push.at] ?? "";
    const pad = indentOf(lines[push.at] ?? "");
    const inner = " ".repeat(childIndent(lines, push.at) ?? pad + Math.max(pad - indentOf(lines[triggers.on] ?? ""), 2));
    if (wide && branches !== undefined) {
      splices.push({ at: branches.at, remove: branches.end - branches.at, insert: [`${" ".repeat(indentOf(lines[branches.at] ?? ""))}${limit}${commentOf(original[branches.at] ?? "")}`] });
    } else if (wide && push.value !== "" && !NO_FILTERS.test(push.value)) {
      const added = [limit, ...(tags ? ['tags: ["**"]'] : [])].join(", ");
      splices.push({ at: push.at, remove: 1, insert: [line.replace(/\{\s*/, () => `{ ${added}, `)] });
    } else if (wide) {
      splices.push({ at: push.at, remove: 1, insert: [line.replace(/:\s+(\{\s*\}|~|null)/, ":"), ...limits(inner)] });
    }
    const last = triggers.list.at(-1)?.at ?? triggers.on;
    let end = blockEnd(lines, last);
    while (end > last + 1 && (lines[end - 1] ?? "").trim() === "") end -= 1;
    splices.push({ at: end, remove: 0, insert: dispatch(" ".repeat(pad)) });
  }
  return applySplices(text, splices);
}

/** This function gives the default branch: the event file of GitHub Actions, the `HEAD` of the remote, or else `main`. */
export function defaultBranch(context: RuleContext): string {
  const file = context.env["GITHUB_EVENT_PATH"];
  if (file !== undefined && file !== "") {
    try {
      const branch = (JSON.parse(readFileSync(file, "utf8")) as { repository?: { default_branch?: unknown } }).repository?.default_branch;
      if (typeof branch === "string" && branch !== "") return branch;
    } catch {
      // A missing or a wrong event file gives the next source
    }
  }
  const head = context.git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])?.trim();
  return head === undefined || head === "" ? "main" : head.replace(/^origin\//, "");
}

export const pushMainOnly: Rule = {
  id: "push-main-only",
  title: "A workflow that starts on push and on pull_request limits push to the default branch with branches, and has workflow_dispatch.",
  reason:
    "A commit on a branch with an open pull request starts such a workflow two times: one run for push and one run for pull_request. On 2026-11-04 the CI queue held about 263 jobs, and a rough estimate puts about 65 of them in such second runs. The run for pull_request gives the required checks, so the run for push adds nothing. With workflow_dispatch, a person can still start a run on a branch with no pull request.",
  fix: 'Add `branches: [<default branch>]` under `on.push`, and add `workflow_dispatch:` under `on` (CI.md, "One run for each commit"). A push with only a tag filter, or a pull request trigger with no `synchronize`, is not a break. For a long-lived branch, add the branch to the option branches.',
  sources: [
    { repo: "template", rule: "push-main-only", doc: ".github/workflows/security.yml (push has branches: [main], and the file has workflow_dispatch)" },
    { repo: "crawler", rule: "push-main-only", doc: ".github/workflows/ci.yml (push has branches: [main], and the file has workflow_dispatch)" },
    { repo: "systems", rule: "push-main-only", doc: ".github/workflows/process.yml (push has branches: [main], and the file has workflow_dispatch)" },
  ],
  options: {
    branches: { type: "strings", default: [], description: "More branches that `on.push.branches` can name, for example a long-lived release branch." },
  },
  check(context, options) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const workflows = files.filter((path) => WORKFLOW.test(path)).sort(byCode);
    if (workflows.length === 0) return { skipped: "the repository has no workflow" };
    const read = (file: string): string => {
      try {
        return readFileSync(join(context.root, file), "utf8");
      } catch {
        return "";
      }
    };
    const facts: Facts = {
      branch: defaultBranch(context),
      more: Array.isArray(options["branches"]) ? (options["branches"] as readonly string[]) : [],
      called: (text) => [...text.matchAll(LOCAL_CALL)].map((match) => workflowLines(read(match[1] ?? "")).join("\n")).join("\n"),
    };
    const breaks: Break[] = [];
    for (const file of workflows) {
      const text = read(file);
      const finding = findBreak(text, facts);
      if (finding === undefined) continue;
      const parts = [
        ...(finding.wide ? [`push starts on more branches than ${[facts.branch, ...facts.more].join(", ")}, so a commit of a pull request starts it two times`] : []),
        ...(finding.noDispatch ? ["it has no workflow_dispatch, so a person cannot start a run on a branch"] : []),
      ];
      const reason = refusal(file, text, finding, facts);
      const after = reason === undefined ? convert(text, file, finding, facts) : undefined;
      breaks.push({
        file,
        line: finding.push.at + 1,
        message: `${file} starts on push and on pull_request: ${parts.join(", and ")}.`,
        ...(after !== undefined && findBreak(after, facts) === undefined ? { edits: [{ file, before: text, after }] } : { fix: `A person must change it, because ${reason ?? "the fix does not end the break"}. ${pushMainOnly.fix}` }),
      });
    }
    return breaks;
  },
};
