#!/usr/bin/env node
// The bin `conventions`. The work is in run.ts, so a test can start the same CLI in a fixture folder.
import { readFileSync } from "node:fs";
import { runCli } from "./run.ts";

try {
  const args = process.argv.slice(2);
  // Only the git hook pre-push gives a standard input: the refs of the push. A terminal gives none
  const stdin = args[0] === "pre-push" && process.stdin.isTTY !== true ? readFileSync(0, "utf8") : undefined;
  process.exitCode = runCli(args, {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    ...(stdin === undefined ? {} : { stdin }),
  });
} catch (error) {
  process.stderr.write(`conventions: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
}
