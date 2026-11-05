# @mark1russell7/site-pages

This package makes two pages for the site of a GitHub repository: a release timeline and a live status page. A command at deploy time reads the sources. It writes the data as JSON, and it writes two standalone HTML pages into the built site.

- **Releases.** A timeline of the versions, with the changes, the commits and the packages of each version.
- **Status.** The open work of the roadmap file, the open pull requests with the state of their checks, and the open issues.

The pages need no framework, no font and no script from another server. A site can also show the JSON with its own components.

```sh
pnpm add -D @mark1russell7/site-pages
```

## The command

Start the command in the root of the repository, after the build of the site:

```sh
site-pages build --out dist --roadmap docs/ROADMAP.md
```

The command writes these files into the output folder:

| File | Content |
| --- | --- |
| `data/releases.json` | The versions, the newest first |
| `data/status.json` | The roadmap items, the open pull requests and the open issues |
| `releases/index.html` | The releases page |
| `status/index.html` | The status page |

The options:

| Option | Default | Function |
| --- | --- | --- |
| `--out <dir>` | (necessary) | The built output folder of the site |
| `--repo <owner/name>` | `$GITHUB_REPOSITORY`, else the remote `origin` | The repository on GitHub |
| `--base </name/>` | `/<name>/`, or `/` for `<owner>.github.io` | The path of the site home, for the links of the pages |
| `--roadmap <file>` | none | The roadmap file. Without it, the status page has only the GitHub part. |
| `--packages <names>` | none | npm names or a scope (`@procedures`), separated by commas, for the npm dates |
| `--changesets <glob>` | `packages/*/CHANGELOG.md`, else `CHANGELOG.md` | The changelog files |
| `--group <name>` | none | The npm name of the package whose changelog gives the versions |
| `--token <token>` | `$GITHUB_TOKEN` | A GitHub token with read access |
| `--css <file>` | none | More CSS for the pages, after the default CSS |
| `--site-name <name>` | the name of the repository | The name of the site in the header of the pages |
| `--data-only` | off | Write only the JSON files, not the pages |

The exit code is 0 after a build. It is 1 when a changelog or the roadmap is not correct, and 2 for an incorrect command line.

A failure of GitHub or npm does not stop the build. Without a token, or when GitHub does not answer, the command writes a warning. Then the data has no GitHub part, and the status page tells why.

Give the token in the environment variable `GITHUB_TOKEN`, not with `--token`. Other processes can see a command line.

## The check of a site

The command `site-pages check` opens the pages of a site in a headless Chromium. It examines each page at phone and desktop widths, in the light and the dark scheme.

```sh
site-pages check --out dist --repo owner/name --pages /,/releases/ --probe site-probe.js --shots shots
site-pages check --url https://owner.github.io/name/
```

A view fails for each of these problems:

- The page is wider than the screen, or an element goes past the right edge. An element in a box that scrolls or clips does not count here.
- A box with `overflow-x: hidden` or `clip` cuts text at its right edge, at any width. A visitor cannot reach that text.
- A table goes out of view at a phone width. The table is in a box that scrolls, and a text of the table ends past the edge of the box.
- A text area hides a part of its text.
- The page shows no text.
- The page writes a console error, or a script throws an exception.
- A request to the site fails, or gets a status of 400 or more.
- A script or a style sheet does not load, from any origin. An example is a module script that imports `node:perf_hooks`.
- A check of the probe fails, or the probe makes no check.

The text of the problem has the element, the box, the two widths, the width of the view and the start of the text. For example:

```text
a table goes out of view at 360 px: table.api-table in div.table-scroll: content of 736 px in a box of 344 px, "Note". Make the table fit, give the box the class scroll-cue, or add data-overflow-ok to the box.
```

The rule for a box that scrolls examines only tables, for these reasons:

- A code block, a hex view, a row of tabs and a carousel are meant to scroll, and a visitor sees that they scroll.
- A table in a box that scrolls looks complete on a phone, with no scroll bar. The visitor does not see the last columns.
- The class `scroll-cue` shows a shade at the edge of the box, so a table in such a box does not count. The shade shows only when the cells have no background color of their own.
- A false alarm costs more than a miss, because each false alarm needs an exception in the site.

A table is `table`, `role="table"` or `role="grid"`. A desktop view has a scroll bar, so a table in a box that scrolls is not a problem there. `report.json` still shows the table in `measure.cut`.

These items do not count as cut text:

- Text in a box with `text-overflow: ellipsis`.
- Text for a screen reader: `.sr`, `.sr-only`, `.visually-hidden`, `.skip`, or an element of 1 px or less, with or without a clip.
- Hidden text: `display: none`, `visibility: hidden`, `opacity: 0` or `aria-hidden="true"`.
- A decorative element with no text, and text in an `svg`.
- An overflow of 1 px or less. This tolerance is for rounding.

Vertical overflow does not count, because an accordion and a list with a line clamp use it on purpose.

The attribute `data-overflow-ok` marks a box that is meant to scroll or to clip. Put it on the box or on an element around the box:

```html
<div class="result-scroll" data-overflow-ok><table>...</table></div>
```

Use the attribute for a data table with many columns, a marquee or a slider. For an API table, the better fix is a layout that fits the phone.

The check serves one site, so a request to another site of the same origin gets a 404. A page that links to other sites names their paths in a meta tag. The content is a regular expression for the full path:

```html
<meta name="site-check-other-paths" content="^/[^/]+/$">
```

A status of 400 or more on a path that matches is not a problem. Other faults on that path still count: a failed request, a console error and an exception.

A passing check proves what it asserts, not the page. Read the screenshots at full size before a merge. When a read finds a fault that a script can find, add it to this check.

The probe is a JavaScript file or a TypeScript file (`.ts`, `.mts` or `.cts`). Its code is the body of an async function. These functions are available:

| Function | Operation |
| --- | --- |
| `check(name, ok, detail)` | Records a check. A false `ok` fails it, and `detail` tells why. |
| `$(selector)`, `$$(selector)` | Find one element, or all of them |
| `click(element)`, `type(element, text)` | Click an element, or write text into a field with an `input` event |
| `wait(ms)`, `until(fn, ms)` | Wait, or wait until `fn` gives a true value |

```js
type("#editor", "Utilize the cache.");
check("the linter finds a word", await until(() => $$(".finding").length === 1), $$(".finding").length);
```

For a TypeScript probe, the check removes the types and the line `export {};` before it runs the probe. Thus the typecheck of the site examines the probe, and the site needs no build step for it. Each line stays at its position, so the line of an error is the line of the source. Declare the functions of the table with `declare const`, and add `export {};` at the end, so the file is a module. `probeScript` does the same operation for a script of your own.

The check runs the probe on the first page, in the first scheme, at each width. The folder of `--shots` gets a screenshot of each view, `report.json` and `summary.md`. The exit code is 0 when each view passes, 1 when a view fails, and 2 for an incorrect command line.

The check finds a browser in this order: `--browser`, `$SITE_CHECK_BROWSER`, the newest Chromium of Playwright, and then Chrome or Edge. The folder `src/check` imports only Node.js. Thus Node.js 22.18 or later can start `src/check/main.ts` with no install. The workflow `reusable-pages.yml` of the template uses it this way.

## The freshness of a measured page

A measured page shows numbers from a run. The numbers become old when the run becomes old or when an engine has a new release. A site keeps one file of data stamps. Each stamp names the page, its runs, the date of each run and the engine versions of each run. The gate reads this file:

```sh
site-pages freshness --stamps data/stamps.json
```

```json
{
  "schema": "data-stamp/1",
  "pages": [
    {
      "page": "index.html",
      "runs": [{ "id": "101", "url": "https://github.com/owner/repo/actions/runs/101", "date": "2026-11-02T10:00:00Z", "engines": { "@scope/engine": "0.7.0" } }],
      "inFlight": { "id": "102", "url": "https://github.com/owner/repo/actions/runs/102", "date": "2026-11-04T10:00:00Z", "engines": { "@scope/engine": "0.8.0" } }
    }
  ]
}
```

The gate has three rules. A fault of one rule gives the exit code 1.

1. Each page names a run, and each run has an id, a link, a date and its engine versions.
2. The data of a page is at most 3 days old (`MAX_DATA_AGE_DAYS`), or a run on newer engines is in flight. The stamp of that run is at most 3 days old, so an old stamp does not hold the gate open.
3. The engines of the newest run are at most 1 minor version behind npm at the start of the run (`MAX_MINORS_BEHIND`). A release during a long run does not fail the gate.

Two fields of a stamp change the age rule:

- `"study": true` marks a fixed study. The data has no age limit, and the rule 3 does not apply. The run names the method or the run, the date and the engine version. The stamp line tells in plain words that the page is a fixed study of that version. A page with a claim about the current engine is not a fixed study.
- `"limit"` sets a longer age limit: `{ "days": 7, "reason": "The scan is weekly.", "workflow": ".github/workflows/scan.yml" }`. The stamp line shows the limit and the reason. The schedule of that workflow must meet the limit, or the gate fails. A limit with no schedule fails. A limit over 14 days (`MAX_LIMIT_DAYS_WITHOUT_RULING`) also needs a `ruling`, a public https link for that site.

When npm does not answer, the gate prints the rule 3 under `Not run` and does not fail. A workflow turns the gate on with the input `data-stamps` of `reusable-pages.yml`. The gate then runs from the template commit, so it needs no install.

`renderDataStamp(stamp)` gives the line that the page shows with its data: the run, its date, its engine versions and the run in flight.

A Vite site uses the plugin `siteStamps` from `@mark1russell7/site-pages/vite`. Give the stamps, or a function that reads them from the record of the run. The plugin replaces `<!-- data-stamp -->` in each measured page. It also adds `data-stamps.json` to the built site. So the page and the gate read one record:

```ts
export default defineConfig({
  plugins: [siteStamps(() => stampsOf(readRun()))],
});
```

```yaml
      data-stamps: packages/site/dist/data-stamps.json
```

A fault stops the build. A fault is a bad stamp, a mark with no stamp or a stamp with no mark. A stamp of a page that the build does not hold is also a fault.

## The releases

The command merges four sources by version:

1. **The changelogs of Changesets.** Each `## 1.2.3` section of a `CHANGELOG.md` gives a version and its changes. Each change has its commit, the first sentence of its text, and the packages that list it.
2. **The GitHub releases.** Each release gives a version (from its tag), a date and a link. When no changelog has the version, the list items of the release text are the changes.
3. **The git tags.** The tags `1.2.3`, `v1.2.3` and `name@1.2.3` give the date of a version.
4. **npm.** The publication time of each version of `--packages` is the last source of a date.

The date of a version comes from the git tag, else from the GitHub release, else from npm. Else it comes from the commit that added the version heading to the changelog. A version without a date gets the date of the next version, and the command writes a warning.

The pipeline needs the full history for the tags and the commits. Use `fetch-depth: 0` in `actions/checkout`.

For a monorepo with one version for all its packages, give `--group` and the name of one package. Then only its changelog gives the versions, and the dates come from its tags. Without `--group`, each version of each source is a version.

A repository can have no changelog and no GitHub release. Then each npm version of each package of `--packages` is a release:

- The label is the version when there is one package. With more packages, the label is the name without its scope and the version, for example `service@0.5.8`.
- The kind comes from the step after the previous version of the same package. The first version of each package has the kind `first`.
- A version with a prerelease part is not a release. npm also keeps the placeholder `0.0.0-bootstrap.0` of a new package.
- The change of a release names its package, and the link goes to the version on npm.

The kind of a version:

| Kind | Rule |
| --- | --- |
| `first` | The oldest version |
| `major` | `X.0.0`, with `X` of 1 or more |
| `minor` | The PATCH number is 0 |
| `patch` | All other versions |

## The status

The command reads two forms of a roadmap file. It reads both forms in one file, and it keeps the items in the order of the file.

### The tables

The command reads each Markdown table of the roadmap file with an `ID` column and a `Status` column. Each row is one item, and the heading above the table is its section. The header names match without case.

| Column | Use |
| --- | --- |
| `ID` | The ID of the item. A row without an ID is not an item. |
| `Status` | Free text. Its first keyword gives the class of the item. |
| `Item` or `Title` | The text of the item |
| `Owner`, `Area`, `Needs` | Optional fields |
| `Where`, `Commit`, `Links`, `PR` | The links: Markdown links, `#12`, `PR #12` and commit hashes in code spans |

The classes, in the sequence of the page:

| Class | Keywords |
| --- | --- |
| `waiting` | waiting, waits, awaiting, needs |
| `blocked` | blocked |
| `progress` | in progress, active, ongoing, started, wip |
| `open` | not started, to do, and a status without a keyword |
| `later` | later, deferred, postponed, someday |
| `done` | done, shipped, merged, fixed, released, complete, closed, dropped, cancelled, wontfix, and the word in `## Never` |

A row whose cells do not match the header stops the build with the file and the line. Thus the page does not lose an item without a message.

### The item headings

The command also reads each heading `` ### `id`: Title `` under a `##` heading. The `##` heading is the section and the status of its items, for example `## Waiting on Mark`, `## Later` or `## Shipped`. A dash can replace the colon.

```md
## Waiting on Mark

### `eval-b`: Eval, part B

- Area: Site and growth
- Waits for: `eval`
- [crawler #22](https://github.com/acme/crawler/pull/22)
```

The command also reads the heading `### S1 · Title`: the ID is one word before the middle dot. A list item `Status:` gives the status of its item, and it wins over the `##` heading.

```md
### S1 · Detection and divergence in Docker

- **Status:** in progress
- **Area:** program
- **Depends on:** S0
- **Links:** [The results](https://example.com/results/)
```

- The list items `Area:`, `Owner:` and `Waits for:` (or `Depends on:`) give the optional fields. A label can be bold.
- The list item `Links:` and the other list items give the links: Markdown links, `#12`, `PR #12` and commit hashes in code spans.
- A `###` heading without an ID is not an item. A heading without a `##` heading above it and without a `Status:` item is not an item either. The text of an item is not read.
- A roadmap without a table and without an item heading stops the build.

The GitHub part comes from one GraphQL request: the 50 open pull requests and the 50 open issues that changed last, with the totals.

## The data shapes

`data/releases.json` holds an array of `Release`, the newest version first:

```ts
interface Release {
  version: string;
  date: string; // ISO 8601
  kind: "first" | "major" | "minor" | "patch";
  changes: Array<{ commit: string | null; text: string; packages: string[] }>; // text is inline Markdown
  links: Array<{ label: string; url: string }>; // the GitHub release or the tag, the changelog section, npm
}
```

`data/status.json` holds one `StatusBoardData`:

```ts
interface StatusBoardData {
  generatedAt: string; // ISO 8601
  commit: string | null;
  source: { roadmap: string | null; github: string }; // github is "owner/name"
  items: Array<{
    id: string;
    title: string;
    status: string;
    statusClass: "waiting" | "blocked" | "progress" | "open" | "later" | "done";
    owner?: string;
    area?: string;
    needs?: string;
    section: string;
    line: number;
    links: Array<{ label: string; url: string }>;
  }>;
  pullRequests: Array<{
    number: number;
    title: string;
    url: string;
    author: string;
    branch: string;
    draft: boolean;
    createdAt: string;
    updatedAt: string;
    labels: string[];
    checks: "success" | "failure" | "pending" | "none";
  }>;
  issues: Array<{ number: number; title: string; url: string; author: string; createdAt: string; updatedAt: string; labels: string[] }>;
  github: { available: boolean; reason?: string; totals?: { pullRequests: number; issues: number } };
}
```

The package exports these types: `Release`, `ReleaseChange`, `StatusBoardData`, `BoardItem`, `BoardPullRequest` and `BoardIssue`.

## A site with its own components

A site can show the data with its own components, and keep its own pages:

- Start `site-pages build --data-only`. The command then writes only the JSON files.
- Read `<base>data/releases.json` and `<base>data/status.json` in the browser, or read the files in the build of the site.
- Import the types from the package: `import type { Release, StatusBoardData } from "@mark1russell7/site-pages"`.

The functions of the command are also in the package:

| Function | Result |
| --- | --- |
| `readReleases(options)` | The releases of a repository on disk, with GitHub and npm |
| `mergeReleases(sources)` | The releases from sources that the caller reads |
| `readStatusBoard(options)` | The status data of a repository on disk, with GitHub |
| `githubReleases`, `githubOpenWork`, `npmPublishTimes` | The data of one source. After an error, each function gives `{ available: false, reason }`. It does not throw. |
| `renderReleasesPage(releases, options)`, `renderStatusPage(data, options)` | The HTML of a page |
| `timelineLayout(releases, { width })` | The positions of the marks of the timeline |

## The look of the pages

The pages have the light and the dark colors. They obey `prefers-color-scheme`. A `data-theme="light"` or `data-theme="dark"` attribute on the `html` element has priority.

The CSS uses variables. To change them, give a CSS file with `--css`:

```css
:root {
  --sp-accent: #b4232a;
  --sp-font: "Inter", system-ui, sans-serif;
}
:root[data-theme="dark"] {
  --sp-accent: #ff8a80;
}
```

The variables are `--sp-bg`, `--sp-surface`, `--sp-sunken`, `--sp-fg`, `--sp-fg-2`, `--sp-muted`, `--sp-rule`, `--sp-rule-strong`, `--sp-accent`, `--sp-accent-strong` and `--sp-accent-wash`. The status colors are `--sp-good`, `--sp-warn`, `--sp-bad` and `--sp-neutral`, with `-ink` variants for text. `--sp-font`, `--sp-mono`, `--sp-radius` and `--sp-width` set the fonts and the layout.

The pages operate at a width of 390 px without horizontal scroll. The timeline scrolls in its own box. The keyboard operates all controls: the arrow keys, Home and End move between the versions, and Enter or Space selects one. Without JavaScript, the releases page shows all versions.

## A cue on a box that scrolls

A wide code block or table on a narrow screen scrolls sideways. Without a cue, its text looks cut. The file `scroll-cue.css` of the package gives a cue:

- A shade shows at each edge that has more content. At an end of the box, the shade of that end goes.
- The cue uses only CSS. It needs no JavaScript.

Import the file in the site, and give the class `scroll-cue` to the box:

```ts
import "@mark1russell7/site-pages/scroll-cue.css";
```

```html
<pre class="scroll-cue">pnpm add @mark1russell7/site-pages</pre>
```

The class sets `overflow-x: auto` and the background color of the box. Set `--scroll-cue-bg` to the background color of the box, and `--scroll-cue-shade` to the color of the shade:

```css
.code {
  --scroll-cue-bg: var(--code-bg);
}
```

## The page helpers

The entry `@mark1russell7/site-pages/chrome` has small helpers for the script of a page. It imports no Node.js module, so a site can bundle it for the browser. The package root does not export these helpers. Thus a Node.js program that imports the root gets no DOM types.

| Function | Operation |
| --- | --- |
| `h(tag, attrs, ...children)` | Makes an element. The attribute `class` sets the class name. `false`, `null` and `undefined` give no attribute and no child. |
| `byId(id)` | Gives the element with the ID. It throws when the page has no such element. |
| `setupTheme(button, storageKey)` | Makes a theme button: auto, light, dark, in turn. It sets `data-theme` on the `html` element and keeps the choice in `localStorage`. |
| `currentTheme()`, `nextTheme(storageKey)`, `applyTheme(theme, storageKey)` | Read the theme, set the next theme, or set one theme. A site with its own button, for example a React component, uses them. |
| `copyText(button, text, options)` | Copies a text. The button shows "Copied" or "Copy failed" for 1600 ms. |
| `copyToClipboard(text)` | Copies a text with the Clipboard API, else with `document.execCommand`. It gives `true` after a copy. |
| `showBuild(element, build, repository)` | Adds "Version 1.2.3, build abc1234 of 2026-11-03" to an element. The commit is a link to GitHub. |

```ts
import { byId, copyText, h, setupTheme } from "@mark1russell7/site-pages/chrome";

setupTheme(byId<HTMLButtonElement>("theme"), "my-site-theme");
const copy = h("button", { type: "button", class: "copy" }, "Copy");
copy.addEventListener("click", () => void copyText(copy, "pnpm add my-package"));
byId("install").append(copy);
```

The theme `auto` removes `data-theme`, and the CSS of the site then obeys `prefers-color-scheme`. Put this script in the `head` of the page, with the same key. It sets the theme before the first paint, so a dark page does not show white for a moment. A site with the plugin `siteShell` does not need this script, because the plugin adds it:

```html
<script>
  try {
    const t = localStorage.getItem("my-site-theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch {}
</script>
```

## The measures of a site

The file `kpi.json` at the root of a site holds the measures of the project, in the format `kpi/1`. A reader outside the site takes the numbers from this file.

```ts
import { defineConfig } from "vite";
import { siteKpi } from "@mark1russell7/site-pages/vite";

export default defineConfig({
  plugins: [siteKpi({ project: "acme", at: data.at, measures: [{ id: "cases", value: data.cases.length, unit: "cases" }] })],
});
```

```ts
interface KpiFile {
  format: "kpi/1";
  project: string;
  at: string; // the ISO time of the data in UTC, never the time of the build
  commit: string; // the full commit of the build
  measures: Array<{ id: string; value: number; unit?: string; at?: string }>;
  engines?: Array<{ name: string; version: string }>; // the Status page shows them
}
```

- Give `at` from the record of the data. The writer has no default for this field, because a build time hides old data.
- Give `at` on a measure when its data is from another time than the file. The Status page then shows a date for each measure.
- Without `commit`, the plugin takes `GITHUB_SHA`, else the head of the repository.
- A fault in the data stops the build, and the old site stays. A fault is a wrong form, a value that is not finite, a repeated id or a time after the check. The time rules apply to the file and to each measure.
- A site with no Vite build calls `writeKpi(out, input)` from the root entry, before `site-pages build`.
- `site-pages build` reads the file from the output folder. It adds the file to `data/status.json`, and the Status page shows the measures, the data date and the engines.

## The shell of a site

The shell is the part of a page that is not its content. The package has two parts of the shell, and each part is optional.

The entry `@mark1russell7/site-pages/vite` is for `vite.config.ts`. The plugin `siteShell` sets `base` from `SITE_BASE`, sets `build.target` to `es2022`, defines `__BUILD__`, and adds the theme script to the `head` of each HTML page.

```ts
import { defineConfig } from "vite";
import { siteShell } from "@mark1russell7/site-pages/vite";

export default defineConfig({
  root: "site",
  plugins: [siteShell({ themeKey: "my-site-theme" })],
});
```

```ts
import { byId, setupTheme, showBuild, type BuildInfo } from "@mark1russell7/site-pages/chrome";

declare const __BUILD__: BuildInfo;

setupTheme(byId<HTMLButtonElement>("theme"), "my-site-theme");
showBuild(byId("build"), __BUILD__, "owner/my-site");
```

| Export of `./vite` | Operation |
| --- | --- |
| `siteShell({ themeKey, packageFile })` | Makes the plugin. A `base` or a `build.target` in the config of the site has priority. |
| `siteStamps(input)` | Makes the plugin of the data stamps of a site. |
| `themeScript(storageKey)` | Gives the text of the theme script, for a page without the plugin. |
| `siteBase(env)` | Gives `SITE_BASE` with one `/` at the end, or `/`. |
| `buildInfo(version, env, now)` | Gives the data of `__BUILD__`: the short commit, the date and the version. |

The version comes from `../package.json`, relative to the folder of the site. Set `packageFile` to another file, or to `false` for a site with no version.

The file `@mark1russell7/site-pages/shell.css` has the tokens and the rules of the shell. The rules are for the document, the skip link, the header, the links, the theme button, the main column and the footer. Import it before the style sheet of the site, so the rules of the site come last:

```ts
import "@mark1russell7/site-pages/shell.css";
import "./style.css";
```

The file sets no look for the content. Buttons, cards, code and tables stay in the site. The header, the navigation, the footer text and each widget also stay in the site, because each site has its own words there.

A site with its own look does not import `shell.css`. It uses only the plugin and `showBuild`, or nothing from this section.

## The response explorer

The entry `@mark1russell7/site-pages/explorer` shows a measured response in the browser. A visitor chooses a measure, varies one or two dimensions, and holds or facets the others. The view shows the measured points, the fitted curve or surface, and its held-out error in plain words. The record has the format `response-records/1` of `@mark1russell7/rigor-statistics`.

```ts
import { mountExplorer } from "@mark1russell7/site-pages/explorer";
import "@mark1russell7/site-pages/explorer.css";
import record from "./record.json";

mountExplorer(document.getElementById("chart")!, record, { initial: { x: "boxes" } });
```

| Argument | Use |
| --- | --- |
| `host` | The element for the explorer |
| `recordJson` | The record, as JSON text or as parsed data |
| `options.initial` | The first measure, axes, panels and held values. The explorer corrects a value that does not apply. |
| `options.budgetMs` | The time limit of one surface, in milliseconds. The default is 50. |
| `options.now` | The clock, for tests |

`mountExplorer` gives a handle: `state()` reads the current state, and `destroy()` removes the view.

The explorer obeys these rules:

- **A bad record.** The explorer reads a record only through `parseResponseRecord`. It shows each fault with its path, and it does not throw.
- **Conditions.** A dimension with `when` has its parent at a level inside `when`. The controls disable a choice that a view refuses, and they tell why.
- **The band.** The band shows `low` to `high`. It fades with the distance from the nearest measured point.
- **The time of a surface.** The field `nearest` reads each point at each place. So `planSteps` bounds the grid from the point count before the call. After a surface that passes the budget, `nextStepsCap` makes the next grid smaller.
- **A table model.** A table model has no smooth surface, so the view shows cells.
- **No model.** A measure with no valid model shows only the points, and the view says so.

The view draws SVG, and it needs no framework, no font and no script from another server. It reads the tokens of a site when they exist, and it has its own colors for the light and the dark scheme. The keyboard reaches each control, and the arrow keys move a cursor on a chart. "Show the numbers" opens a table of the values.

The entry also exports the pure core, for a site with its own view. These functions are `settle`, `viewOf`, `axisChoices`, `facetChoices`, `holdControls`, `setMeasure`, `setAxis`, `setFacet`, `setHold`, `planSteps`, `nextStepsCap`, `openRecord` and `numberTable`.

## A GitHub Pages workflow

This workflow builds the site, adds the two pages, and deploys. It also starts every 3 hours, so the status page stays current without a push. A scheduled run builds the newest commit of `main` that passed CI.

```yaml
name: Pages

on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]
  schedule:
    - cron: "17 */3 * * *"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    if: >-
      github.event_name != 'workflow_run' ||
      (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' &&
       github.event.workflow_run.head_branch == github.event.repository.default_branch)
    runs-on: ubuntu-latest
    # Read access only: the status page reads the pull requests, the issues and their checks.
    # A scheduled run reads the runs of CI to find the newest commit that passed.
    permissions:
      contents: read
      issues: read
      pull-requests: read
      checks: read
      statuses: read
      actions: read
    steps:
      - name: Select the commit
        id: commit
        env:
          GH_TOKEN: ${{ github.token }}
          EVENT: ${{ github.event_name }}
          RUN_SHA: ${{ github.event.workflow_run.head_sha }}
        run: |
          if [ "$EVENT" = "schedule" ]; then
            sha=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=1" --jq '.workflow_runs[0].head_sha // empty')
          else
            sha="${RUN_SHA:-$GITHUB_SHA}"
          fi
          if [ -z "$sha" ]; then echo "::error::No commit of main passed CI."; exit 1; fi
          echo "sha=$sha" >> "$GITHUB_OUTPUT"
      - uses: actions/checkout@v7
        with:
          ref: ${{ steps.commit.outputs.sha }}
          fetch-depth: 0 # the tags and the history give the release dates
          persist-credentials: false
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build # the build of the site, into dist/
      - run: pnpm exec site-pages build --out dist --roadmap docs/ROADMAP.md
        env:
          GITHUB_TOKEN: ${{ github.token }}
      - uses: actions/upload-pages-artifact@v5
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
```

The token of the build job has read access only. The status page needs `contents`, `issues` and `pull-requests`. The check states need `checks` and `statuses`. The scheduled run needs `actions` to find the commit. Only the deploy job can write to Pages.

The package operates in Node.js 22 or later. The license is MIT.
