/**
 * The standalone status page: the open work of the roadmap file, the open pull requests and the
 * open issues. The build renders the HTML, and one small inline module adds the filters.
 */

import { OPEN_CLASSES } from "../data/status.ts";
import type { BoardItem, CheckState, StatusBoardData, StatusClass } from "../data/types.ts";
import { longDate } from "./dates.ts";
import { escapeHtml, inlineMarkdown, link, listText, plural } from "./html.ts";
import { pageShell, type PageOptions } from "./theme.ts";

/** The label, the icon and the meaning of each class. The page always shows a color with an icon and a label. */
const CLASS_INFO: Record<StatusClass, { label: string; icon: string; meaning: string }> = {
  waiting: { label: "Waiting", icon: "◷", meaning: "It waits for a person or a decision" },
  blocked: { label: "Blocked", icon: "⊘", meaning: "Other work must finish first" },
  progress: { label: "In progress", icon: "◐", meaning: "Work started" },
  open: { label: "Open", icon: "○", meaning: "Nobody started it" },
  later: { label: "Later", icon: "◌", meaning: "It is for later" },
  done: { label: "Done", icon: "✓", meaning: "It is finished" },
};

const CHECK_LABEL: Record<CheckState, string> = {
  success: "Checks pass",
  failure: "Checks fail",
  pending: "Checks run",
  none: "No checks",
};

/**
 * This function gives the lead line of the status page, for example "12 open roadmap items, 9 open
 * pull requests and 0 open issues, read at Oct 19, 2026, 14:05 UTC from abc1234."
 */
export function statusLead(data: StatusBoardData): string {
  const parts: string[] = [];
  if (data.source.roadmap) parts.push(plural(data.items.filter((item) => item.statusClass !== "done").length, "open roadmap item"));
  if (data.github.available) {
    parts.push(plural(data.github.totals?.pullRequests ?? data.pullRequests.length, "open pull request"));
    parts.push(plural(data.github.totals?.issues ?? data.issues.length, "open issue"));
  }
  const commit = data.commit ? data.commit.slice(0, 7) : null;
  const read = `read at ${longDate(data.generatedAt)}${commit ? ` from ${commit}` : ""}`;
  const line = parts.length > 0 ? `${listText(parts)}, ${read}.` : `Read at ${read.slice("read at ".length)}.`;
  return data.github.available ? line : `${line} The build could not read GitHub.`;
}

/** This function gives the part of a URL for a text: "The server stack (R37)" gives "the-server-stack-r37". */
export function slugOf(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "other"
  );
}

/** A section of the roadmap, with the count of its open items and of its done items. */
export interface BoardSection {
  slug: string;
  label: string;
  open: number;
  done: number;
}

/** This function gives the sections of the items, in the sequence of the file. */
export function sectionsOf(items: readonly BoardItem[]): BoardSection[] {
  const sections = new Map<string, BoardSection>();
  for (const item of items) {
    const slug = slugOf(item.section);
    const section = sections.get(slug) ?? { slug, label: item.section || "Other", open: 0, done: 0 };
    if (item.statusClass === "done") section.done++;
    else section.open++;
    sections.set(slug, section);
  }
  return [...sections.values()];
}

/** A group of items with one class. */
export interface ItemGroup {
  statusClass: StatusClass;
  items: BoardItem[];
}

/** This function gives the groups of the open items in the sequence of `OPEN_CLASSES`, without the empty groups. */
export function openGroups(items: readonly BoardItem[]): ItemGroup[] {
  return OPEN_CLASSES.map((statusClass) => ({ statusClass, items: items.filter((item) => item.statusClass === statusClass) })).filter(
    (group) => group.items.length > 0,
  );
}

/** This function counts the items of each class. */
export function classCounts(items: readonly BoardItem[]): Record<StatusClass, number> {
  const counts: Record<StatusClass, number> = { waiting: 0, blocked: 0, progress: 0, open: 0, later: 0, done: 0 };
  for (const item of items) counts[item.statusClass]++;
  return counts;
}

function roadmapUrl(data: StatusBoardData): string {
  return `https://github.com/${data.source.github}/blob/${data.commit ?? "HEAD"}/${data.source.roadmap ?? ""}`;
}

function meter(items: readonly BoardItem[]): string {
  const counts = classCounts(items);
  const order: StatusClass[] = ["done", ...OPEN_CLASSES];
  const present = order.filter((value) => counts[value] > 0);
  const total = Math.max(1, items.length);
  const summary = present.map((value) => `${counts[value]} ${CLASS_INFO[value].label.toLowerCase()}`).join(", ");
  const parts = present.map((value) => `<span class="sp-c-${value}" style="flex-grow:${(counts[value] / total).toFixed(4)}"></span>`);
  const legend = present.map(
    (value) => `<li class="sp-c-${value}"><span class="sp-swatch"></span>${CLASS_INFO[value].label} <strong>${counts[value]}</strong></li>`,
  );
  return (
    `<div class="sp-meter" role="img" aria-label="${escapeHtml(`${plural(items.length, "item")} of the roadmap: ${summary}`)}">${parts.join("")}</div>` +
    `<ul class="sp-meter-legend" aria-hidden="true">${legend.join("")}</ul>`
  );
}

function itemTable(items: readonly BoardItem[], data: StatusBoardData, columns: { owner: boolean; links: boolean }): string {
  const fileUrl = roadmapUrl(data);
  const none = '<span class="sp-muted">—</span>';
  const rows = items.map((item) => {
    const meta = [escapeHtml(item.section), item.area ? inlineMarkdown(item.area) : "", item.needs ? `needs ${inlineMarkdown(item.needs)}` : ""]
      .filter(Boolean)
      .join(" · ");
    const links = item.links.length > 0 ? `<span class="sp-links">${item.links.map((each) => link(each.url, escapeHtml(each.label))).join("")}</span>` : none;
    return (
      `<tr class="sp-c-${item.statusClass}" data-section="${escapeHtml(slugOf(item.section))}">` +
      `<th scope="row">${link(`${fileUrl}?plain=1#L${item.line}`, escapeHtml(item.id), `title="${escapeHtml(`The row of ${item.id} in the roadmap file`)}"`)}</th>` +
      `<td data-label="Item" class="sp-item"><span>${item.title ? inlineMarkdown(item.title) : '<span class="sp-muted">No title</span>'}</span>` +
      `<span class="sp-item-meta sp-small sp-muted">${meta}</span></td>` +
      // One element in each cell: on a phone, the cell is a grid of its label and its content
      (columns.owner ? `<td data-label="Owner">${item.owner ? `<span>${inlineMarkdown(item.owner)}</span>` : none}</td>` : "") +
      `<td data-label="Status"><span class="sp-status"><span aria-hidden="true">${CLASS_INFO[item.statusClass].icon}</span> ` +
      `${inlineMarkdown(item.status || CLASS_INFO[item.statusClass].label)}</span></td>` +
      (columns.links ? `<td data-label="Links">${links}</td>` : "") +
      "</tr>"
    );
  });
  const head =
    '<thead><tr><th scope="col">ID</th><th scope="col">Item</th>' +
    (columns.owner ? '<th scope="col">Owner</th>' : "") +
    '<th scope="col">Status</th>' +
    (columns.links ? '<th scope="col">Links</th>' : "") +
    "</tr></thead>";
  return `<div class="sp-table-box"><table class="sp-table">${head}<tbody>${rows.join("")}</tbody></table></div>`;
}

function openWork(data: StatusBoardData): string {
  const items = data.items;
  const open = items.filter((item) => item.statusClass !== "done");
  const done = items.filter((item) => item.statusClass === "done");
  const counts = classCounts(items);
  const columns = { owner: items.some((item) => item.owner), links: items.some((item) => item.links.length > 0) };
  const file = (data.source.roadmap ?? "").split("/").pop() ?? "";
  const classChips = OPEN_CLASSES.map(
    (value) =>
      `<button type="button" class="sp-chip sp-c-${value}" data-sp-class="${value}" aria-pressed="false" title="${escapeHtml(CLASS_INFO[value].meaning)}">` +
      `<span aria-hidden="true">${CLASS_INFO[value].icon}</span> ${CLASS_INFO[value].label} <span class="sp-count">${counts[value]}</span></button>`,
  );
  const sectionChips = sectionsOf(items)
    .filter((section) => section.open > 0)
    .map(
      (section) =>
        `<button type="button" class="sp-chip" data-sp-section="${escapeHtml(section.slug)}" aria-pressed="false">` +
        `${escapeHtml(section.label)} <span class="sp-count">${section.open}</span></button>`,
    );
  const filters =
    `<div class="sp-filters" role="group" aria-label="Filters of the open work" data-sp-js>` +
    `<span role="group" aria-label="Status of the items">${classChips.join("")}</span>` +
    (sectionChips.length > 1 ? `<span role="group" aria-label="Section of the roadmap">${sectionChips.join("")}</span>` : "") +
    `<button type="button" class="sp-ghost" data-sp-clear hidden>Clear the filters</button></div>`;
  const label = plural(open.length, "open item");
  const groups = openGroups(items).map(
    (group) =>
      `<section class="sp-group sp-c-${group.statusClass}" data-sp-group data-class="${group.statusClass}" aria-labelledby="group-${group.statusClass}">` +
      `<h3 id="group-${group.statusClass}"><span aria-hidden="true">${CLASS_INFO[group.statusClass].icon}</span> ${CLASS_INFO[group.statusClass].label} ` +
      `<span class="sp-group-count" data-sp-group-count>${group.items.length}</span></h3>${itemTable(group.items, data, columns)}</section>`,
  );
  const list =
    open.length === 0
      ? '<p class="sp-callout">The roadmap has no open item.</p>'
      : `<p class="sp-small sp-muted" aria-live="polite" data-sp-shown data-label="${escapeHtml(label)}">${open.length} of ${escapeHtml(label)}</p>` +
        groups.join("") +
        '<p class="sp-callout" data-sp-empty hidden>No open item matches the filters.</p>';
  const doneText = done.length === 1 ? "1 item is done." : `${done.length} items are done.`;
  const doneList =
    done.length === 0
      ? `<p class="sp-done sp-small"><span aria-hidden="true">✓</span> No item is done.</p>`
      : `<details class="sp-done sp-c-done" data-sp-done><summary><span aria-hidden="true">✓</span> ${doneText} ` +
        `<span data-sp-done-label>Show the done items</span></summary>` +
        `<section class="sp-group sp-c-done" data-sp-group data-class="done" aria-label="The done items">${itemTable(done, data, columns)}` +
        '<p class="sp-callout" data-sp-done-empty hidden>No done item matches the filters.</p></section></details>';
  return (
    `<section class="sp-section" aria-labelledby="open-work" data-sp-board><h2 id="open-work">Open work</h2>` +
    `<p class="sp-small sp-muted">Each row of a table of ${link(roadmapUrl(data), `<code>${escapeHtml(file)}</code>`)} with an ID and a status that is not done. ` +
    "The build reads the file, so this list follows each commit.</p>" +
    meter(items) +
    (open.length > 0 ? filters : "") +
    list +
    doneList +
    "</section>"
  );
}

function when(date: string): string {
  const text = escapeHtml(longDate(date));
  return `<time datetime="${escapeHtml(date)}" title="${text}" data-sp-rel>${text}</time>`;
}

function labels(names: readonly string[]): string {
  return names.length === 0 ? "" : `<span class="sp-labels">${names.map((name) => `<span class="sp-pill">${escapeHtml(name)}</span>`).join("")}</span>`;
}

function githubMissing(data: StatusBoardData): string {
  const reason = data.github.reason ? ` (${escapeHtml(data.github.reason)})` : "";
  return `<p class="sp-callout">The build could not read GitHub${reason}. Refer to ${link(`https://github.com/${data.source.github}`, escapeHtml(data.source.github))} on GitHub.</p>`;
}

function pullRequests(data: StatusBoardData): string {
  const total = data.github.totals?.pullRequests ?? data.pullRequests.length;
  let body: string;
  if (!data.github.available) body = githubMissing(data);
  else if (data.pullRequests.length === 0) {
    body = `<p class="sp-callout">No pull request is open. Refer to ${link(`https://github.com/${data.source.github}/pulls?q=is%3Apr`, "all the pull requests")}.</p>`;
  } else {
    const count =
      total > data.pullRequests.length
        ? `The ${data.pullRequests.length} most recently updated of ${plural(total, "open pull request")}.`
        : `${plural(total, "open pull request")}, the most recently updated first.`;
    const cards = data.pullRequests.map(
      (pull) =>
        `<li class="sp-card">${link(pull.url, `<span class="sp-number">#${pull.number}</span> ${escapeHtml(pull.title)}`, 'class="sp-card-title"')}` +
        `<span class="sp-card-meta"><span class="sp-pill${pull.draft ? "" : " sp-accent"}">${pull.draft ? "Draft" : "Ready"}</span>` +
        `<span class="sp-check sp-check-${pull.checks}"><span class="sp-dot-state" aria-hidden="true"></span>${CHECK_LABEL[pull.checks]}</span>` +
        `<span>by ${escapeHtml(pull.author)}</span><code class="sp-branch">${escapeHtml(pull.branch)}</code>` +
        `<span class="sp-muted">updated ${when(pull.updatedAt)}</span>${labels(pull.labels)}</span></li>`,
    );
    body = `<p class="sp-small sp-muted">${escapeHtml(count)}</p><ul class="sp-cards">${cards.join("")}</ul>`;
  }
  return `<section class="sp-section" aria-labelledby="pull-requests"><h2 id="pull-requests">Pull requests</h2>${body}</section>`;
}

function issues(data: StatusBoardData): string {
  const total = data.github.totals?.issues ?? data.issues.length;
  let body: string;
  if (!data.github.available) body = githubMissing(data);
  else if (data.issues.length === 0) {
    body = `<p class="sp-callout">No issue is open. To report a problem, ${link(`https://github.com/${data.source.github}/issues/new`, "open an issue")}.</p>`;
  } else {
    const count =
      total > data.issues.length
        ? `The ${data.issues.length} most recently updated of ${plural(total, "open issue")}.`
        : `${plural(total, "open issue")}, the most recently updated first.`;
    const cards = data.issues.map(
      (issue) =>
        `<li class="sp-card">${link(issue.url, `<span class="sp-number">#${issue.number}</span> ${escapeHtml(issue.title)}`, 'class="sp-card-title"')}` +
        `<span class="sp-card-meta"><span>by ${escapeHtml(issue.author)}</span>` +
        `<span class="sp-muted">updated ${when(issue.updatedAt)}</span>${labels(issue.labels)}</span></li>`,
    );
    body = `<p class="sp-small sp-muted">${escapeHtml(count)}</p><ul class="sp-cards">${cards.join("")}</ul>`;
  }
  return `<section class="sp-section" aria-labelledby="issues"><h2 id="issues">Issues</h2>${body}</section>`;
}

/** The pure helpers of the inline module of the status page. A test reads them from this text. */
export const STATUS_SCRIPT_HELPERS: string = String.raw`
function relativeTime(then, now) {
  const seconds = Math.round((now - then) / 1000);
  if (!Number.isFinite(seconds)) return "at an unknown time";
  if (seconds < 60) return "just now";
  const steps = [[60, "minute"], [3600, "hour"], [86400, "day"], [2592000, "month"], [31536000, "year"]];
  let unit = steps[0];
  for (const step of steps) if (seconds >= step[0]) unit = step;
  const count = Math.floor(seconds / unit[0]);
  return count + " " + unit[1] + (count === 1 ? "" : "s") + " ago";
}
function listOf(text) {
  return (text || "").split(",").filter((part) => part !== "");
}
`;

/**
 * The inline module of the status page. It filters the open work by class and by section, keeps the
 * filters in the URL, and shows the age of each GitHub time.
 */
export const STATUS_SCRIPT: string =
  STATUS_SCRIPT_HELPERS +
  String.raw`
const now = Date.now();
for (const time of document.querySelectorAll("time[data-sp-rel]")) {
  time.textContent = relativeTime(Date.parse(time.dateTime), now) + " (" + time.title + ")";
}
const board = document.querySelector("[data-sp-board]");
if (board) {
  const classChips = Array.from(board.querySelectorAll("[data-sp-class]"));
  const sectionChips = Array.from(board.querySelectorAll("[data-sp-section]"));
  const groups = Array.from(board.querySelectorAll("[data-sp-group]"));
  const shown = board.querySelector("[data-sp-shown]");
  const empty = board.querySelector("[data-sp-empty]");
  const clear = board.querySelector("[data-sp-clear]");
  const done = board.querySelector("[data-sp-done]");
  const query = new URLSearchParams(location.search);
  const state = {
    classes: listOf(query.get("status")).filter((value) => classChips.some((chip) => chip.dataset.spClass === value)),
    sections: listOf(query.get("section")),
  };
  if (done && query.get("done") === "1") done.open = true;
  const apply = (write) => {
    for (const chip of classChips) chip.setAttribute("aria-pressed", String(state.classes.includes(chip.dataset.spClass)));
    for (const chip of sectionChips) chip.setAttribute("aria-pressed", String(state.sections.includes(chip.dataset.spSection)));
    let count = 0;
    for (const group of groups) {
      const isDone = group.dataset.class === "done";
      const classOn = isDone || state.classes.length === 0 || state.classes.includes(group.dataset.class);
      let visible = 0;
      for (const row of group.querySelectorAll("tr[data-section]")) {
        const on = classOn && (state.sections.length === 0 || state.sections.includes(row.dataset.section));
        row.hidden = !on;
        if (on) visible++;
      }
      if (isDone) {
        const none = group.querySelector("[data-sp-done-empty]");
        if (none) none.hidden = visible > 0;
      } else {
        group.hidden = visible === 0;
        const badge = group.querySelector("[data-sp-group-count]");
        if (badge) badge.textContent = String(visible);
        count += visible;
      }
    }
    if (shown) shown.textContent = count + " of " + shown.dataset.label;
    if (empty) empty.hidden = count > 0;
    if (clear) clear.hidden = state.classes.length === 0 && state.sections.length === 0;
    if (done) {
      const label = done.querySelector("[data-sp-done-label]");
      if (label) label.textContent = done.open ? "Hide the done items" : "Show the done items";
    }
    if (!write) return;
    const next = new URLSearchParams(location.search);
    const put = (key, value) => (value ? next.set(key, value) : next.delete(key));
    put("status", state.classes.join(","));
    put("section", state.sections.join(","));
    put("done", done && done.open ? "1" : "");
    const search = next.toString();
    try {
      history.replaceState(null, "", location.pathname + (search ? "?" + search : "") + location.hash);
    } catch {}
  };
  const toggle = (list, value) => (list.includes(value) ? list.filter((each) => each !== value) : list.concat(value));
  board.addEventListener("click", (event) => {
    const chip = event.target.closest("button");
    if (!chip) return;
    if (chip.dataset.spClass) state.classes = toggle(state.classes, chip.dataset.spClass);
    else if (chip.dataset.spSection) state.sections = toggle(state.sections, chip.dataset.spSection);
    else if (chip.hasAttribute("data-sp-clear")) {
      state.classes = [];
      state.sections = [];
    } else return;
    apply(true);
  });
  if (done) done.addEventListener("toggle", () => apply(true));
  apply(false);
}
`;

/** This function renders the complete status page from the data of `status.json`. */
export function renderStatusPage(data: StatusBoardData, options: PageOptions): string {
  const lead = statusLead(data);
  const main =
    `<h1>Status</h1><p class="sp-lead">${escapeHtml(lead)}</p>` +
    '<p class="sp-small sp-muted">The build reads the roadmap file and GitHub again after each commit and on a schedule.</p>' +
    (data.source.roadmap ? openWork(data) : "") +
    pullRequests(data) +
    issues(data);
  return pageShell({ title: "Status", description: lead, current: "status", main, script: STATUS_SCRIPT }, options);
}
