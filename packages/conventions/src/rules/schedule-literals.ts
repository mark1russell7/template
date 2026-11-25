/**
 * The rule `schedule-literals`: in a workflow that compares `github.event.schedule` with a cron in quotes, each such
 * cron is a cron of the `on.schedule` of the same file. A scheduled run gives the cron that started it. A copy that
 * does not match (for example after the minute of the schedule changed) matches no run, and that branch never runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";
import { WORKFLOW, keyValue, workflowLines } from "../workflow.ts";

/** A field of a cron: digits, `*`, `/`, `,`, `-`, and the names of days and months. */
const FIELD = "[\\d*/,A-Za-z-]+";

/** A cron of five fields, with one space or more between them. The first field (the minute) has a digit or `*`. */
const CRON = new RegExp(`^[\\d*][\\d*/,-]*(?:\\s+${FIELD}){4}$`);

/** A text in single or double quotes on a line. */
const QUOTED = /'([^'\n]*)'|"([^"\n]*)"/g;

/** This function tells if a text is a cron of five fields. */
export const isCron = (text: string): boolean => CRON.test(text.trim());

/** This function gives a cron with one space between its fields, so two forms of one cron compare the same. */
export const normalCron = (text: string): string => text.trim().split(/\s+/).join(" ");

/** A cron in quotes on a line of a workflow. */
export interface CronLiteral {
  /** The line, from 1. */
  readonly line: number;
  /** The cron as the line writes it, without the quotes. */
  readonly text: string;
}

/** The crons of a workflow: those of `on.schedule` and those in quotes elsewhere. */
export interface WorkflowCrons {
  /** The crons of `on.schedule`, with one space between fields. */
  readonly schedule: readonly string[];
  /** Each cron in quotes that is not a `cron:` value, with its line. */
  readonly literals: readonly CronLiteral[];
  /** The value `true` when the workflow reads `github.event.schedule`. */
  readonly readsSchedule: boolean;
}

/** This function reads the crons of a workflow. It does not read a comment line. */
export function workflowCrons(text: string): WorkflowCrons {
  const schedule: string[] = [];
  const literals: CronLiteral[] = [];
  let readsSchedule = false;
  workflowLines(text).forEach((line, index) => {
    if (/github\.event\.schedule\b/.test(line)) readsSchedule = true;
    const cron = keyValue(line, "cron");
    if (cron !== undefined) {
      if (isCron(cron)) schedule.push(normalCron(cron));
      return;
    }
    for (const match of line.matchAll(QUOTED)) {
      const value = match[1] ?? match[2] ?? "";
      if (isCron(value)) literals.push({ line: index + 1, text: value });
    }
  });
  return { schedule, literals, readsSchedule };
}

export const scheduleLiterals: Rule = {
  id: "schedule-literals",
  title: "Each cron that a workflow compares with `github.event.schedule` is a cron of its own `on.schedule`.",
  reason:
    "A scheduled run gives in github.event.schedule the cron that started it. On 2026-11-24 the move of systems changed the minutes of the crons of cells.yml, and a case and two if: lines kept the old minutes, so no scheduled run matched them.",
  fix: "Write the cron of `on.schedule` in the comparison, character for character, or remove the comparison. `conventions fix` writes it when the file has one cron that no comparison names and one cron in quotes that no schedule has.",
  sources: [
    { repo: "systems", rule: "cells", doc: "systems #669 (2026-11-24): cells.yml compared github.event.schedule with crons of the old minutes after the move, in a case and two if: lines" },
  ],
  options: {},
  failsFrom: "2026-12-09",
  check(context) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const breaks: Break[] = [];
    for (const file of files.filter((path) => WORKFLOW.test(path)).sort(byCode)) {
      let text: string;
      try {
        text = readFileSync(join(context.root, file), "utf8");
      } catch {
        continue;
      }
      const crons = workflowCrons(text);
      if (!crons.readsSchedule) continue;
      const known = new Set(crons.schedule);
      const wrong = crons.literals.filter((literal) => !known.has(normalCron(literal.text)));
      if (wrong.length === 0) continue;
      const named = new Set(crons.literals.map((literal) => normalCron(literal.text)));
      const unnamed = crons.schedule.filter((cron) => !named.has(cron));
      const distinct = [...new Set(wrong.map((literal) => literal.text))];
      // One cron that no comparison names, and one cron in quotes that no schedule has: the copy is of that cron.
      const target = unnamed.length === 1 && distinct.length === 1 ? unnamed[0] : undefined;
      const after = target === undefined ? undefined : replaceQuoted(text, distinct[0] ?? "", target);
      for (const literal of wrong) {
        breaks.push({
          file,
          line: literal.line,
          message: `${file} compares github.event.schedule with "${literal.text}", which is not a cron of its on.schedule (${crons.schedule.length === 0 ? "it has none" : crons.schedule.join(", ")}). No scheduled run matches it.${target === undefined ? "" : ` The cron is "${target}".`}`,
          ...(after === undefined || after === text ? {} : { edits: [{ file, before: text, after }] }),
        });
      }
    }
    return breaks;
  },
};

/** This function gives the text with each quoted copy of `from` (in single or double quotes) replaced by `to`, on lines that are not comments. */
function replaceQuoted(text: string, from: string, to: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return text
    .split(/\r?\n/)
    .map((line) => (line.trimStart().startsWith("#") ? line : line.split(`'${from}'`).join(`'${to}'`).split(`"${from}"`).join(`"${to}"`)))
    .join(eol);
}
