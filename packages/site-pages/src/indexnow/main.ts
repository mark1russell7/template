#!/usr/bin/env node
// The IndexNow step as a script with no install: `node packages/site-pages/src/indexnow/main.ts --site <url> --key <key>`.
// reusable-pages.yml starts it after the deploy, from the template commit of the workflow. It needs Node.js 22.18 or
// later, for the type stripping. The files of this folder import only Node.js and each other.
import { setTimeout } from "node:timers/promises";
import { runIndexNowCli } from "./indexnow.ts";

runIndexNowCli(process.argv.slice(2), {
  fetch: globalThis.fetch,
  sleep: async (ms) => {
    await setTimeout(ms);
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`site-pages indexnow: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  },
);
