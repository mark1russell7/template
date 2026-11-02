/**
 * A small reader of GitHub workflow files, by the indent of the lines. The rules that read workflows share it. It
 * knows the block form and the inline values of keys, which is what the workflows of the template use.
 */

/** A workflow file. */
export const WORKFLOW: RegExp = /^\.github\/workflows\/[^/]+\.ya?ml$/;

export const indentOf = (line: string): number => line.length - line.trimStart().length;

/** This function gives the lines of a workflow, with each line of a comment made empty. */
export const workflowLines = (text: string): string[] => text.split(/\r?\n/).map((line) => (line.trimStart().startsWith("#") ? "" : line));

/** This function removes a comment at the end of a value, and the quotes around it. */
export function valueOf(raw: string): string {
  const comment = raw.indexOf(" #");
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
