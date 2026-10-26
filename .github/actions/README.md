# Shared actions

These composite actions are shared by the repositories of mark1russell7. A repository uses them from GitHub. `new-repo.ps1` does not copy them. `CI.md` tells about the shared workflows that use them.

| Action | What it does |
|---|---|
| `site-pages` | Writes `releases/index.html`, `status/index.html`, `data/releases.json` and `data/status.json` into the built site (`@mark1russell7/site-pages`). |
| `green-main` | Gives the commit for a scheduled build: the newest commit of `main`, or the newest commit that passed CI when the newest one failed. The site does not get a red commit at any time. It does not step back behind a push deploy at any time. `pending: green` waits for CI in place of the newest commit. |
| `npm-publish` | Publishes the tarballs of the release build to npm, with trusted publishing (OIDC) and provenance. The publish job of `release.yml` uses it (`RELEASING.md`). |
| `setup-playwright` | Installs the Playwright browsers for a browser job. The browsers come from a cache with a key on the Playwright version. With a cache hit, only the system packages install. Each try has a time limit (8 minutes) and the install gets a second try, so a hung download stops in minutes and not at the job timeout. Use it in place of `playwright install --with-deps`. |

A browser job uses `setup-playwright` after the install of its dependencies:

```yaml
      - uses: mark1russell7/template/.github/actions/setup-playwright@<commit> # main
        with:
          browsers: chromium firefox webkit
          command: pnpm --filter @vex/site exec playwright
```

## Add the pages to a site

The shared workflow `reusable-pages.yml` uses `green-main` and `site-pages` (`CI.md`). Replace the `pages.yml` of the repository with a caller of that workflow:

```yaml
on:
  push:
    branches: [main]
  # Every 3 hours, so that the Status page shows the open pull requests and issues of now
  schedule:
    - cron: "17 */3 * * *"
  workflow_dispatch:

permissions: {}

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  pages:
    uses: mark1russell7/template/.github/workflows/reusable-pages.yml@<commit> # main
    permissions:
      contents: read
      # green-main reads the Actions runs. site-pages reads the pull requests, the issues and their checks.
      actions: read
      issues: read
      pull-requests: read
      checks: read
      statuses: read
      # Only the deploy job uses these two
      pages: write
      id-token: write
    with:
      build: pnpm --filter @my/site run build
      out: packages/site/dist
      roadmap: docs/ROADMAP.md
```

Then add the links `releases/` and `status/` to the navigation of the site.

- Pin the workflow to a commit, as for the other actions (`@<commit> # main`). Renovate updates the pin.
- `roadmap` is optional. The parser reads each Markdown table with an `ID` column and a `Status` column.
- A site with its own pages sets `data-only: true` and reads the two JSON files.
- A monorepo with one version for a fixed group sets `group` to the npm name of one package of the group.
- The standard `release.yml` makes a git tag and a GitHub release for each version that it publishes (`RELEASING.md`). The Releases page reads them.
- The inputs of `site-pages` and their defaults are in `site-pages/action.yml`. The options of the CLI are in the README of `packages/site-pages`.

A workflow with its own build job can also use the two actions directly, as steps. Pin each one to a commit: `mark1russell7/template/.github/actions/site-pages@<commit> # main`.

## Test

The workflow `actions-test.yml` tests the three actions and the shared workflows on this repository. It keeps the pages as an artifact. The test of `npm-publish` uses `dry-run: "true"` and publishes nothing.
