#!/usr/bin/env node
// The site bar as a script with no install: `node packages/site-pages/src/bar/main.ts --out <dir> ...`.
// reusable-pages.yml starts it from the template commit of the workflow. It needs Node.js 22.18 or later, for the
// type stripping. The files of this folder import only Node.js, each other and ../render/html.ts.
import { runBarCli } from "./bar.ts";

try {
  process.exitCode = runBarCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
} catch (error) {
  process.stderr.write(`site-pages bar: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
}
