# Shared actions

These composite actions give each site of mark1russell7 a Releases page and a Status page (`@mark1russell7/site-pages`). A repository uses them from GitHub. `new-repo.ps1` does not copy them.

| Action | What it does |
|---|---|
| `site-pages` | Writes `releases/index.html`, `status/index.html`, `data/releases.json` and `data/status.json` into the built site. |
| `green-main` | Gives the commit for a scheduled build: the newest commit of `main`, or the newest commit that passed CI when the newest one failed. The site never gets a red commit, and never steps back behind a push deploy. `pending: green` waits for CI in place of the newest commit. |

## Add the pages to a site

Make these changes in the `pages.yml` of the repository:

```yaml
on:
  push:
    branches: [main]
  # Every 3 hours, so that the Status page shows the open pull requests and issues of now
  schedule:
    - cron: "17 */3 * * *"
  workflow_dispatch:

jobs:
  build:
    permissions:
      contents: read
      # green-main reads the Actions runs. site-pages reads the pull requests, the issues and their checks.
      actions: read
      issues: read
      pull-requests: read
      checks: read
      statuses: read
    steps:
      # A scheduled build takes the newest commit of main, or the newest green one if CI failed on it
      - id: green
        if: github.event_name == 'schedule'
        uses: mark1russell7/template/.github/actions/green-main@main
      - uses: actions/checkout@v7
        with:
          ref: ${{ steps.green.outputs.sha || github.sha }}
          # The whole history: site-pages reads the dates of the tags
          fetch-depth: 0
          persist-credentials: false
      # (the build of the site)
      - uses: mark1russell7/template/.github/actions/site-pages@main
        with:
          out: packages/site/dist
          roadmap: docs/ROADMAP.md
      - uses: actions/upload-pages-artifact@v5
        with:
          path: packages/site/dist
```

Then add the links `releases/` and `status/` to the navigation of the site.

- Pin each action to a commit, as for the other actions (`@<commit> # main`). Renovate updates the pin.
- `roadmap` is optional. The parser reads each Markdown table with an `ID` column and a `Status` column.
- A site with its own pages sets `data-only: "true"` and reads the two JSON files.
- A monorepo with one version for a fixed group sets `group` to the npm name of one package of the group.
- The standard `release.yml` makes a git tag and a GitHub release for each version that it publishes (`RELEASING.md`). The Releases page reads them.
- The inputs of `site-pages` and their defaults are in `site-pages/action.yml`. The options of the CLI are in the README of `packages/site-pages`.

## Test

The workflow `actions-test.yml` runs both actions on this repository, and keeps the pages as an artifact.
