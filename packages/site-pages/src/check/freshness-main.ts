#!/usr/bin/env node
// The freshness gate as a script with no install: `node packages/site-pages/src/check/freshness-main.ts --stamps <file>`.
// reusable-pages.yml starts it from the template commit of the workflow. It needs Node.js 22.18 or later, for the type stripping.
import { runFreshnessCli } from "./freshness.ts";

runFreshnessCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`site-pages freshness: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  },
);
