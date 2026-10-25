/**
 * The standalone releases page: a lead line, a timeline of the versions and the changes of the
 * selected version. The build renders the HTML, and one small inline module adds the interactions.
 */

import type { Release, ReleaseChange, ReleaseKind } from "../data/types.ts";
import { longDate, shortDate } from "./dates.ts";
import { escapeHtml, inlineMarkdown, link, listText, plural } from "./html.ts";
import { pageShell, type PageOptions } from "./theme.ts";
import { laneCenter, oldestFirst, releaseSummary, timelineLayout, type TimelineLayout } from "./timeline.ts";

/** The changes and the package chips that the page shows before "Show all". */
const FIRST_CHANGES = 8;
const FIRST_CHIPS = 4;
/** The y of the mark below the center line of its lane. The label is above the line. */
const MARK_Y = 9;
/** The widths of the two timelines: the narrow one for a phone or a tablet, the wide one for a desktop. */
const NARROW_WIDTH = 640;
const WIDE_WIDTH = 920;

const KIND_INFO: Record<ReleaseKind, { label: string; word: string; pill: string; legend: string }> = {
  first: { label: "First release", word: "first release", pill: "sp-pill sp-good", legend: "The first release" },
  major: { label: "MAJOR", word: "major", pill: "sp-pill sp-strong", legend: "MAJOR: a change that breaks the API" },
  minor: { label: "MINOR", word: "minor", pill: "sp-pill sp-accent", legend: "MINOR: new features (before 1.0.0, also a change of the API)" },
  patch: { label: "PATCH", word: "patch", pill: "sp-pill", legend: "PATCH: fixes and small additions" },
};

/** This function gives "Oct 18, 2026" for an ISO date. */
function dayWithYear(date: string): string {
  return `${shortDate(date)}, ${new Date(date).getUTCFullYear()}`;
}

/**
 * This function gives the lead line of the releases page, for example "23 versions from Oct 12 to
 * Oct 18, 2026. 7 MINOR releases and 15 PATCH releases came after the first release."
 */
export function releasesLead(releases: readonly Release[]): string {
  const summary = releaseSummary(releases);
  if (!summary.first || !summary.last) return "The repository has no release yet.";
  const sameYear = new Date(summary.first).getUTCFullYear() === new Date(summary.last).getUTCFullYear();
  const from = sameYear ? shortDate(summary.first) : dayWithYear(summary.first);
  const range = shortDate(summary.first) === shortDate(summary.last) && sameYear ? `on ${dayWithYear(summary.last)}` : `from ${from} to ${dayWithYear(summary.last)}`;
  if (summary.versions === 1) return `1 version, the first release, ${range}.`;
  const kinds = [
    summary.major > 0 ? plural(summary.major, "MAJOR release") : "",
    summary.minor > 0 ? plural(summary.minor, "MINOR release") : "",
    summary.patch > 0 ? plural(summary.patch, "PATCH release") : "",
  ].filter(Boolean);
  return `${plural(summary.versions, "version")} ${range}. ${listText(kinds)} came after the first release.`;
}

/** The shape of a mark. The first release is a diamond, a MAJOR is a large dot, a MINOR is a dot and a PATCH is a ring. */
function markShape(kind: ReleaseKind, y: number): string {
  if (kind === "first") return `<rect class="sp-dot" x="-5.5" y="${y - 5.5}" width="11" height="11" transform="rotate(45 0 ${y})"/>`;
  if (kind === "major") return `<circle class="sp-dot" cy="${y}" r="8"/>`;
  if (kind === "minor") return `<circle class="sp-dot" cy="${y}" r="6.5"/>`;
  return `<circle class="sp-ring" cy="${y}" r="4.5"/>`;
}

function legend(releases: readonly Release[]): string {
  const kinds = (["major", "minor", "patch", "first"] as const).filter((kind) => releases.some((release) => release.kind === kind));
  const items = kinds.map(
    (kind) =>
      `<li><svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true"><g class="sp-kind-${kind}">${markShape(kind, 0)}</g></svg>${escapeHtml(KIND_INFO[kind].legend)}</li>`,
  );
  return `<ul class="sp-legend">${items.join("")}</ul>`;
}

const fixed = (value: number): string => value.toFixed(1).replace(/\.0$/, "");

function timelineSvg(releases: readonly Release[], width: number, selected: string): string {
  const layout: TimelineLayout<Release> = timelineLayout(releases, { width });
  const { plotTop, plotBottom } = layout;
  const parts: string[] = [];
  for (const band of layout.bands) {
    const middle = (band.x0 + band.x1) / 2;
    const room = band.x1 - band.x0;
    const count = band.empty ? "no release" : plural(band.count, "release");
    parts.push(`<g${band.empty ? ' class="sp-empty-band"' : ""}>`);
    if (band.empty) parts.push(`<rect class="sp-gap" x="${fixed(band.x0)}" y="${plotTop}" width="${fixed(room)}" height="${plotBottom - plotTop}"/>`);
    parts.push(`<line class="sp-grid" x1="${fixed(band.x0)}" x2="${fixed(band.x0)}" y1="${plotTop}" y2="${plotBottom + 6}"/>`);
    if (room >= band.label.length * 7 + 6) {
      parts.push(`<text class="sp-day" x="${fixed(middle)}" y="${plotBottom + 21}" text-anchor="middle">${escapeHtml(band.label)}</text>`);
    }
    if (room >= count.length * 6 + 6) {
      parts.push(`<text class="sp-day-count" x="${fixed(middle)}" y="${plotBottom + 38}" text-anchor="middle">${escapeHtml(count)}</text>`);
    }
    parts.push("</g>");
  }
  const lastBand = layout.bands[layout.bands.length - 1];
  if (lastBand) parts.push(`<line class="sp-grid" x1="${fixed(lastBand.x1)}" x2="${fixed(lastBand.x1)}" y1="${plotTop}" y2="${plotBottom + 6}"/>`);
  parts.push(`<line class="sp-axis" x1="${fixed(layout.bands[0]?.x0 ?? 0)}" x2="${fixed(lastBand?.x1 ?? width)}" y1="${plotBottom}" y2="${plotBottom}"/>`);
  const axis = `<g aria-hidden="true">${parts.join("")}</g>`;

  const marks = layout.marks.map((mark) => {
    const { release } = mark;
    const on = release.version === selected;
    const label = `${release.version}, ${KIND_INFO[release.kind].word}, ${shortDate(release.date)}, ${plural(release.changes.length, "change")}`;
    return (
      `<g class="sp-mark sp-kind-${release.kind}${on ? " sp-selected" : ""}" data-sp-mark data-version="${escapeHtml(release.version)}"` +
      ` data-x="${fixed(mark.x)}" data-half="${fixed(mark.half)}" transform="translate(${fixed(mark.x)} ${fixed(laneCenter(layout, mark.lane))})"` +
      ` role="button" tabindex="${on ? 0 : -1}" aria-pressed="${on}" aria-label="${escapeHtml(label)}">` +
      `<rect class="sp-hit" x="${fixed(-mark.half - 4)}" y="${fixed(-layout.laneHeight / 2 + 1)}" width="${fixed(mark.half * 2 + 8)}" height="${layout.laneHeight - 2}" rx="4"/>` +
      `<circle class="sp-halo" cy="${MARK_Y}" r="11"/>${markShape(release.kind, MARK_Y)}` +
      `<text class="sp-label" y="-3" text-anchor="middle">${escapeHtml(release.version)}</text></g>`
    );
  });
  const name = `The release timeline, ${plural(layout.marks.length, "version")}. The arrow keys move between the versions.`;
  return (
    `<svg class="sp-timeline" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="group" aria-label="${escapeHtml(name)}">` +
    `${axis}${marks.join("")}</svg>`
  );
}

/** The common scope of all the package names ("@procedures/"), or "" when the names have no common scope. */
function commonScope(releases: readonly Release[]): string {
  const names = new Set(releases.flatMap((release) => release.changes.flatMap((change) => change.packages)));
  const scopes = new Set([...names].map((name) => /^(@[^/]+\/)/.exec(name)?.[1] ?? ""));
  const [scope] = scopes;
  return scopes.size === 1 && scope ? scope : "";
}

/** The counter for the IDs of the lists that a button opens. */
interface Ids {
  next: number;
}

function toggleButton(ids: string, more: string, less: string, hidden = ""): string {
  return (
    `<button type="button" class="sp-ghost" data-sp-js data-sp-toggle aria-controls="${ids}" aria-expanded="false"` +
    ` data-more="${escapeHtml(more)}" data-less="${escapeHtml(less)}"><span data-sp-label>${escapeHtml(more)}</span>${hidden}</button>`
  );
}

function chips(packages: readonly string[], scope: string, ids: Ids): string {
  if (packages.length === 0) return "";
  const id = `k${ids.next++}`;
  const items = packages.map((name, index) => {
    const short = scope && name.startsWith(scope) ? name.slice(scope.length) : name;
    const extra = index >= FIRST_CHIPS;
    return `<span class="sp-pill${extra ? " sp-extra" : ""}" title="${escapeHtml(name)}"${extra ? " hidden" : ""}>${escapeHtml(short)}</span>`;
  });
  const more = packages.length - FIRST_CHIPS;
  const button = more > 0 ? toggleButton(id, `+${more} more`, "Fewer", '<span class="sp-visually-hidden"> packages</span>') : "";
  return `<span class="sp-chips" id="${id}">${items.join("")}${button}</span>`;
}

function changeItem(change: ReleaseChange, index: number, repository: string, scope: string, ids: Ids): string {
  const extra = index >= FIRST_CHANGES;
  const commit = change.commit
    ? link(`https://github.com/${repository}/commit/${change.commit}`, `<code>${escapeHtml(change.commit)}</code>`, `class="sp-commit" title="${escapeHtml(`Commit ${change.commit} on GitHub`)}"`)
    : "";
  const meta = commit || change.packages.length > 0 ? `<div class="sp-change-meta">${commit}${chips(change.packages, scope, ids)}</div>` : "";
  return `<li class="sp-change${extra ? " sp-extra" : ""}"${extra ? " hidden" : ""}><p>${inlineMarkdown(change.text)}</p>${meta}</li>`;
}

function details(release: Release, index: number, selected: boolean, repository: string, scope: string, ids: Ids): string {
  const info = KIND_INFO[release.kind];
  const links = release.links.map((each) => link(each.url, escapeHtml(each.label))).join("");
  const head =
    `<div class="sp-release-head"><h2 id="h${index}">${escapeHtml(release.version)}</h2><span class="${info.pill}">${escapeHtml(info.label)}</span>` +
    `<time class="sp-small sp-muted" datetime="${escapeHtml(release.date)}">${escapeHtml(longDate(release.date))}</time>` +
    (links ? `<span class="sp-release-links sp-small">${links}</span>` : "") +
    "</div>";
  let body: string;
  if (release.changes.length === 0) {
    body = '<p class="sp-small sp-muted">The sources have no change entry for this version.</p>';
  } else {
    const packages = new Set(release.changes.flatMap((change) => change.packages)).size;
    const count = packages > 0
      ? `${plural(release.changes.length, "change")} in ${plural(packages, "package")}. The changes with the most packages come first.`
      : `${plural(release.changes.length, "change")}.`;
    const listId = `c${index}`;
    const items = release.changes.map((change, position) => changeItem(change, position, repository, scope, ids));
    const all = release.changes.length > FIRST_CHANGES ? toggleButton(listId, `Show all ${release.changes.length} changes`, "Show fewer changes") : "";
    body = `<p class="sp-small sp-muted">${escapeHtml(count)}</p><ul class="sp-changes" id="${listId}">${items.join("")}</ul>${all}`;
  }
  return (
    `<section class="sp-panel sp-release" id="v${escapeHtml(release.version)}" data-sp-release data-version="${escapeHtml(release.version)}"` +
    ` aria-labelledby="h${index}"${selected ? "" : " hidden"}>${head}${body}</section>`
  );
}

/**
 * The inline module of the releases page. It selects a version on a click, with the arrow keys,
 * Home, End, Enter and Space. It also opens the long lists and keeps the version in the URL.
 */
export const RELEASES_SCRIPT: string = String.raw`
const boxes = Array.from(document.querySelectorAll("[data-sp-timeline]"));
const panels = new Map(Array.from(document.querySelectorAll("[data-sp-release]"), (panel) => [panel.dataset.version, panel]));
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let selected = (document.querySelector("[data-sp-release]:not([hidden])") || {}).dataset?.version;
const markIn = (box, version) => Array.from(box.querySelectorAll("[data-sp-mark]")).find((mark) => mark.dataset.version === version);
function reveal(box, version, smooth) {
  const mark = markIn(box, version);
  if (!mark || box.scrollWidth <= box.clientWidth) return;
  const x = Number(mark.dataset.x);
  const margin = Number(mark.dataset.half) + 16;
  if (x - margin >= box.scrollLeft && x + margin <= box.scrollLeft + box.clientWidth) return;
  box.scrollTo({ left: x - box.clientWidth / 2, behavior: smooth && !reduced ? "smooth" : "auto" });
}
function select(version, box) {
  const panel = panels.get(version);
  if (!panel) return;
  selected = version;
  for (const each of boxes) {
    for (const mark of each.querySelectorAll("[data-sp-mark]")) {
      const on = mark.dataset.version === version;
      mark.classList.toggle("sp-selected", on);
      mark.setAttribute("aria-pressed", String(on));
      mark.setAttribute("tabindex", on ? "0" : "-1");
    }
  }
  for (const [key, each] of panels) each.hidden = key !== version;
  if (box) {
    const mark = markIn(box, version);
    if (mark) mark.focus({ preventScroll: true });
    reveal(box, version, true);
  }
  try {
    history.replaceState(null, "", "#" + encodeURIComponent(panel.id));
  } catch {}
}
for (const box of boxes) {
  box.addEventListener("click", (event) => {
    const mark = event.target.closest("[data-sp-mark]");
    if (mark) select(mark.dataset.version, box);
  });
  box.addEventListener("keydown", (event) => {
    const mark = event.target.closest("[data-sp-mark]");
    if (!mark || event.altKey || event.ctrlKey || event.metaKey) return;
    const marks = Array.from(box.querySelectorAll("[data-sp-mark]"));
    const position = marks.indexOf(mark);
    const targets = { ArrowLeft: position - 1, ArrowRight: position + 1, Home: 0, End: marks.length - 1, Enter: position, " ": position };
    if (!(event.key in targets)) return;
    event.preventDefault();
    const next = marks[Math.max(0, Math.min(marks.length - 1, targets[event.key]))];
    if (next) select(next.dataset.version, box);
  });
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-sp-toggle]");
  const list = button && document.getElementById(button.getAttribute("aria-controls"));
  if (!list) return;
  const open = button.getAttribute("aria-expanded") !== "true";
  for (const extra of list.querySelectorAll(":scope > .sp-extra")) extra.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  const label = button.querySelector("[data-sp-label]");
  if (label) label.textContent = open ? button.dataset.less : button.dataset.more;
});
// A malformed hash, for example "#100%", must not stop the module
let hashed = "";
try {
  hashed = decodeURIComponent(location.hash.slice(1));
} catch {}
for (const [version, panel] of panels) if (panel.id === hashed) select(version, null);
const revealAll = () => { for (const box of boxes) reveal(box, selected, false); };
revealAll();
window.addEventListener("resize", revealAll);
`;

/** This function renders the complete releases page from the data of `releases.json`. */
export function renderReleasesPage(releases: readonly Release[], options: PageOptions): string {
  const newest = releases[0];
  const ordered = oldestFirst(releases);
  const scope = commonScope(releases);
  const ids: Ids = { next: 0 };
  const lead = `<p class="sp-lead">${escapeHtml(releasesLead(releases))}</p>`;
  let content = "";
  if (newest) {
    content =
      `<div class="sp-panel"><p class="sp-small sp-muted">Each mark is one version, on a time axis in UTC. Select a mark to show its changes.</p>` +
      legend(releases) +
      `<div class="sp-timeline-box sp-timeline-narrow" data-sp-timeline>${timelineSvg(ordered, NARROW_WIDTH, newest.version)}</div>` +
      `<div class="sp-timeline-box sp-timeline-wide" data-sp-timeline>${timelineSvg(ordered, WIDE_WIDTH, newest.version)}</div></div>` +
      releases.map((release, index) => details(release, index, index === 0, options.repository, scope, ids)).join("");
  }
  const source =
    '<p class="sp-small sp-muted">Source: the <code>CHANGELOG.md</code> files, the git tags, the GitHub releases and npm, read when the site was built.</p>';
  return pageShell(
    {
      title: "Releases",
      description: releasesLead(releases),
      current: "releases",
      main: `<h1>Releases</h1>${lead}${content}${source}`,
      script: RELEASES_SCRIPT,
    },
    options,
  );
}
