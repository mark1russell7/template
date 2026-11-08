/**
 * The rule `setup-cue`: no workflow or action downloads the cue CLI with its own command. The shared action `setup-cue`
 * of the template installs it from a cache, or with retries and a sha256 check. A download of a release asset from
 * GitHub fails at times with a 504, and a bare `curl` then fails the job.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";
import { WORKFLOW } from "../workflow.ts";

/** The files of a composite action. */
const ACTION = /^\.github\/actions\/.+\/action\.ya?ml$/;

/** The action of the template itself. It is the one place with the download. */
const SHARED_ACTION = ".github/actions/setup-cue/action.yml";

/** A hand-written install of the cue CLI: a download of a release asset, or a build with `go install`. */
const DOWNLOAD = /github\.com\/cue-lang\/cue\/releases\/download\/(v[0-9][^/\s"']*)\/|cuelang\.org\/go\/cmd\/cue@(v?[0-9][^\s"']*|latest)/;

/** A hand-written install of the cue CLI on a line of a file. */
export interface CueDownload {
  /** The line, from 1. */
  readonly line: number;
  /** The version of the cue CLI, or undefined when the line does not name one. */
  readonly version: string | undefined;
}

/** This function gives each line of a file that installs the cue CLI with its own command. It does not read a comment line. */
export function cueDownloads(text: string): CueDownload[] {
  const found: CueDownload[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trimStart().startsWith("#")) return;
    const match = DOWNLOAD.exec(line);
    if (match === null) return;
    const version = match[1] ?? match[2];
    found.push({ line: index + 1, version: version === undefined || version === "latest" ? undefined : version.replace(/^v/, "") });
  });
  return found;
}

export const setupCue: Rule = {
  id: "setup-cue",
  title: "The cue CLI comes from the shared action `setup-cue`, not from a download in a workflow.",
  reason:
    "On 2026-11-08, GitHub gave a 504 for release assets on and off from 09:00Z to after 10:20Z. A bare `curl` of the cue CLI failed the CI of cue and a release of client.",
  fix: 'A caller of `reusable-ci.yml` gives the input `cue-version: "<version>"` in place of the download in `setup`. Another job uses the step `uses: mark1russell7/template/.github/actions/setup-cue@<commit>` with `version: <version>`.',
  sources: [
    { repo: "cue", rule: "ci", doc: "the cue download of main CI and of #66 (2026-11-08): a 504 of github.com, and #66 passed at attempt 3" },
    { repo: "client", rule: "release", doc: "the 0.52.0 release (2026-11-08): a bare curl -fsSL of the cue CLI failed on a 504" },
    { repo: "template", rule: "security", doc: "the Security run of main daa927c (2026-11-08): the same 504 for the CodeQL bundle, another release asset" },
  ],
  options: {},
  check(context) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const breaks: Break[] = [];
    for (const file of files.filter((path) => (WORKFLOW.test(path) || ACTION.test(path)) && path !== SHARED_ACTION).sort(byCode)) {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      for (const download of cueDownloads(text)) {
        const version = download.version === undefined ? "" : ` ${download.version}`;
        breaks.push({
          file,
          line: download.line,
          message: `${file} installs the cue CLI${version} with its own command, with no retry. Use the action setup-cue of the template, or the input cue-version of reusable-ci.yml.`,
        });
      }
    }
    return breaks;
  },
};
