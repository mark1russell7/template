/**
 * The line that a measured page shows for its data: the run, its date and its engine versions, and a run in flight.
 * The line also shows the age of the data at the build. It tells when the numbers are a study, and it shows the reason for a longer age limit.
 */

import type { DataRun, PageStamp } from "../check/freshness.ts";
import { escapeHtml, link, listText } from "./html.ts";

const DAY_MS = 86_400_000;

/** This function gives an engine and its version in the short form, without the npm scope. */
function engineText(name: string, version: string): string {
  return `${name.slice(name.indexOf("/") + 1)} ${version}`;
}

/** This function gives the html of one run: a link to the run, the day of its start and each engine. */
function runHtml(run: DataRun): string {
  const engines = Object.entries(run.engines).map(([name, version]) => escapeHtml(engineText(name, version)));
  return `${escapeHtml(run.method ?? "run")} ${link(run.url, escapeHtml(run.id))} of ${escapeHtml(run.date.slice(0, 10))}${run.commit === undefined ? "" : `, at commit ${escapeHtml(run.commit.slice(0, 7))}`}, on ${listText(engines)}`;
}

/** This function gives the html of the sentences of a study, with each version of its runs once. A study with a limit is not a fixed study. */
function studyHtml(stamp: PageStamp): string {
  const engines = [...new Set(stamp.runs.flatMap((run) => Object.entries(run.engines).map(([name, version]) => engineText(name, version))))].map(escapeHtml);
  if (stamp.limit !== undefined) return `<span>The measured numbers of this page are a study of ${listText(engines)}.</span> `;
  const statements = stamp.noLimit === undefined ? "" : ` ${escapeHtml(stamp.noLimit.reproduce)} ${escapeHtml(stamp.noLimit.today)}`;
  return `<span>The measured numbers of this page are a fixed study of ${listText(engines)}. They tell nothing about a newer release.${statements}</span> `;
}

/** This function gives the html of the age of the oldest run, at the time of the build. */
function ageHtml(stamp: PageStamp, now: string): string {
  const oldest = Math.min(...stamp.runs.map((run) => Date.parse(run.date)));
  const days = Math.max(0, Math.floor((Date.parse(now) - oldest) / DAY_MS));
  return ` <span>The oldest data of this page is ${days} ${days === 1 ? "day" : "days"} old at this build, on ${escapeHtml(now.slice(0, 10))}.</span>`;
}

/** This function gives the html line of the stamp of a page. A page shows this line with its data. The value `now` is the ISO time of the build. */
export function renderDataStamp(stamp: PageStamp, now: string = new Date().toISOString()): string {
  const study = stamp.study === true ? studyHtml(stamp) : "";
  const data = `<span>The data comes from ${listText(stamp.runs.map(runHtml))}.</span>`;
  const flight = stamp.inFlight === undefined ? "" : ` <span>A newer run is in flight: ${runHtml(stamp.inFlight)}.</span>`;
  const start = stamp.limit?.startsAt === undefined ? "" : `, from ${escapeHtml(stamp.limit.startsAt.slice(0, 10))}`;
  const limit = stamp.limit === undefined ? "" : ` <span>The age limit of this data is ${stamp.limit.days} days${start}. ${escapeHtml(stamp.limit.reason)}</span>`;
  return `<p class="data-stamp">${study}${data}${ageHtml(stamp, now)}${flight}${limit}</p>`;
}
