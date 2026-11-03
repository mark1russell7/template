#!/usr/bin/env node
// The bin `site-pages`. The work is in build.ts and check/check.ts, so a test can run the same CLI with its own fetch.
import { runCli } from "./build.ts";
import { runCheckCli } from "./check/check.ts";

const argv = process.argv.slice(2);
const io = {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text),
};
(argv[0] === "check" ? runCheckCli(argv.slice(1), io) : runCli(argv, io)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`site-pages: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  },
);
