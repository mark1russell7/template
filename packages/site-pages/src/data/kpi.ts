/**
 * The file `kpi.json` at the root of a site, format `kpi/1`. A reader outside the site takes the measures of the project
 * from this file. Thus a number on a progress page comes from a record and not from a person.
 *
 * The field `at` is the time of the data and not the time of the build. Thus the writer has no default for it.
 * A measure can have its own `at` when its data is from another time than the rest of the file.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KpiEngine, KpiFile, KpiMeasure } from "./types.ts";

/** The name of the format. A new format gets a new name, so that an old reader refuses it. */
export const KPI_FORMAT = "kpi/1";

/** The name of the file at the root of the built site. */
export const KPI_FILE = "kpi.json";

/** The data of `kpi.json`, without the name of the format. */
export type KpiInput = Omit<KpiFile, "format">;

/** The form of a project and a measure. A double hyphen separates fields in the file name of a reading. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The form of a time in UTC, with or without seconds. */
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;

/** The form of a full commit. */
const COMMIT = /^[0-9a-f]{40}$/;

/** The clock difference between two computers that the check accepts, in milliseconds. */
const CLOCK_MARGIN = 5 * 60 * 1000;

/** An error in the data of `kpi.json`. The field `problems` has one line for each fault. */
export class KpiError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`${KPI_FILE} is not correct: ${problems.join(" ")}`);
    this.name = "KpiError";
    this.problems = problems;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** This function gives the fault of a time of the data, or an empty list. The name tells which field it is. */
function timeProblems(at: unknown, name: string, now: number): string[] {
  if (typeof at !== "string" || !UTC_TIME.test(at) || Number.isNaN(Date.parse(at))) return [`${name} is not a time in UTC.`];
  return Date.parse(at) > now + CLOCK_MARGIN ? [`The time of the data ${at} is after the time of the check.`] : [];
}

/** This function gives the faults of one measure. */
function measureProblems(value: unknown, index: number, seen: Set<string>, now: number): string[] {
  if (!isRecord(value)) return [`Measure ${index} is not an object.`];
  const { id, value: amount, unit, at } = value;
  const problems: string[] = [];
  if (typeof id !== "string" || !SLUG.test(id)) problems.push(`Measure ${index} has no id of lowercase words with single hyphens.`);
  else if (seen.has(id)) problems.push(`The id ${id} occurs two times.`);
  else seen.add(id);
  if (typeof amount !== "number" || !Number.isFinite(amount)) problems.push(`Measure ${index} has no finite number as its value.`);
  if (unit !== undefined && !isText(unit)) problems.push(`Measure ${index} has a unit that is not a text.`);
  if (at !== undefined) problems.push(...timeProblems(at, `The field at of measure ${index}`, now));
  return problems;
}

/** This function gives the faults of the list of engines. */
function engineProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return ["The field engines is not a list."];
  return value.flatMap((engine: unknown, index) => (isRecord(engine) && isText(engine["name"]) && isText(engine["version"]) ? [] : [`Engine ${index} has no name and version.`]));
}

/**
 * This function gives the faults of a parsed `kpi.json`, or an empty list.
 *
 * @param value - The parsed file.
 * @param now - The time of the check, in milliseconds. A time of the data after this time is a fault.
 */
export function kpiProblems(value: unknown, now: number = Date.now()): string[] {
  if (!isRecord(value)) return ["The file is not an object."];
  const problems: string[] = [];
  if (value["format"] !== KPI_FORMAT) problems.push(`The format is not ${KPI_FORMAT}.`);
  const { project, at, commit, measures } = value;
  if (typeof project !== "string" || !SLUG.test(project)) problems.push("The project is not lowercase words with single hyphens.");
  problems.push(...timeProblems(at, "The field at", now));
  if (typeof commit !== "string" || !COMMIT.test(commit)) problems.push("The commit is not a full commit.");
  if (!Array.isArray(measures) || measures.length === 0) problems.push("The file has no measures.");
  else {
    const seen = new Set<string>();
    problems.push(...measures.flatMap((measure: unknown, index) => measureProblems(measure, index, seen, now)));
  }
  problems.push(...engineProblems(value["engines"]));
  return problems;
}

/** This function gives a copy of a measure with only its known fields. */
function cleanMeasure({ id, value, unit, at }: KpiMeasure): KpiMeasure {
  return { id, value, ...(unit === undefined ? {} : { unit }), ...(at === undefined ? {} : { at }) };
}

/** This function gives a copy of an engine with only its known fields. */
function cleanEngine({ name, version }: KpiEngine): KpiEngine {
  return { name, version };
}

/**
 * This function gives the checked content of `kpi.json`. The file has only its known fields, in a fixed order.
 *
 * @throws KpiError when the data is not correct
 */
export function kpiFile(input: KpiInput, now?: number): KpiFile {
  const problems = kpiProblems({ format: KPI_FORMAT, ...input }, now);
  if (problems.length > 0) throw new KpiError(problems);
  const { project, at, commit, measures, engines } = input;
  const file: KpiFile = { format: KPI_FORMAT, project, at, commit, measures: measures.map(cleanMeasure) };
  return engines === undefined ? file : { ...file, engines: engines.map(cleanEngine) };
}

/** This function gives the text of `kpi.json`. */
export function kpiText(file: KpiFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * This function reads the text of a `kpi.json`.
 *
 * @throws KpiError when the text is not correct
 */
export function readKpi(text: string, now?: number): KpiFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new KpiError([`The file is not JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const problems = kpiProblems(value, now);
  if (problems.length > 0) throw new KpiError(problems);
  const { project, at, commit, measures, engines } = value as KpiFile;
  return kpiFile(engines === undefined ? { project, at, commit, measures } : { project, at, commit, measures, engines }, now);
}

/**
 * This function writes `kpi.json` into the built output folder of a site, and gives the path of the file.
 *
 * @throws KpiError when the data is not correct
 */
export function writeKpi(out: string, input: KpiInput, now?: number): string {
  const text = kpiText(kpiFile(input, now));
  mkdirSync(out, { recursive: true });
  const file = join(out, KPI_FILE);
  writeFileSync(file, text);
  return file;
}
