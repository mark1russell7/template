/**
 * The data of the site, at build time: the output of the CLI for each preset, and the shared workflows of the
 * repository. This module operates only in Node.js.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SiteData } from "../types.ts";
import { readAction, readWorkflow } from "@mark1russell7/conventions";
import { scaffoldData } from "./scaffold.ts";

/** The root folder of the repository, from the folder of this module. */
export const REPO_ROOT: string = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * This function reads each shared workflow of the repository (`.github/workflows/reusable-*.yml`) and then each
 * composite action (`.github/actions/<name>/action.yml`), in name order. The file of an action is
 * `actions/<name>/action.yml`, so the explorer can show the steps of the action and the inputs that they read.
 */
export function readWorkflows(root: string = REPO_ROOT): SiteData["workflows"] {
  const dir = join(root, ".github", "workflows");
  const workflows = readdirSync(dir)
    .filter((file) => /^reusable-.+\.ya?ml$/.test(file))
    .sort()
    .map((file) => readWorkflow(file, readFileSync(join(dir, file), "utf8")));
  const actions = join(root, ".github", "actions");
  const composites = readdirSync(actions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(actions, entry.name, "action.yml")))
    .map((entry) => entry.name)
    .sort()
    .map((name) => readAction(`actions/${name}/action.yml`, readFileSync(join(actions, name, "action.yml"), "utf8")))
    .filter((action) => action.jobs.length > 0);
  return [...workflows, ...composites];
}

/** This function makes all the data of the site. The build gives the commit and the date. */
export function siteData(build: SiteData["build"], root: string = REPO_ROOT): SiteData {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  return { scaffold: scaffoldData(manifest), workflows: readWorkflows(root), build };
}
