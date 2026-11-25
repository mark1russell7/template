/**
 * The rule `moved-repo-calls`: no workflow or composite action calls a reusable workflow or an action by the old name
 * of a repository that moved to another owner. GitHub does not follow the redirect of a moved repository for `uses:`.
 * Each run of the workflow then fails before it starts ("workflow file issue"), and no job shows why.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MOVES, movedTo, parseMove, type RepoMove } from "../moves.ts";
import { byCode } from "../workspace.ts";
import { replaceLine, type Break, type Rule } from "../rule.ts";
import { WORKFLOW, keyValue, workflowLines } from "../workflow.ts";

/** The files of a composite action. */
const ACTION = /^\.github\/actions\/.+\/action\.ya?ml$/;

/** The value of `uses:` that names another repository: `owner/name`, then a path or nothing, then `@` and the ref. */
const REMOTE = /^([\w.-]+)\/([\w.-]+)(\/[^@\s]*)?@\S+$/;

/** A call of a workflow or an action in another repository, on one line of a file. */
export interface RemoteCall {
  /** The line, from 1. */
  readonly line: number;
  /** The repository as the line writes it: `owner/name`. */
  readonly repo: string;
}

/** This function gives each `uses:` of a workflow or an action that names another repository. A local path (`./`) and a Docker image (`docker://`) are not calls of a repository. */
export function remoteCalls(text: string): RemoteCall[] {
  const found: RemoteCall[] = [];
  workflowLines(text).forEach((line, index) => {
    const value = keyValue(line, "uses");
    if (value === undefined) return;
    const match = REMOTE.exec(value);
    if (match === null) return;
    found.push({ line: index + 1, repo: `${match[1] ?? ""}/${match[2] ?? ""}` });
  });
  return found;
}

/** This function gives the line with the first `<repo>/` or `<repo>@` after `uses:` replaced by the new repository. */
export function movedLine(line: string, repo: string, to: string): string {
  const at = line.indexOf("uses:");
  const start = line.indexOf(repo, at < 0 ? 0 : at);
  if (start < 0) return line;
  return line.slice(0, start) + to + line.slice(start + repo.length);
}

export const movedRepoCalls: Rule = {
  id: "moved-repo-calls",
  title: "No `uses:` of a workflow or an action names a repository by an old owner after the repository moved.",
  reason:
    "GitHub sends a request for the old name of a moved repository to the new name, but a call of a reusable workflow or an action does not follow it. On 2026-11-24, after vex moved to metrograph-labs, each CI run of ireko failed before it started: its ci.yml called mark1russell7/vex/.github/workflows/module-bytes.yml.",
  fix: "Write the new owner in the `uses:` line. The ref (a commit) stays the same, because the history of the repository did not change. `conventions fix` writes it.",
  sources: [
    { repo: "ireko", rule: "ci", doc: "ireko #133 (2026-11-24): the CI of main failed before it started (workflow file issue) after vex moved, until the call named metrograph-labs/vex" },
  ],
  options: {
    moves: {
      type: "strings",
      default: [],
      description: "More moves for this repository, each in the form `owner/name=owner/name`, after the moves that the package knows.",
    },
  },
  failsFrom: "2026-12-09",
  check(context, options) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const extra = (options["moves"] as readonly string[]).map((text) => ({ text, move: parseMove(text) }));
    const bad = extra.find((each) => each.move === undefined);
    if (bad !== undefined) return { skipped: `the option moves has "${bad.text}", which is not in the form owner/name=owner/name` };
    const moves: RepoMove[] = [...MOVES, ...extra.map((each) => each.move as RepoMove)];
    const breaks: Break[] = [];
    for (const file of files.filter((path) => WORKFLOW.test(path) || ACTION.test(path)).sort(byCode)) {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (const call of remoteCalls(text)) {
        const to = movedTo(call.repo, moves);
        if (to === undefined) continue;
        const original = lines[call.line - 1] ?? "";
        const after = replaceLine(text, call.line, [movedLine(original, call.repo, to)]);
        breaks.push({
          file,
          line: call.line,
          message: `${file} calls ${call.repo}, which moved to ${to}. GitHub does not follow the move for uses:, so each run fails before it starts. Write ${to} in its place.`,
          ...(after === text ? {} : { edits: [{ file, before: text, after }] }),
        });
      }
    }
    return breaks;
  },
};
