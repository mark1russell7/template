# Shared actions

These composite actions are shared by the repositories of mark1russell7. A repository uses them from GitHub. `new-repo.ps1` does not copy them. `CI.md` tells about the shared workflows that use them.

| Action | What it does |
|---|---|
| `site-pages` | Writes `releases/index.html`, `status/index.html`, `data/releases.json` and `data/status.json` into the built site (`@mark1russell7/site-pages`). |
| `green-main` | Gives the commit for a scheduled build: the newest commit of `main`, or the newest commit that passed CI when the newest one failed. The site does not get a red commit at any time. It does not step back behind a push deploy at any time. `pending: green` waits for CI in place of the newest commit. With `commit`, it reads the CI state of that commit. |
| `build-ref` | Decides if `reusable-pages.yml` builds and deploys the commit of the event. The job build checks out that commit with no ref. The action reads the event file and fails closed: it stops the job for an event or a field that it does not know. A `workflow_run` takes only a passed run of a push or of `workflow_dispatch`, on the default branch, of the same repository. Thus a run of a fork does not deploy at any time. |
| `npm-publish` | Publishes the tarballs of the release build to npm, with trusted publishing (OIDC) and provenance. The publish job of `release.yml` uses it (`RELEASING.md`). |
| `setup-playwright` | Installs the Playwright browsers first and their system packages second, for a browser job. The browsers and the downloaded `.deb` files come from a cache with a key on the runner image and the Playwright version, so only the first run of a version downloads from the package mirror. apt waits for the dpkg lock and tries a failed download again. Each install has 2 tries, and each try has a time limit (12 minutes). A stopped try is cleaned up (a leftover apt-get is stopped and dpkg repaired) before the next try. The input `packages` tells what a failure of the system packages does (the list below tells its values). The output `packages` is `installed` or `missing`. The step saves the cache only when the output is `installed`. Use it in place of `playwright install --with-deps`. When a job can run in a container, the Playwright image (`mcr.microsoft.com/playwright:v<version>-noble`) is faster still: it needs no install. |
| `setup-cue` | Installs the cue CLI of one version (the input `version`). The archive comes from a cache, or from the release of `cue-lang/cue`. Each request has 8 more tries, 15 s apart, and each try stops after 60 s. Each run checks the sha256 of the archive, also on a cache hit. The sha256 comes from the input `sha256`, or from the digest of the asset in the API of the release. The summary of the job tells if the archive came from the cache or from a download. The action has no post step. The input `cue-version` of `reusable-ci.yml` uses it. |
| `changes` | Tells if a pull request changes a file of a gate, with the patterns of `on.pull_request.paths`. A gate workflow starts on each pull request, and its jobs run only on a match (`CI.md`, "A gate with paths"). |
| `gate-summary` | The step of a summary job `<Name> OK`. It passes when each job passed, or when `changes` found no file of the gate and the gate jobs were skipped. |
| `site-check` | Checks a built site in a browser at each width and scheme, and uploads the screenshots. `reusable-pages.yml` uses it. A site with its own Pages workflow uses it before the upload of the Pages artifact. |
| `data-stamps` | Checks the data stamps of the measured pages of a built site. `reusable-pages.yml` uses it. A site with its own Pages workflow uses it before the upload of the Pages artifact. A build of an older commit with no file of stamps warns and skips the gate. |
| `security-scan` | Runs the dependency review, osv-scanner and CodeQL in one job. The last step fails when a scan fails, and names that scan. It replaces the three jobs of `reusable-security.yml` (`CI.md`, "Security"). |
| `changeset-check` | Fails a pull request when a published package changes with no changeset, or when a changeset makes a `0.x` package into `1.0.0`. The job `changesets` of `reusable-ci.yml` uses it (`CI.md`). |
| `coverage` | Starts the tests of each package with Vitest again, with coverage, and writes a table of each package to the summary. An optional floor fails the step. With `deadline`, the step stops the tests in time and names each package that it stopped. The script `deadline.ts` is the one home of the deadline. The job `coverage` of `reusable-ci.yml` uses it (`CI.md`). |
| `env-json` | Sets the environment variables of a JSON object for the next steps. The jobs `checks` and `coverage` of `reusable-ci.yml` use it with the input `env`. |

A browser job uses `setup-playwright` after the install of its dependencies:

```yaml
      - uses: mark1russell7/template/.github/actions/setup-playwright@<commit> # main
        with:
          browsers: chromium firefox webkit
          command: pnpm --filter @vex/site exec playwright
```

The input `packages` has two values:

- `required` (the default): a failure of the system packages fails the step.
- `best-effort`: the step does not fail for the system packages when each browser starts. On Linux, it first probes the package mirror with `apt-get update` (90 seconds at most, with `APT::Update::Error-Mode=any`, so that a host name that does not resolve fails the probe). When the probe fails, the step does not try the system packages.
- With `best-effort`, when the probe or the tries fail, the step starts each browser (a screenshot of `about:blank`, 120 seconds at most). When each browser starts, the step writes a warning, sets the output `packages` to `missing` and passes. When a browser does not start, the step fails.
- On macOS and Windows, `best-effort` has no probe. When the tries fail and each browser starts, the step warns and passes.

The browsers are the requirement of a browser job, and the system packages are a means. With `best-effort`, a package mirror that does not answer does not stop the job, and the step ends in a few minutes. Fonts and other system packages can be missing. A job that needs them (a pixel comparison, a text measure) refuses `missing`:

```yaml
      - id: playwright
        uses: mark1russell7/template/.github/actions/setup-playwright@<commit> # main
        with:
          packages: best-effort
      - if: steps.playwright.outputs.packages == 'missing'
        run: |
          echo "::error::The fonts are missing, so the pixel comparison cannot run."
          exit 1
```

## Add the pages to a site

The shared workflow `reusable-pages.yml` uses `green-main` and `site-pages` (`CI.md`). Replace the `pages.yml` of the repository with a caller of that workflow:

```yaml
on:
  push:
    branches: [main]
  # After a release, so that the Releases page has the new version (the rule pages-after-release)
  workflow_run:
    workflows: [Release]
    types: [completed]
    branches: [main]
  # Every 3 hours, so that the Status page shows the open pull requests and issues of now
  schedule:
    - cron: "17 */3 * * *"
  workflow_dispatch:

permissions: {}

# A deployment in progress always ends. A newer run replaces only a run that waits (the rule main-runs-finish).
concurrency:
  group: pages
  cancel-in-progress: false

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

The workflow `actions-test.yml` tests the three actions and the shared workflows on this repository. It keeps the pages as an artifact. The test of `npm-publish` uses `dry-run: "true"` and publishes nothing. `security.yml` starts `security-scan` on each pull request of this repository, and `scripts/workflows/security-scan.test.ts` tests its last step.
