/**
 * The line that a measured page shows for its data: the run, its date and its engine versions, and a run in flight.
 */

import type { DataRun, PageStamp } from "../check/freshness.ts";
import { escapeHtml, link, listText } from "./html.ts";

/** This function gives an engine and its version in the short form, without the npm scope. */
function engineText(name: string, version: string): string {
  return `${name.slice(name.indexOf("/") + 1)} ${version}`;
}

/** This function gives the html of one run: a link to the run, the day of its start and each engine. */
function runHtml(run: DataRun): string {
  const engines = Object.entries(run.engines).map(([name, version]) => escapeHtml(engineText(name, version)));
  return `run ${link(run.url, escapeHtml(run.id))} of ${escapeHtml(run.date.slice(0, 10))}, on ${listText(engines)}`;
}

/** This function gives the html line of the stamp of a page. A page shows this line with its data. */
export function renderDataStamp(stamp: PageStamp): string {
  const data = `<span>The data comes from ${listText(stamp.runs.map(runHtml))}.</span>`;
  const flight = stamp.inFlight === undefined ? "" : ` <span>A newer run is in flight: ${runHtml(stamp.inFlight)}.</span>`;
  return `<p class="data-stamp">${data}${flight}</p>`;
}
