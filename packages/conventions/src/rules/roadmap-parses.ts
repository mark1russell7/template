/**
 * The rule `roadmap-parses`: each roadmap that a workflow gives to the Status page parses, on the pull request.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRoadmap, RoadmapParseError } from "@mark1russell7/site-pages";
import { byCode } from "../workspace.ts";
import { cleanPath, type Break, type Rule } from "../rule.ts";

/** A workflow file. */
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** A roadmap that a workflow names: the value of a `roadmap:` key, with its file and line. */
interface NamedRoadmap {
  readonly roadmap: string;
  readonly file: string;
  readonly line: number;
}

/** This function gives the value of a `roadmap: <file>` line, or undefined for another line, an empty value or an expression. */
export function roadmapOfLine(line: string): string | undefined {
  const text = line.trimStart();
  if (!text.startsWith("roadmap:")) return undefined;
  let value = text.slice("roadmap:".length);
  const comment = value.indexOf(" #");
  if (comment >= 0) value = value.slice(0, comment);
  value = value.trim();
  const quote = value.charAt(0);
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1).trim();
  if (value === "" || value.includes("${{")) return undefined;
  return cleanPath(value);
}

export const roadmapParses: Rule = {
  id: "roadmap-parses",
  title: "Each roadmap that a workflow gives to the Status page (the input `roadmap`) parses as site-pages reads it.",
  reason:
    "Only the Pages job on main reads the roadmap. A pull request with a bad table row passes each check, and then the build of the site stops and the site stays stale. On 2026-10-30, one repository had 3 red Pages runs in a row because of one row with 2 cells under a header with 4.",
  fix: 'Correct the row or the heading that the message names. Each table row has one cell for each column of its header, and the file has a table with an ID column and a Status column, or a heading "### `id`: Title".',
  sources: [{ repo: "fleet", rule: "fail-closed", doc: "docs/STRATEGY.md (2026-10-30, gates and probes fail closed)" }],
  options: {
    roadmaps: { type: "strings", default: [], description: "More roadmap files to check: a roadmap that no workflow names with a `roadmap:` key." },
  },
  check(context, options) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const named: NamedRoadmap[] = [];
    for (const file of files.filter((path) => WORKFLOW.test(path)).sort(byCode)) {
      readFileSync(join(context.root, file), "utf8")
        .split(/\r?\n/)
        .forEach((line, index) => {
          const roadmap = roadmapOfLine(line);
          if (roadmap !== undefined) named.push({ roadmap, file, line: index + 1 });
        });
    }
    for (const roadmap of options["roadmaps"] as readonly string[]) named.push({ roadmap: cleanPath(roadmap), file: "the option roadmaps", line: 0 });
    if (named.length === 0) return { skipped: "no workflow names a roadmap (the input roadmap of the Pages workflow)" };
    const breaks: Break[] = [];
    const seen = new Set<string>();
    for (const { roadmap, file, line } of named) {
      if (seen.has(roadmap)) continue;
      seen.add(roadmap);
      if (!existsSync(join(context.root, roadmap))) {
        breaks.push({ file: line > 0 ? file : roadmap, ...(line > 0 ? { line } : {}), message: `${file} names the roadmap ${roadmap}, and the file does not exist.` });
        continue;
      }
      try {
        parseRoadmap(readFileSync(join(context.root, roadmap), "utf8"), { file: roadmap });
      } catch (error) {
        if (!(error instanceof RoadmapParseError)) throw error;
        // The message starts with "<file>:<line>: " or "<file>: ". The break has the file and the line in their own fields.
        const at = /^[^:]+:(\d+): /.exec(error.message);
        const rest = at ? error.message.slice(at[0].length) : error.message.slice(error.message.indexOf(": ") + 2);
        breaks.push({ file: roadmap, ...(at ? { line: Number(at[1]) } : {}), message: `${roadmap}: ${rest}` });
      }
    }
    return breaks;
  },
};
