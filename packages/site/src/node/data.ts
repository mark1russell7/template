/**
 * The data of the site, at build time: the output of the CLI for each preset, and the shared workflows of the
 * repository. This module operates only in Node.js.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SiteData } from "../types.ts";
import { readWorkflow } from "@mark1russell7/conventions";
import { scaffoldData } from "./scaffold.ts";

/** The root folder of the repository, from the folder of this module. */
export const REPO_ROOT: string = fileURLToPath(new URL("../../../../", import.meta.url));

/** This function reads each shared workflow of the repository: `.github/workflows/reusable-*.yml`, in name order. */
export function readWorkflows(root: string = REPO_ROOT): SiteData["workflows"] {
  const dir = join(root, ".github", "workflows");
  return readdirSync(dir)
    .filter((file) => /^reusable-.+\.ya?ml$/.test(file))
    .sort()
    .map((file) => readWorkflow(file, readFileSync(join(dir, file), "utf8")));
}

/** This function makes all the data of the site. The build gives the commit and the date. */
export function siteData(build: SiteData["build"], root: string = REPO_ROOT): SiteData {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  return { scaffold: scaffoldData(manifest), workflows: readWorkflows(root), build };
}
