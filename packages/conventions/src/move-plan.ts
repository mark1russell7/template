/**
 * The plan of a move of a repository to another owner. It has each place of a repository that names the old name, and each
 * step that no file holds. The rules `moved-repo-names` and `moved-repo-calls` read the same places, so the plan and the gate
 * agree. A step is data: its id, what to do, and the function that tells if the places of the plan need it.
 *
 * This file reads no file and starts no program. The command `conventions move plan` gives it the files of git.
 */
import { movedTo, type RepoMove } from "./moves.ts";
import { PLACE_KINDS, replacePlaces, stalePlaces, type StalePlace } from "./places.ts";
import { movedLine, remoteCalls } from "./rules/moved-repo-calls.ts";
import { WORKFLOW } from "./workflow.ts";

/** A file of the repository: its path (relative to the root, with `/`) and its text. */
export interface PlanFile {
  readonly path: string;
  readonly text: string;
}

/** One place of the plan. The kind `workflow-calls` is a `uses:` line (the rule `moved-repo-calls`). */
export interface PlanPlace {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  /** The text as the file writes it. */
  readonly text: string;
  /** The text to write in its place. */
  readonly replacement: string;
  /** The form of the text: `repo` for `owner/name`, `pages` for a GitHub Pages address. */
  readonly form: "repo" | "pages";
}

/** A step of a move that no file of the repository holds. */
export interface MoveStep {
  /** A short id in kebab case. */
  readonly id: string;
  /** What to do, in one sentence. */
  readonly title: string;
  /** This function tells if the plan needs the step. */
  readonly needed: (places: readonly PlanPlace[]) => boolean;
}

/** The plan of a move: each place, and each step that the places need. */
export interface MovePlan {
  readonly moves: readonly RepoMove[];
  readonly places: readonly PlanPlace[];
  readonly steps: readonly MoveStep[];
}

/** The files of a composite action. */
const ACTION = /^\.github\/actions\/.+\/action\.ya?ml$/;

/** The steps of a move that no file holds, in the order of the work. */
export const MOVE_STEPS: readonly MoveStep[] = [
  {
    id: "npm-trust",
    title:
      "For each package that this repository publishes, add a trusted publisher on npm for the new repository, before the next release: npm provenance compares the field repository with the repository of the run.",
    needed: (places) => places.some((place) => place.kind === "package-fields" && place.file.endsWith("package.json")),
  },
  {
    id: "pages-address",
    title:
      "The GitHub Pages address changes to the new owner. Make sure that each link from outside the repository (a profile, a package page, another site) uses the new address: the old address gives 404.",
    needed: (places) => places.some((place) => place.form === "pages"),
  },
  {
    id: "workflow-calls",
    title:
      "Each repository that calls a workflow or an action of the moved repository needs the new name in its uses: line: GitHub does not follow the move for uses:. Run this plan in each such repository.",
    needed: () => true,
  },
  {
    id: "clone-remotes",
    title: "In each clone, write the new address of the remote: git remote set-url origin https://github.com/<new owner>/<name>.git.",
    needed: () => true,
  },
];

/** This function gives the plan of the moves over the files of a repository, in the order of the files and the lines. */
export function movePlan(files: readonly PlanFile[], moves: readonly RepoMove[]): MovePlan {
  const places: PlanPlace[] = [];
  for (const file of files) {
    if (PLACE_KINDS.some((kind) => kind.reads(file.path))) {
      for (const place of stalePlaces(file.path, file.text, moves)) places.push(toPlace(place));
    }
    if (WORKFLOW.test(file.path) || ACTION.test(file.path)) {
      for (const call of remoteCalls(file.text)) {
        const to = movedTo(call.repo, moves);
        if (to !== undefined) places.push({ file: file.path, line: call.line, kind: "workflow-calls", text: call.repo, replacement: to, form: "repo" });
      }
    }
  }
  places.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return { moves, places, steps: MOVE_STEPS.filter((step) => step.needed(places)) };
}

function toPlace(place: StalePlace): PlanPlace {
  return { file: place.file, line: place.line, kind: place.kind, text: place.text, replacement: place.replacement, form: place.form };
}

/**
 * This function gives each file that the moves change, with its new text. It writes each place of a kind of `places.ts`.
 * It also writes each `uses:` line that names a moved repository. A file with no place is not in the result.
 */
export function applyMoves(files: readonly PlanFile[], moves: readonly RepoMove[]): PlanFile[] {
  const changed: PlanFile[] = [];
  for (const file of files) {
    let text = file.text;
    if (PLACE_KINDS.some((kind) => kind.reads(file.path))) text = replacePlaces(text, stalePlaces(file.path, text, moves));
    if (WORKFLOW.test(file.path) || ACTION.test(file.path)) {
      const calls = remoteCalls(text);
      if (calls.length > 0) {
        const eol = text.includes("\r\n") ? "\r\n" : "\n";
        const lines = text.split(/\r?\n/);
        for (const call of calls) {
          const to = movedTo(call.repo, moves);
          const line = lines[call.line - 1];
          if (to !== undefined && line !== undefined) lines[call.line - 1] = movedLine(line, call.repo, to);
        }
        text = lines.join(eol);
      }
    }
    if (text !== file.text) changed.push({ path: file.path, text });
  }
  return changed;
}

/** This function gives the plan as text: one line for each place, then the steps. */
export function movePlanText(plan: MovePlan): string {
  const lines = [`The plan of ${plan.moves.map((move) => `${move.from} to ${move.to}`).join(", ")}:`];
  if (plan.places.length === 0) lines.push("", "No file names an old name.");
  else {
    lines.push("", `${plan.places.length} places. \`conventions move apply\` with the same moves writes each one:`);
    for (const place of plan.places) lines.push(`  ${place.file}:${place.line}  ${place.kind}  ${place.text} -> ${place.replacement}`);
  }
  lines.push("", "The steps that no file holds:");
  plan.steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step.title}`));
  return `${lines.join("\n")}\n`;
}
