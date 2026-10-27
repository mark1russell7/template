#!/usr/bin/env node
// The bin `conventions`. The work is in run.ts, so a test can start the same CLI in a fixture folder.
import { runCli } from "./run.ts";

try {
  process.exitCode = runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
} catch (error) {
  process.stderr.write(`conventions: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
}
