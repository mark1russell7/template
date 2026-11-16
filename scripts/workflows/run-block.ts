// The run block of a step of a workflow or an action, for the tests that start a step with bash.
import assert from "node:assert/strict";

/**
 * This function gives the first "run: |" block after a line of a workflow or an action. The block has no indent and ends
 * with one newline. The line is its full text, for example `"      - name: Build\n"`.
 */
export function runBlock(text: string, line: string): string {
  const start = text.indexOf(line);
  assert.ok(start >= 0, `The file has the line ${line.trim()}.`);
  const run = text.indexOf("run: |\n", start);
  assert.ok(run >= 0, `A run block follows ${line.trim()}.`);
  const lines = text.slice(run + "run: |\n".length).split("\n");
  const indent = /^ */u.exec(lines[0] ?? "")?.[0].length ?? 0;
  const block: string[] = [];
  for (const next of lines) {
    if (next.trim() !== "" && next.length - next.trimStart().length < indent) break;
    block.push(next.slice(indent));
  }
  return `${block.join("\n").trimEnd()}\n`;
}
