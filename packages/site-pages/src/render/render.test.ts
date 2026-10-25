/**
 * The standalone pages: the HTML helpers, the timeline layout (ported from the client site), and
 * the two pages.
 */

import { describe, expect, it } from "vitest";
import { buildStatusBoard, roadmapItems } from "../data/status.ts";
import type { BoardPullRequest, Release, StatusBoardData } from "../data/types.ts";
import { dayRange, longDate, shortDate } from "./dates.ts";
import { escapeHtml, inlineMarkdown, safeUrl } from "./html.ts";
import { releasesLead, renderReleasesPage, RELEASES_SCRIPT } from "./releases.ts";
import { classCounts, openGroups, renderStatusPage, sectionsOf, slugOf, statusLead, STATUS_SCRIPT, STATUS_SCRIPT_HELPERS } from "./status.ts";
import { BASE_CSS, type PageOptions } from "./theme.ts";
import { oldestFirst, releaseSummary, timelineLayout } from "./timeline.ts";

const PAGE: PageOptions = { repository: "acme/widgets", base: "/widgets/", generatedAt: "2026-10-19T14:05:00Z", commit: "abc1234def5678abc1234def5678abc1234def56" };

const RELEASES: Release[] = [
  {
    version: "0.3.1",
    date: "2026-10-18T19:34:06Z",
    kind: "patch",
    changes: [{ commit: "3a235b9", text: "New: the patch operations `$remove` and `$insert`.", packages: ["@acme/client", "@acme/store"] }],
    links: [{ label: "GitHub release", url: "https://github.com/acme/widgets/releases/tag/v0.3.1" }],
  },
  {
    version: "0.3.0",
    date: "2026-10-18T17:10:35Z",
    kind: "minor",
    changes: Array.from({ length: 10 }, (_, index) => ({
      commit: `e2fe00${index}`,
      text: `Change ${index} <b>bold</b>.`,
      packages: ["@acme/a", "@acme/b", "@acme/c", "@acme/d", "@acme/e", "@acme/f"].slice(0, index % 7),
    })),
    links: [{ label: "npm", url: "https://www.npmjs.com/package/@acme/client/v/0.3.0" }],
  },
  { version: "0.2.0", date: "2026-10-16T02:43:51Z", kind: "minor", changes: [], links: [] },
  { version: "0.1.0", date: "2026-10-12T03:36:16Z", kind: "first", changes: [{ commit: null, text: "The core.", packages: [] }], links: [] },
];

/** The absolute URLs of a page, and the attribute of each one. */
function absoluteUrls(html: string): Array<{ attribute: string; url: string }> {
  return [...html.matchAll(/([\w-]+)="(https?:\/\/[^"]*)"/g)].map((match) => ({ attribute: match[1]!, url: match[2]! }));
}

/** This function checks that a page makes no request to another server. */
function expectNoExternalRequest(html: string, allowed: (url: string) => boolean): void {
  expect(html).not.toMatch(/\ssrc=/);
  expect(html).not.toMatch(/<link\b/);
  expect(html).not.toMatch(/@import|url\(/);
  for (const { attribute, url } of absoluteUrls(html)) {
    expect(attribute).toBe("href");
    expect(allowed(url), url).toBe(true);
  }
  // Each absolute URL of the page is in an href
  const all = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].length;
  expect(all).toBe(absoluteUrls(html).length);
}

describe("the HTML helpers", () => {
  it("escape the text and render inline Markdown", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    expect(inlineMarkdown("Use `a <b>` and **bold** and *it* and [the `x` page](https://e.test/a?b=1&c=2).")).toBe(
      'Use <code>a &lt;b&gt;</code> and <strong>bold</strong> and <em>it</em> and <a href="https://e.test/a?b=1&amp;c=2">the <code>x</code> page</a>.',
    );
    expect(inlineMarkdown("[click](javascript:alert) snake_case_name")).toBe("click snake_case_name");
    expect(safeUrl("//evil.test")).toBeNull();
    expect(safeUrl("../data/x.json")).toBe("../data/x.json");
  });

  it("refuse a scheme that control characters, tabs or backslashes hide, as the URL parser of a browser reads it", () => {
    // The URL parser removes the C0 controls and spaces at the two ends, and each tab and line break
    for (const url of ["\x01javascript:alert(1)", "\x00\x1fjavascript:alert(1)", "java\tscript:alert(1)", "jav\nascript:alert(1)", "javascript:alert(1)\x7f\x01"]) {
      expect(safeUrl(url), JSON.stringify(url)).toBeNull();
    }
    expect(inlineMarkdown("[x](\x01javascript:void0) y")).toBe("x y");
    // A browser reads "\" as "/", so these go to a different host
    expect(safeUrl("\\\\evil.test")).toBeNull();
    expect(safeUrl("/\\evil.test")).toBeNull();
    expect(safeUrl("\x01https://e.test/a")).toBe("https://e.test/a");
    expect(safeUrl(" ../data/x.json\x1f")).toBe("../data/x.json");
  });

  it("give the dates in UTC", () => {
    expect(shortDate("2026-10-18T23:30:00-04:00")).toBe("Oct 19");
    expect(longDate("2026-10-18T15:34:06-04:00")).toBe("Oct 18, 2026, 19:34 UTC");
    expect(longDate("not a date")).toBe("an unknown time");
    expect(dayRange(Date.UTC(2026, 9, 13), Date.UTC(2026, 9, 15, 23))).toBe("Oct 13–15");
    expect(dayRange(Date.UTC(2026, 8, 30), Date.UTC(2026, 9, 2))).toBe("Sep 30–Oct 2");
  });
});

describe("the timeline layout", () => {
  /** Releases at the given UTC times, one minute apart when the hours are the same. */
  const at = (...hours: Array<[day: number, hour: number]>): Release[] =>
    hours.map(([day, hour], index) => ({
      version: `0.${index + 1}.0`,
      date: new Date(Date.UTC(2026, 9, day, hour, index)).toISOString(),
      kind: "minor",
      changes: [],
      links: [],
    }));

  it("puts the marks from the oldest to the newest, inside the width", () => {
    const releases = at([12, 3], [16, 2], [18, 19]);
    const layout = timelineLayout([...releases].reverse(), { width: 600 });
    expect(layout.marks.map((mark) => mark.release.version)).toEqual(["0.1.0", "0.2.0", "0.3.0"]);
    for (const mark of layout.marks) {
      expect(mark.x - mark.half).toBeGreaterThanOrEqual(0);
      expect(mark.x + mark.half).toBeLessThanOrEqual(600);
    }
    expect(oldestFirst(releases).map((release) => release.version)).toEqual(["0.1.0", "0.2.0", "0.3.0"]);
  });

  it("makes one narrow band of a run of days without a release", () => {
    const layout = timelineLayout(at([12, 3], [16, 2], [18, 19]), { width: 600 });
    expect(layout.bands.map((band) => [band.label, band.count, band.empty])).toEqual([
      ["Oct 12", 1, false],
      ["Oct 13–15", 0, true],
      ["Oct 16", 1, false],
      ["Oct 17", 0, true],
      ["Oct 18", 1, false],
    ]);
    const [day, gap] = layout.bands;
    expect(gap!.x1 - gap!.x0).toBeLessThan(day!.x1 - day!.x0);
  });

  it("puts marks that are near each other into lanes, so that no two labels in a lane overlap", () => {
    const layout = timelineLayout(at([18, 1], [18, 2], [18, 3], [18, 4], [18, 20]), { width: 400 });
    expect(layout.lanes).toBeGreaterThan(1);
    expect(layout.height).toBe(layout.plotBottom + 46);
    for (const a of layout.marks) {
      for (const b of layout.marks) {
        if (a === b || a.lane !== b.lane) continue;
        expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(a.half + b.half);
      }
    }
    // A mark far from the others goes back to the lane next to the axis
    expect(layout.marks[layout.marks.length - 1]!.lane).toBe(0);
  });

  it("has no mark and no band without a release", () => {
    const layout = timelineLayout([], { width: 400 });
    expect(layout.marks).toEqual([]);
    expect(layout.bands).toEqual([]);
  });

  it("counts the versions and the kinds", () => {
    expect(releaseSummary(RELEASES)).toEqual({ versions: 4, major: 0, minor: 2, patch: 1, first: "2026-10-12T03:36:16.000Z", last: "2026-10-18T19:34:06.000Z" });
  });
});

describe("the releases page", () => {
  const html = renderReleasesPage(RELEASES, PAGE);

  it("has the lead line from the data", () => {
    expect(releasesLead(RELEASES)).toBe("4 versions from Oct 12 to Oct 18, 2026. 2 MINOR releases and 1 PATCH release came after the first release.");
    expect(html).toContain(`<p class="sp-lead">4 versions from Oct 12 to Oct 18, 2026. 2 MINOR releases and 1 PATCH release came after the first release.</p>`);
    expect(releasesLead([])).toBe("The repository has no release yet.");
    expect(releasesLead([RELEASES[3]!])).toBe("1 version, the first release, on Oct 12, 2026.");
  });

  it("has one focusable mark for each version in each of the two timelines, the newest selected", () => {
    const timelines = html.split("data-sp-timeline>").slice(1);
    expect(timelines).toHaveLength(2);
    for (const timeline of timelines) {
      const svg = timeline.slice(0, timeline.indexOf("</svg>"));
      const marks = [...svg.matchAll(/<g class="sp-mark [^"]*" data-sp-mark data-version="([^"]+)"[^>]*>/g)];
      expect(marks.map((mark) => mark[1])).toEqual(["0.1.0", "0.2.0", "0.3.0", "0.3.1"]);
      expect(marks.map((mark) => /tabindex="(-?\d)"/.exec(mark[0])![1])).toEqual(["-1", "-1", "-1", "0"]);
      expect(marks[3]![0]).toContain('aria-label="0.3.1, patch, Oct 18, 1 change"');
      expect(marks[3]![0]).toContain('role="button"');
    }
    expect(html).toContain('width="640"');
    expect(html).toContain('width="920"');
  });

  it("has a details panel for each version: the newest shows, and the others wait for a selection", () => {
    const panels = [...html.matchAll(/<section class="sp-panel sp-release" id="v([^"]+)"[^>]*>/g)];
    expect(panels.map((panel) => panel[1])).toEqual(["0.3.1", "0.3.0", "0.2.0", "0.1.0"]);
    expect(panels.map((panel) => panel[0].includes(" hidden"))).toEqual([false, true, true, true]);
    expect(html).toContain('<a href="https://github.com/acme/widgets/commit/3a235b9" class="sp-commit"');
    expect(html).toContain('<span class="sp-pill" title="@acme/client">client</span>');
    expect(html).toContain("Change 1 &lt;b&gt;bold&lt;/b&gt;.");
    expect(html).toContain("Show all 10 changes");
    expect(html).toContain("+2 more");
    expect(html).toContain("The sources have no change entry for this version.");
  });

  it("makes no request to another server, and links only to the data", () => {
    const links = new Set(RELEASES.flatMap((release) => release.links.map((each) => each.url)));
    expectNoExternalRequest(html, (url) => links.has(url) || url.startsWith("https://github.com/acme/widgets/commit/"));
  });

  it("has the light and the dark colors, and a CSS that a site can extend", () => {
    expect(BASE_CSS).toContain(":root{color-scheme:light;--sp-bg:");
    expect(BASE_CSS).toContain(':root[data-theme="dark"]{color-scheme:dark;');
    expect(BASE_CSS).toContain('@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;');
    for (const variable of ["--sp-bg", "--sp-fg", "--sp-accent", "--sp-font"]) expect(BASE_CSS).toContain(`${variable}:`);
    const custom = renderReleasesPage(RELEASES, { ...PAGE, extraCss: ":root{--sp-accent:#c00}", siteName: "Widgets" });
    expect(custom.indexOf(":root{--sp-accent:#c00}")).toBeGreaterThan(custom.indexOf(BASE_CSS.slice(0, 40)));
    expect(custom).toContain('<a class="sp-home" href="/widgets/">Widgets</a>');
  });

  it("links to the site home and to the status page with the base path", () => {
    expect(html).toContain('<a class="sp-home" href="/widgets/">widgets</a>');
    expect(html).toContain('<a href="/widgets/releases/" aria-current="page">Releases</a>');
    expect(html).toContain('<a href="/widgets/status/">Status</a>');
    expect(html).toContain('href="/widgets/data/releases.json"');
  });

  it("has an inline module that the browser can parse", () => {
    expect(html).toContain(`<script type="module">${RELEASES_SCRIPT}</script>`);
    expect(() => new Function(RELEASES_SCRIPT)).not.toThrow();
  });

  it("has an inline module that a malformed hash in the URL does not stop", () => {
    for (const hash of ["#%E0", "#100%", "#v0.3.1"]) {
      const listeners: string[] = [];
      const document = { querySelectorAll: () => [], querySelector: () => null, addEventListener: () => undefined };
      const window = { matchMedia: () => ({ matches: false }), addEventListener: (name: string) => listeners.push(name) };
      const start = new Function("document", "window", "location", "history", RELEASES_SCRIPT);
      expect(() => start(document, window, { hash }, { replaceState: () => undefined }), hash).not.toThrow();
      // The last statement of the module adds the resize listener
      expect(listeners, hash).toEqual(["resize"]);
    }
  });

  it("says that the repository has no release", () => {
    const empty = renderReleasesPage([], PAGE);
    expect(empty).toContain("The repository has no release yet.");
    expect(empty).not.toContain('<g class="sp-mark');
  });
});

// ---------------------------------------------------------------------------
// The status page
// ---------------------------------------------------------------------------

const ROADMAP = `# Roadmap

## Now

| ID | Item | Status | Owner | Where |
|---|---|---|---|---|
| A1 | The \`site\` page | in progress | \`client\` | PR #4 |
| A2 | A decision | waiting for Mark | — | — |
| A3 | Done work | done | — | \`abcdef1\` |

## Later

| ID | Title | Status |
|---|---|---|
| B1 | A cell | blocked by A1 |
| B2 | Some day | later |
| B3 | Next | next |
`;

const PULL: BoardPullRequest = {
  number: 12,
  title: "site: a <live> board",
  url: "https://github.com/acme/widgets/pull/12",
  author: "mark",
  branch: "site/live",
  draft: false,
  createdAt: "2026-10-18T10:00:00Z",
  updatedAt: "2026-10-19T12:00:00Z",
  labels: ["site"],
  checks: "failure",
};

function board(github: Parameters<typeof buildStatusBoard>[0]["github"], roadmap: string | null = "docs/ROADMAP.md"): StatusBoardData {
  return buildStatusBoard({
    items: roadmap ? roadmapItems(ROADMAP, { file: roadmap, repository: "acme/widgets", ref: "abc1234" }) : [],
    github,
    roadmap,
    repository: "acme/widgets",
    commit: "abc1234def5678",
    generatedAt: "2026-10-19T14:05:00Z",
  });
}

describe("the status page", () => {
  const data = board({ available: true, pullRequests: [PULL], issues: [], totals: { pullRequests: 9, issues: 0 } });
  const html = renderStatusPage(data, PAGE);

  it("has the lead line from the data", () => {
    expect(statusLead(data)).toBe("5 open roadmap items, 9 open pull requests and 0 open issues, read at Oct 19, 2026, 14:05 UTC from abc1234.");
    expect(html).toContain(`<p class="sp-lead">${statusLead(data)}</p>`);
    const offline = board({ available: false, reason: "the build had no GitHub token" });
    expect(statusLead(offline)).toBe("5 open roadmap items, read at Oct 19, 2026, 14:05 UTC from abc1234. The build could not read GitHub.");
    const githubOnly = board({ available: true, pullRequests: [], issues: [], totals: { pullRequests: 0, issues: 1 } }, null);
    expect(statusLead(githubOnly)).toBe("0 open pull requests and 1 open issue, read at Oct 19, 2026, 14:05 UTC from abc1234.");
  });

  it("groups the open work by status class in the sequence of the board, with filter chips", () => {
    expect(openGroups(data.items).map((group) => [group.statusClass, group.items.map((item) => item.id)])).toEqual([
      ["waiting", ["A2"]],
      ["blocked", ["B1"]],
      ["progress", ["A1"]],
      ["open", ["B3"]],
      ["later", ["B2"]],
    ]);
    const groups = [...html.matchAll(/data-sp-group data-class="(\w+)"/g)].map((match) => match[1]);
    expect(groups).toEqual(["waiting", "blocked", "progress", "open", "later", "done"]);
    for (const value of ["waiting", "blocked", "progress", "open", "later"]) expect(html).toContain(`data-sp-class="${value}" aria-pressed="false"`);
    expect(html).toContain('data-sp-section="now" aria-pressed="false"');
    expect(html).toContain("5 of 5 open items");
    expect(classCounts(data.items)).toEqual({ waiting: 1, blocked: 1, progress: 1, open: 1, later: 1, done: 1 });
    expect(sectionsOf(data.items)).toEqual([
      { slug: "now", label: "Now", open: 2, done: 1 },
      { slug: "later", label: "Later", open: 3, done: 0 },
    ]);
    expect(slugOf("The server stack (R37)")).toBe("the-server-stack-r37");
  });

  it("has a done count with a toggle", () => {
    expect(html).toMatch(/<details class="sp-done sp-c-done" data-sp-done><summary><span aria-hidden="true">✓<\/span> 1 item is done\./);
    expect(html).toContain("Show the done items");
  });

  it("shows each pull request with a check dot and a text label, and the empty state of the issues", () => {
    expect(html).toContain('<span class="sp-check sp-check-failure"><span class="sp-dot-state" aria-hidden="true"></span>Checks fail</span>');
    expect(html).toContain("site: a &lt;live&gt; board");
    expect(html).toContain("The 1 most recently updated of 9 open pull requests.");
    expect(html).toContain('No issue is open. To report a problem, <a href="https://github.com/acme/widgets/issues/new">open an issue</a>.');
    expect(html).toContain('<time datetime="2026-10-19T12:00:00Z" title="Oct 19, 2026, 12:00 UTC" data-sp-rel>');
  });

  it("says when the build could not read GitHub", () => {
    const offline = renderStatusPage(board({ available: false, reason: "the build had no GitHub token" }), PAGE);
    expect(offline).toContain("The build could not read GitHub (the build had no GitHub token).");
    expect(offline).not.toContain('<span class="sp-check ');
  });

  it("has only the GitHub part without a roadmap", () => {
    const githubOnly = renderStatusPage(board({ available: true, pullRequests: [], issues: [], totals: { pullRequests: 0, issues: 0 } }, null), PAGE);
    expect(githubOnly).not.toContain("Open work");
    expect(githubOnly).toContain("No pull request is open.");
  });

  it("makes no request to another server, and links only to the data", () => {
    expectNoExternalRequest(html, (url) => url.startsWith("https://github.com/acme/"));
  });

  it("has an inline module that the browser can parse, with relative times", () => {
    expect(html).toContain(`<script type="module">${STATUS_SCRIPT}</script>`);
    expect(() => new Function(STATUS_SCRIPT)).not.toThrow();
    const relativeTime = new Function(`${STATUS_SCRIPT_HELPERS}\nreturn relativeTime;`)() as (then: number, now: number) => string;
    const now = Date.parse("2026-10-19T14:05:00Z");
    expect(relativeTime(Date.parse("2026-10-19T14:04:30Z"), now)).toBe("just now");
    expect(relativeTime(Date.parse("2026-10-19T14:00:00Z"), now)).toBe("5 minutes ago");
    expect(relativeTime(Date.parse("2026-10-19T13:00:00Z"), now)).toBe("1 hour ago");
    expect(relativeTime(Date.parse("2026-10-16T13:00:00Z"), now)).toBe("3 days ago");
    expect(relativeTime(Number.NaN, now)).toBe("at an unknown time");
  });
});
