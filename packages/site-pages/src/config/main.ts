#!/usr/bin/env node
// The step of the action site-config, as a script with no install: `node packages/site-pages/src/config/main.ts`.
// The two Pages workflows start it from the template commit of the workflow. It needs Node.js 22.18 or later, for the
// type stripping. The files of this folder import only Node.js and each other.
//
// The environment: CONFIG_ROOT (the folder of the checkout), CONFIG_PATH (the path of the file in it), INPUTS (the
// inputs of the workflow as JSON, or empty), GITHUB_REPOSITORY and GITHUB_OUTPUT. The step writes the outputs config
// (one line of JSON) and source ("file" or "inputs").
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSiteConfig, SITE_CONFIG_PATH } from "./site-config.ts";

/** This function starts the step, and gives its exit code. */
export function runSiteConfigStep(env: NodeJS.ProcessEnv, log: (line: string) => void): number {
  const path = env["CONFIG_PATH"] || SITE_CONFIG_PATH;
  const full = join(env["CONFIG_ROOT"] || ".", path);
  let inputs: Record<string, unknown> | undefined;
  if (env["INPUTS"] !== undefined && env["INPUTS"] !== "") {
    try {
      inputs = JSON.parse(env["INPUTS"]) as Record<string, unknown>;
    } catch (error) {
      log(`::error::The inputs are not JSON: ${(error as Error).message}`);
      return 1;
    }
  }
  const result = resolveSiteConfig({
    file: existsSync(full) ? readFileSync(full, "utf8") : undefined,
    path,
    inputs,
    repository: env["GITHUB_REPOSITORY"] ?? "",
  });
  if ("error" in result) {
    log(`::error::${result.error}`);
    return 1;
  }
  log(result.source === "file" ? `The site config is ${path}.` : `The repository has no ${path}, so the site config is the inputs of the workflow.`);
  // JSON.stringify gives one line, because it escapes each line break of a value.
  appendFileSync(env["GITHUB_OUTPUT"] ?? "", `config=${JSON.stringify(result.config)}\nsource=${result.source}\n`);
  return 0;
}

// The script starts the step only when node starts this file, not when a test imports it.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = runSiteConfigStep(process.env, (line) => process.stdout.write(`${line}\n`));
}
