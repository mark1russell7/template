/**
 * The standalone reference page: each export of each package, with its doc comment and its declaration.
 * The build renders the HTML from `reference.json`, and one small inline module adds the filter of the names.
 */

import type { ReferenceDeclaration, ReferenceFile, ReferenceName, ReferencePackage } from "../data/types.ts";
import { escapeHtml, inlineMarkdown, listText, plural } from "./html.ts";
import { pageShell, type PageOptions } from "./theme.ts";

/** The first keyword of a declaration, after the words `export`, `default` and `declare`. */
const HEAD = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(abstract\s+class|const\s+enum|function|class|interface|type|enum|namespace|module|const|let|var)\b/;

/** The word of a keyword that is not the word of the page. */
const KIND_WORDS: Readonly<Record<string, string>> = { "abstract class": "class", "const enum": "enum", module: "namespace", const: "constant", let: "variable", var: "variable" };

/**
 * This function gives the kind of a declaration from its first keyword: `function`, `class`, `interface`,
 * `type`, `enum`, `namespace`, `constant` or `variable`. A different text gives `declaration`.
 */
export function declarationKind(text: string): string {
  const head = HEAD.exec(text.trimStart())?.[1];
  if (head === undefined) return "declaration";
  const word = head.replace(/\s+/g, " ");
  return KIND_WORDS[word] ?? word;
}

/** The labels of the block tags of a doc comment. A tag that is not in this list shows with its name. */
const TAG_LABELS: Readonly<Record<string, string>> = {
  param: "Parameter",
  typeParam: "Type parameter",
  template: "Type parameter",
  returns: "Returns",
  return: "Returns",
  throws: "Throws",
  example: "Example",
  remarks: "Remarks",
  see: "See also",
  defaultValue: "Default",
  default: "Default",
  deprecated: "Deprecated",
};

/** The tags for the authors of the code. The page does not show them, also when they have text. */
const HIDDEN_TAGS: ReadonlySet<string> = new Set(["internal", "privateRemarks", "hidden"]);

/** The tags with a name before their text. */
const NAMED_TAGS: ReadonlySet<string> = new Set(["param", "typeParam", "template"]);

/** A function that gives the anchor of a name, or undefined when the page has no article of the name. */
export type AnchorOf = (name: string) => string | undefined;

/** This function replaces each inline tag `{@link target}` or `{@link target | text}` with Markdown. */
function inlineTags(text: string, anchorOf: AnchorOf): string {
  return text.replace(/\{@(?:link|linkcode|linkplain)\s+([^\s|}]+)(?:\s*\|\s*|\s+)?([^}]*)\}/g, (_all, target: string, label: string) => {
    const shown = label.trim() === "" ? target : label.trim();
    if (/^https?:\/\//i.test(target)) return `[${shown}](${target})`;
    const anchor = anchorOf(target);
    const code = shown === target ? `\`${shown}\`` : shown;
    return anchor === undefined ? `\`${shown}\`` : `[${code}](#${anchor})`;
  });
}

/** This function gives the HTML of an inline text of a doc comment. */
function inline(text: string, anchorOf: AnchorOf): string {
  return inlineMarkdown(inlineTags(text, anchorOf));
}

/** This function gives the mark of a code fence at the start of a line, or undefined. */
function fenceOf(line: string): string | undefined {
  return /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
}

/** This function gives the HTML of a code block. */
function codeBlock(lines: readonly string[]): string {
  return `<pre class="sp-ref-code"><code>${escapeHtml(lines.join("\n"))}</code></pre>`;
}

/** This function renders lines of a doc comment as HTML: paragraphs, lists and code fences. */
function prose(lines: readonly string[], anchorOf: AnchorOf): string {
  let html = "";
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  let fence = "";
  const flush = (): void => {
    if (paragraph.length > 0) html += `<p>${inline(paragraph.join(" "), anchorOf)}</p>`;
    if (list.length > 0) html += `<ul>${list.map((item) => `<li>${inline(item, anchorOf)}</li>`).join("")}</ul>`;
    paragraph = [];
    list = [];
  };
  for (const line of lines) {
    const mark = fenceOf(line);
    if (code !== null) {
      if (mark !== undefined && mark[0] === fence[0] && mark.length >= fence.length && line.trim() === mark) {
        html += codeBlock(code);
        code = null;
      } else code.push(line);
      continue;
    }
    if (mark !== undefined) {
      flush();
      code = [];
      fence = mark;
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line)?.[1];
    if (item !== undefined) {
      if (paragraph.length > 0) {
        html += `<p>${inline(paragraph.join(" "), anchorOf)}</p>`;
        paragraph = [];
      }
      list.push(item);
    } else if (list.length > 0 && /^\s/.test(line)) list[list.length - 1] += ` ${line.trim()}`;
    else {
      if (list.length > 0) flush();
      paragraph.push(line.trim());
    }
  }
  if (code !== null) html += codeBlock(code);
  flush();
  return html;
}

/** One block of a doc comment: the text before the first tag, or one block tag with its lines. */
interface DocBlock {
  readonly tag: string | null;
  readonly lines: string[];
}

/** This function splits a doc comment into its blocks. A tag in a code fence is not a block tag. */
function docBlocks(doc: string): DocBlock[] {
  const blocks: DocBlock[] = [{ tag: null, lines: [] }];
  let fence: string | null = null;
  for (const line of doc.replace(/\r\n/g, "\n").split("\n")) {
    const mark = fenceOf(line);
    if (fence === null) {
      const tag = /^\s*@(\w+)\s?(.*)$/.exec(line);
      if (tag !== null) {
        blocks.push({ tag: tag[1] ?? "", lines: (tag[2] ?? "").trim() === "" ? [] : [tag[2] ?? ""] });
        continue;
      }
      if (mark !== undefined) fence = mark;
    } else if (mark !== undefined && mark[0] === fence[0] && mark.length >= fence.length) fence = null;
    blocks[blocks.length - 1]?.lines.push(line);
  }
  return blocks;
}

/** This function renders one block tag as a term and its description. A hidden tag or a tag without text gives no HTML. */
function tagHtml(block: DocBlock, anchorOf: AnchorOf): string {
  const tag = block.tag ?? "";
  if (HIDDEN_TAGS.has(tag) || block.lines.every((line) => line.trim() === "")) return "";
  let label = escapeHtml(TAG_LABELS[tag] ?? `@${tag}`);
  let lines = block.lines;
  if (NAMED_TAGS.has(tag)) {
    const named = /^\s*(\S+)\s*(?:-\s*)?(.*)$/.exec(lines[0] ?? "");
    if (named !== null) {
      label += ` <code>${escapeHtml(named[1] ?? "")}</code>`;
      lines = [named[2] ?? "", ...lines.slice(1)];
    }
  }
  const body = tag === "example" && !lines.some((line) => fenceOf(line) !== undefined) ? codeBlock(trimBlank(lines)) : prose(lines, anchorOf);
  return `<div${tag === "deprecated" ? ' class="sp-ref-deprecated"' : ""}><dt>${label}</dt><dd>${body}</dd></div>`;
}

/** This function removes the blank lines at the two ends of a list of lines. */
function trimBlank(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start++;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * This function renders the text of a doc comment as HTML. The text before the first tag gives paragraphs,
 * lists and code blocks. Each block tag, for example `@param`, gives a term and its description. A tag
 * `{@link name}` links to the article of the name when the page has it.
 */
export function renderDoc(doc: string, anchorOf: AnchorOf = () => undefined): string {
  const [main, ...tags] = docBlocks(doc);
  const tagParts = tags.map((block) => tagHtml(block, anchorOf)).filter((part) => part !== "");
  return prose(main?.lines ?? [], anchorOf) + (tagParts.length > 0 ? `<dl class="sp-ref-tags">${tagParts.join("")}</dl>` : "");
}

/** This function gives the import path of an entry: `pkg` for `.`, and `pkg/svg` for `./svg`. */
function importPath(packageName: string, subpath: string): string {
  return subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`;
}

/** This function gives the text of an anchor: the characters that are not safe in a URL become `-`. */
function anchorText(text: string): string {
  return text.replace(/[^\w$.-]+/g, "-");
}

/** The anchors of the articles of one package. The first article of each key has the anchor. */
interface Anchors {
  /** The anchor of each key. */
  readonly byKey: Map<string, string>;
  /** The anchor of each name, from the first article of the name. */
  readonly byName: Map<string, string>;
}

/** This function gives the anchors of the articles of a package. Two names with one anchor text get a number. */
function anchorsOf(model: ReferencePackage, prefix: string, used: Set<string>): Anchors {
  const byKey = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const entry of model.entries) {
    for (const item of entry.names) {
      if (byKey.has(item.key)) continue;
      const base = `${prefix}${anchorText(item.name)}`;
      let anchor = base;
      for (let n = 2; used.has(anchor); n++) anchor = `${base}-${n}`;
      used.add(anchor);
      byKey.set(item.key, anchor);
      if (!byName.has(item.name)) byName.set(item.name, anchor);
    }
  }
  return { byKey, byName };
}

/** This function gives the note of a name without a declaration: an external name or a namespace. */
function noteOf(item: ReferenceName): string {
  if (item.kind === "external") {
    const from = item.key.slice(0, item.key.lastIndexOf("#"));
    return `<p>The entry exports this name of the package <code>${escapeHtml(from)}</code>.</p>`;
  }
  if (item.kind === "namespace") return "<p>A namespace of the entry. The names of its members start with its name.</p>";
  return "";
}

/** This function gives the article of one name. */
function article(item: ReferenceName, declaration: ReferenceDeclaration | undefined, anchor: string, anchorOf: AnchorOf): string {
  const kind = item.kind === "declaration" ? declarationKind(declaration?.text ?? "") : item.kind;
  const pills = `<span class="sp-pill">${escapeHtml(kind)}</span>${item.isType ? ' <span class="sp-pill">type only</span>' : ""}`;
  const doc = declaration?.doc === undefined ? "" : `<div class="sp-ref-doc">${renderDoc(declaration.doc, anchorOf)}</div>`;
  const code = declaration === undefined ? noteOf(item) : codeBlock([declaration.text]);
  return (
    `<article class="sp-ref-item" id="${escapeHtml(anchor)}" data-sp-name="${escapeHtml(item.name.toLowerCase())}">` +
    `<h4><a href="#${escapeHtml(anchor)}">${escapeHtml(item.name)}</a> ${pills}</h4>${doc}${code}</article>`
  );
}

/** This function gives the section of one package: a section of each entry, with an article of each name. */
function packageSection(model: ReferencePackage, anchors: Anchors): string {
  const anchorOf: AnchorOf = (name) => anchors.byName.get(name);
  const shown = new Set<string>();
  const entries = model.entries.map((entry) => {
    const path = importPath(model.packageName, entry.subpath);
    const articles: string[] = [];
    const again: string[] = [];
    for (const item of entry.names) {
      const anchor = anchors.byKey.get(item.key) ?? "";
      if (shown.has(item.key)) again.push(`<a href="#${escapeHtml(anchor)}"><code>${escapeHtml(item.name)}</code></a>`);
      else {
        shown.add(item.key);
        articles.push(article(item, Object.hasOwn(model.declarations, item.key) ? model.declarations[item.key] : undefined, anchor, anchorOf));
      }
    }
    const index = entry.names.length > 1
      ? `<ul class="sp-ref-index" data-sp-index aria-label="${escapeHtml(`The names of ${path}`)}">${entry.names.map((item) => `<li><a href="#${escapeHtml(anchors.byKey.get(item.key) ?? "")}">${escapeHtml(item.name)}</a></li>`).join("")}</ul>`
      : "";
    const none = entry.names.length === 0 ? '<p class="sp-muted">This entry has no declaration file.</p>' : "";
    const also = again.length === 0 ? "" : `<p class="sp-ref-also" data-sp-index>The entry also exports ${listText(again)}. An earlier entry shows ${again.length === 1 ? "its declaration" : "their declarations"}.</p>`;
    return (
      `<section class="sp-ref-entry" data-sp-group><h3><code>${escapeHtml(path)}</code> <span class="sp-count">${escapeHtml(plural(entry.names.length, "name"))}</span></h3>` +
      `${index}${none}${articles.join("")}${also}</section>`
    );
  });
  return `<section class="sp-ref-package" data-sp-group><h2>${escapeHtml(model.packageName)}</h2>${entries.join("")}</section>`;
}

/** This function gives the lead line of the reference page: the counts of the exports and of the doc comments. */
export function referenceLead(file: ReferenceFile): string {
  const keys = file.packages.flatMap((model) => [...new Set(model.entries.flatMap((entry) => entry.names.map((item) => item.key)))].map((key) => model.declarations[key]));
  const documented = keys.filter((declaration) => declaration?.doc !== undefined).length;
  const entries = file.packages.reduce((sum, model) => sum + model.entries.length, 0);
  const names = listText(file.packages.map((model) => model.packageName));
  return `${plural(keys.length, "export")} in ${plural(entries, "entry point")} of ${names}. ${documented} of them have a doc comment.`;
}

/** The ES module of the filter of the names. */
export const REFERENCE_SCRIPT: string = String.raw`
const input = document.getElementById("sp-ref-filter");
const count = document.querySelector("[data-sp-count]");
const items = Array.from(document.querySelectorAll("[data-sp-name]"));
const groups = Array.from(document.querySelectorAll("[data-sp-group]"));
const indexes = Array.from(document.querySelectorAll("[data-sp-index]"));
const show = () => {
  const query = input.value.trim().toLowerCase();
  let shown = 0;
  for (const item of items) {
    const hit = query === "" || item.dataset.spName.includes(query);
    item.hidden = !hit;
    if (hit) shown++;
  }
  for (const group of groups) group.hidden = query !== "" && !group.querySelector("[data-sp-name]:not([hidden])");
  for (const index of indexes) index.hidden = query !== "";
  count.textContent = query === "" ? items.length + " exports" : shown + " of " + items.length + " exports";
};
if (input && count) {
  input.addEventListener("input", show);
  show();
}
`;

/**
 * This function renders the reference page of the packages of `reference.json`. Each declaration shows one
 * time, in the first entry that exports it. A later entry links to it.
 */
export function renderReferencePage(file: ReferenceFile, options: PageOptions): string {
  const used = new Set<string>();
  const many = file.packages.length > 1;
  const sections = file.packages.map((model) => packageSection(model, anchorsOf(model, many ? `${anchorText(model.packageName)}--` : "", used)));
  const lead = referenceLead(file);
  const filter =
    '<div class="sp-filters" data-sp-js><label class="sp-ref-filter" for="sp-ref-filter">Filter the names</label>' +
    '<input class="sp-ref-input" id="sp-ref-filter" type="search" autocomplete="off" spellcheck="false"><span class="sp-count" aria-live="polite" data-sp-count></span></div>';
  const source =
    '<p class="sp-small sp-muted">Source: the built declaration files and their doc comments, read by <code>api-report model</code> when the site was built.</p>';
  return pageShell(
    {
      title: "Reference",
      description: lead,
      current: "reference",
      main: `<h1>Reference</h1><p class="sp-lead">${escapeHtml(lead)}</p>${filter}${sections.join("")}${source}`,
      script: REFERENCE_SCRIPT,
    },
    options,
  );
}
