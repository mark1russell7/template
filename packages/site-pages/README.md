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

## The releases

The command merges four sources by version:

1. **The changelogs of Changesets.** Each `## 1.2.3` section of a `CHANGELOG.md` gives a version and its changes. Each change has its commit, the first sentence of its text, and the packages that list it.
2. **The GitHub releases.** Each release gives a version (from its tag), a date and a link. When no changelog has the version, the list items of the release text are the changes.
3. **The git tags.** The tags `1.2.3`, `v1.2.3` and `name@1.2.3` give the date of a version.
4. **npm.** The publication time of each version of `--packages` is the last source of a date.

The date of a version comes from the git tag, else from the GitHub release, else from npm. Else it comes from the commit that added the version heading to the changelog. A version without a date gets the date of the next version, and the command writes a warning.

The pipeline needs the full history for the tags and the commits. Use `fetch-depth: 0` in `actions/checkout`.

For a monorepo with one version for all its packages, give `--group` and the name of one package. Then only its changelog gives the versions, and the dates come from its tags. Without `--group`, each version of each source is a version.

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

- The list items `Area:`, `Owner:` and `Waits for:` give the optional fields.
- The other list items give the links: Markdown links, `#12`, `PR #12` and commit hashes in code spans.
- A `###` heading without an ID in a code span is not an item. The text of an item is not read.
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
      (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push')
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
