// A global setup of vitest: it makes the folder where `process-starts.setup.ts` writes the count of each test file, and
// at the end it prints one line for each file, the most starts first. Thus a CI log shows where the starts come from.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FileStarts, startsReport } from "@mark1russell7/rigor-testkit/process-starts";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    processStartsDir: string;
  }
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
