#!/usr/bin/env node
// The scroll cue as a script with no install: `node packages/site-pages/src/bar/cue-main.ts --out <dir>`.
// reusable-pages.yml starts it from the template commit of the workflow. It needs Node.js 22.18 or later, for the
// type stripping. It reads packages/site-pages/styles/scroll-cue.css of the same commit.
import { runCueCli } from "./cue.ts";

try {
  process.exitCode = runCueCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
} catch (error) {
  process.stderr.write(`site-pages cue: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
}
