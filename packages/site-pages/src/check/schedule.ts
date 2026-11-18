/**
 * The reader of the schedules of a workflow: each line `cron:`, and the largest gap between its starts.
 * The freshness gate and the rules of conventions use it.
 * This file imports nothing, so a change of the freshness gate does not change the build of a package that reads schedules.
 */

const DAY_MS = 86_400_000;

/** This function gives the values of one field of a cron line, or undefined for a form that it cannot read. */
function cronValues(field: string, low: number, high: number): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (match === null) return undefined;
    const [, range = "", step = "1"] = match;
    const [from = low, to = from] = range === "*" ? [low, high] : range.split("-").map(Number);
    const by = Number(step);
    if (by <= 0 || from < low || to > high || from > to) return undefined;
    for (let value = from; value <= to; value += by) values.add(value);
  }
  return values;
}

/** This function gives the start of each day of a cron line, in a span of two years. It gives undefined for a line that it cannot read. */
function cronDays(line: string, from: number, days: number): number[] | undefined {
  const fields = line.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
  const minutes = cronValues(minute, 0, 59);
  const hours = cronValues(hour, 0, 23);
  const monthDays = cronValues(dayOfMonth, 1, 31);
  const months = cronValues(month, 1, 12);
  const weekDays = cronValues(dayOfWeek, 0, 6);
  if (minutes === undefined || hours === undefined || monthDays === undefined || months === undefined || weekDays === undefined) return undefined;
  const firstTime = (Math.min(...hours) * 60 + Math.min(...minutes)) * 60_000;
  const starts: number[] = [];
  for (let day = 0; day < days; day += 1) {
    const time = from + day * DAY_MS;
    const date = new Date(time);
    if (!months.has(date.getUTCMonth() + 1)) continue;
    const onMonthDay = monthDays.has(date.getUTCDate());
    const onWeekDay = weekDays.has(date.getUTCDay());
    // A cron line that sets both day fields starts on a day that matches one of them.
    const both = dayOfMonth !== "*" && dayOfWeek !== "*";
    if (both ? onMonthDay || onWeekDay : onMonthDay && onWeekDay) starts.push(time + firstTime);
  }
  return starts;
}

/** One schedule of a workflow. */
export interface CronLine {
  /** The number of the line in the file, from 1. */
  readonly line: number;
  /** The cron text, with no quotes and no comment. */
  readonly cron: string;
}

/**
 * This function gives each line `cron:` of a workflow. It is the one reader of these lines: the freshness gate and the rule `runner-budget` of conventions use it.
 * It skips a comment line. It reads a quoted key, a list item, a quoted value and a comment at the end of the line.
 */
export function cronLines(workflow: string): CronLine[] {
  return workflow.split(/\r?\n/).flatMap((raw, index) => {
    const text = raw.trim().replace(/^- */, "");
    const key = ["cron:", '"cron":', "'cron':"].find((form) => text.startsWith(form));
    if (key === undefined) return [];
    // YAML starts a comment at a "#" after a space or a tab.
    const rest = text.slice(key.length);
    const comment = rest.search(/\s#/);
    const value = (comment >= 0 ? rest.slice(0, comment) : rest).trim();
    const quote = value.charAt(0);
    const quoted = value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote);
    return [{ line: index + 1, cron: quoted ? value.slice(1, -1).trim() : value }];
  });
}

/**
 * This function gives the largest gap between the scheduled starts of a workflow, in days. The gap counts from the first start of a day.
 * It gives a text in place of the gap for a workflow with no schedule, and for a line that it cannot read. The text names the line, and the gate fails on it.
 */
export function scheduleGapDays(workflow: string): number | string {
  const lines = cronLines(workflow).map((item) => item.cron);
  if (lines.length === 0) return "the workflow has no line `cron:`";
  const from = Date.UTC(2027, 0, 1);
  const span = 731;
  const starts: number[] = [];
  for (const line of lines) {
    const days = cronDays(line, from, span);
    if (days === undefined) return `the gate cannot read the line \`cron: ${line}\``;
    starts.push(...days);
  }
  if (starts.length < 2) return `the lines \`cron: ${lines.join("`, `cron: ")}\` give fewer than two starts in two years`;
  starts.sort((a, b) => a - b);
  let largest = 0;
  for (let index = 1; index < starts.length; index += 1) largest = Math.max(largest, ((starts[index] ?? 0) - (starts[index - 1] ?? 0)) / DAY_MS);
  return largest;
}
