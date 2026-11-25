/**
 * The rule `moved-repo-names`: no package field, Markdown link, workflow key or config value names a repository by the
 * old name of a move. The kinds of place are in `places.ts`. The rule `moved-repo-calls` holds `uses:`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MOVES, parseMove, type RepoMove } from "../moves.ts";
import { PLACE_KINDS, replacePlaces, stalePlaces } from "../places.ts";
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";

export const movedRepoNames: Rule = {
  id: "moved-repo-names",
  title: "No package field, Markdown link, workflow key or config value names a repository by an old owner after the repository moved.",
  reason:
    "Some old names break at once: npm provenance compares the field repository of package.json with the repository of the run, and a GitHub Pages address of the old owner gives 404. The other old names go through a redirect only until a new repository takes the old name. On 2026-11-24, 11 repositories moved to metrograph-labs, and each place was found and changed by hand.",
  fix: "Write the new owner in each place. `conventions fix` writes each one. A change log is not read: it is a record of the past.",
  sources: [{ repo: "private", rule: "repo-move-tool", doc: "a decision of 2026-11-25: one gate holds each place that names a moved repository" }],
  options: {
    moves: {
      type: "strings",
      default: [],
      description: "More moves for this repository, each in the form `owner/name=owner/name`, after the moves that the package knows.",
    },
  },
  failsFrom: "2026-12-10",
  check(context, options) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const extra = (options["moves"] as readonly string[]).map((text) => ({ text, move: parseMove(text) }));
    const bad = extra.find((each) => each.move === undefined);
    if (bad !== undefined) return { skipped: `the option moves has "${bad.text}", which is not in the form owner/name=owner/name` };
    const moves: RepoMove[] = [...MOVES, ...extra.map((each) => each.move as RepoMove)];
    const breaks: Break[] = [];
    for (const file of files.filter((path) => PLACE_KINDS.some((kind) => kind.reads(path))).sort(byCode)) {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      const places = stalePlaces(file, text, moves);
      if (places.length === 0) continue;
      const after = replacePlaces(text, places);
      for (const place of places) {
        breaks.push({
          file,
          line: place.line,
          message: `${file} names ${place.text} (${place.kind}), which moved to ${place.to}. Write ${place.replacement} in its place.`,
          // Each break of the file has the same edit, which fixes all of them: `conventions fix` writes it one time.
          ...(after === text ? {} : { edits: [{ file, before: text, after }] }),
        });
      }
    }
    return breaks;
  },
};
