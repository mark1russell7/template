#!/usr/bin/env node
// The check as a script with no install: `node packages/site-pages/src/check/main.ts --out <dir> ...`.
// The navigation crawl is `node packages/site-pages/src/check/main.ts nav --url <url> ...`.
// reusable-pages.yml starts it from the template commit of the workflow. It needs Node.js 22.18 or
// later, for the type stripping. The files of this folder import only Node.js and each other.
import { runCheckCli } from "./check.ts";
import { runNavCli } from "./nav.ts";

const argv = process.argv.slice(2);
(argv[0] === "nav" ? runNavCli : runCheckCli)(argv[0] === "nav" ? argv.slice(1) : argv, {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`site-pages check: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  },
);
