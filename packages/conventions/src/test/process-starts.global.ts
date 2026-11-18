// A global setup of vitest: it makes the folder where `process-starts.setup.ts` writes the count of each test file, and
// at the end it prints one line for each file, the most starts first. Thus a CI log shows where the starts come from.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    processStartsDir: string;
  }
}

/** The count of the process starts of one test file, by command. */
export interface FileStarts {
  readonly file: string;
  readonly counts: Readonly<Record<string, number>>;
}

/** This function gives the lines of the report: one line for each file, the most starts first, and a line of the sums. */
export function startsReport(rows: readonly FileStarts[]): string[] {
  const total = (row: FileStarts): number => Object.values(row.counts).reduce((sum, n) => sum + n, 0);
  const sums = new Map<string, number>();
  for (const row of rows) for (const [name, n] of Object.entries(row.counts)) sums.set(name, (sums.get(name) ?? 0) + n);
  const counts = (entries: Iterable<[string, number]>): string =>
    [...entries]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, n]) => `${name}=${n}`)
      .join(" ");
  const lines = [...rows].sort((a, b) => total(b) - total(a) || a.file.localeCompare(b.file)).map((row) => `process-starts ${total(row)} ${row.file} ${counts(Object.entries(row.counts))}`);
  lines.push(`process-starts ${rows.reduce((sum, row) => sum + total(row), 0)} (all ${rows.length} files) ${counts(sums)}`);
  return lines;
}

export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), "process-starts-"));
  project.provide("processStartsDir", dir);
  return () => {
    const rows = readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as FileStarts);
    rmSync(dir, { recursive: true, force: true });
    if (rows.length > 0) console.log(startsReport(rows).join("\n"));
  };
}
