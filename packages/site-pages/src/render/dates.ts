/**
 * The dates of the pages. The pages show each date in UTC, so the build and the browser agree.
 */

/** The milliseconds of one day. */
export const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** This function gives the start of the UTC day of a time. */
export function utcDay(time: number): number {
  return Math.floor(time / DAY_MS) * DAY_MS;
}

/** This function gives "Oct 18": the UTC day of a time or of an ISO date. */
export function shortDate(date: string | number): string {
  const day = new Date(date);
  return `${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}`;
}

/** This function gives "Oct 18, 2026, 19:34 UTC", or "an unknown time" for a date that is not valid. */
export function longDate(date: string | number): string {
  const day = new Date(date);
  if (Number.isNaN(day.getTime())) return "an unknown time";
  const time = `${String(day.getUTCHours()).padStart(2, "0")}:${String(day.getUTCMinutes()).padStart(2, "0")}`;
  return `${shortDate(date)}, ${day.getUTCFullYear()}, ${time} UTC`;
}

/** This function gives "Oct 13–15", or "Sep 30–Oct 2" over the end of a month. */
export function dayRange(start: number, end: number): string {
  if (utcDay(start) === utcDay(end)) return shortDate(start);
  const first = new Date(start);
  const last = new Date(end);
  return first.getUTCMonth() === last.getUTCMonth() ? `${shortDate(start)}–${last.getUTCDate()}` : `${shortDate(start)}–${shortDate(end)}`;
}
