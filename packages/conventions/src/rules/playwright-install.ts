/**
 * The rule `playwright-install`: no workflow, action or site config installs the Playwright browsers with its own
 * command. The shared action `setup-playwright` of the template installs them from a cache, with a time limit and one
 * more try. A bare `playwright install --with-deps` waits for the package mirror with no limit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_CONFIG_PATH } from "@mark1russell7/site-pages/config";
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";
import { WORKFLOW } from "../workflow.ts";

/** The files of a composite action. */
const ACTION = /^\.github\/actions\/.+\/action\.ya?ml$/;

/** The folder of the action of the template itself. It is the one place with the install. */
const SHARED_ACTION = ".github/actions/setup-playwright/";

/**
 * A command of the Playwright CLI that installs: `install` or `install-deps`. The CLI comes first on the line, or after a
 * space or a shell operator. It can have a folder and a version, as in `node_modules/.bin/playwright` or
 * `playwright@1.64.1`. A name in quotes, for example in a message that a test looks for, is not a command.
 */
const INSTALL = /(?:^|[\s;&|(`])(?:[^\s"'`;&|()]*\/)?playwright(?:@[\w.^~-]+)?\s+(install(?:-deps)?)(?=$|[\s;&|)"'])/;

/** A hand-written install of the Playwright browsers on a line of a file. */
export interface PlaywrightInstall {
  /** The line, from 1. */
  readonly line: number;
  /** The command: `install` or `install-deps`. */
  readonly command: "install" | "install-deps";
}

/** This function gives each line of a workflow or an action that installs the Playwright browsers with its own command. It does not read a comment line. */
export function playwrightInstalls(text: string): PlaywrightInstall[] {
  const found: PlaywrightInstall[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trimStart().startsWith("#")) return;
    const match = INSTALL.exec(line);
    if (match === null) return;
    found.push({ line: index + 1, command: match[1] as PlaywrightInstall["command"] });
  });
  return found;
}

/** This function gives the install in the value `build` of a site config, with the line of the key, or undefined. */
export function siteConfigInstall(text: string): PlaywrightInstall | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // The rule roadmap-parses reports a file that is not JSON.
    return undefined;
  }
  const build = (data as { build?: unknown } | null)?.build;
  if (typeof build !== "string") return undefined;
  const match = build
    .split(/\r?\n/)
    .map((line) => INSTALL.exec(line))
    .find((each) => each !== null);
  if (match === undefined || match === null) return undefined;
  const line = text.split(/\r?\n/).findIndex((each) => /^\s*"build"\s*:/.test(each));
  return { line: line + 1, command: match[1] as PlaywrightInstall["command"] };
}

const FIX_STEP = "Use the action setup-playwright of the template, with the inputs browsers and command";
const FIX_SITE = 'Give "playwright-browsers" (and "playwright-command") in the site config, and remove the install from "build"';

export const playwrightInstall: Rule = {
  id: "playwright-install",
  title: "The Playwright browsers come from the shared action `setup-playwright`, not from an install in a workflow.",
  reason:
    "A bare `playwright install --with-deps` waits for the package mirror with no time limit and no cache. On 2026-11-11 the mirror of the runners did not resolve, and the browser jobs of client and lag stopped in apt until a restart.",
  fix: 'A job step uses `uses: mark1russell7/template/.github/actions/setup-playwright@<commit>` with `browsers` and `command`. The build of `reusable-pages.yml` gives `"playwright-browsers"` in `.github/site.json`, or the input of the same name.',
  sources: [
    { repo: "client", rule: "ci", doc: "run 43034026417 of main (2026-11-11): playwright install --with-deps failed two times on the package mirror, and the required check CI OK stayed red" },
    { repo: "lag", rule: "ci", doc: "lag #113 and #115 (2026-11-11): apt of playwright install --with-deps got about 20 kB/s from the mirror, and each job needed a restart" },
    { repo: "template", rule: "setup-playwright", doc: "template #315 (2026-11-11): the action survives a fault of the package mirror, with a cache, a time limit and the mode best-effort" },
  ],
  options: {},
  failsFrom: "2026-12-01",
  check(context) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const breaks: Break[] = [];
    const read = (file: string): string | undefined => {
      try {
        return readFileSync(join(context.root, file), "utf8");
      } catch {
        return undefined;
      }
    };
    for (const file of files.filter((path) => (WORKFLOW.test(path) || ACTION.test(path)) && !path.startsWith(SHARED_ACTION)).sort(byCode)) {
      const text = read(file);
      if (text === undefined) continue;
      for (const install of playwrightInstalls(text)) {
        breaks.push({
          file,
          line: install.line,
          message: `${file} starts "playwright ${install.command}" with its own command, with no cache and no time limit. ${FIX_STEP}, or the key playwright-browsers of the site config.`,
        });
      }
    }
    if (files.includes(SITE_CONFIG_PATH)) {
      const text = read(SITE_CONFIG_PATH);
      const install = text === undefined ? undefined : siteConfigInstall(text);
      if (install !== undefined) {
        breaks.push({
          file: SITE_CONFIG_PATH,
          line: install.line,
          message: `The build of ${SITE_CONFIG_PATH} starts "playwright ${install.command}", with no cache and no time limit. ${FIX_SITE}.`,
        });
      }
    }
    return breaks;
  },
};
