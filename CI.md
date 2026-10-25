# Shared CI workflows

The template holds the CI, the release and the Pages workflows of the repositories of mark1russell7. Each repository keeps short caller workflows. The callers use the shared workflows from GitHub, so a change in the template gets to each repository.

| File | Type | What it does |
|---|---|---|
| `.github/workflows/reusable-ci.yml` | Workflow | Installs with pnpm and starts the standard scripts of `package.json`. |
| `.github/workflows/reusable-release-build.yml` | Workflow | Builds and packs the published packages, and writes the plan of the tags. |
| `.github/actions/npm-publish` | Action | Publishes the tarballs to npm with trusted publishing (OIDC) and provenance. |
| `.github/workflows/reusable-release-tag.yml` | Workflow | Makes a git tag and a GitHub release for each published version. |
| `.github/workflows/reusable-pages.yml` | Workflow | Builds a site, adds the Releases page and the Status page, and deploys it to GitHub Pages. |

## CI

The job of `reusable-ci.yml` installs the dependencies with pnpm. The version of pnpm comes from `packageManager` in `package.json`. Then the job starts each script of the list that `package.json` has. It skips the other scripts. Thus most repositories need no inputs:

```yaml
jobs:
  ci:
    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@<commit> # main
```

The job starts all the scripts, also after a failure. Then it fails with the names of the failed scripts. The summary of the run shows a table of the scripts.

| Input | Default | What it sets |
|---|---|---|
| `scripts` | `format:check typecheck lint test build lint:ste` | The scripts, in sequence. |
| `recursive-scripts` | `build` | The scripts that run in each package when the root `package.json` does not have them. |
| `node-versions` | `["26"]` | The Node.js versions of the matrix, as JSON. |
| `os` | `["ubuntu-latest"]` | The runners of the matrix, as JSON. |
| `setup` | (empty) | A command after the install, before the scripts. |
| `run` | (empty) | A command after the scripts. |
| `env` | `{}` | The environment variables of the job, as a JSON object. |
| `working-directory` | `.` | The folder of `package.json`. |
| `fetch-depth` | `1` | The commits of the checkout. `0` gets the whole history. |
| `timeout-minutes` | `15` | The time limit of each job of the matrix. |

A repository with more checks adds its own jobs next to the job `ci`. An example with inputs:

```yaml
jobs:
  ci:
    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@<commit> # main
    with:
      scripts: build test typecheck
      node-versions: '["22", "24"]'
      os: '["ubuntu-latest", "windows-latest", "macos-latest"]'
      run: npm pack --dry-run
```

## Release

The `release.yml` of a repository keeps four jobs:

1. `verify` uses the `ci.yml` of the repository.
2. `build` uses `reusable-release-build.yml`.
3. `publish` is a job of `release.yml`. Its one step is the action `npm-publish`.
4. `tag` uses `reusable-release-tag.yml`.

```yaml
  publish:
    name: Publish to npm
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      id-token: write
    outputs:
      published: ${{ steps.publish.outputs.published }}
    steps:
      - id: publish
        uses: mark1russell7/template/.github/actions/npm-publish@<commit> # main
```

### Why the publish job stays in `release.yml`

The trusted publisher of each package on npm names the repository and the workflow file `release.yml`. A change to a trusted publisher needs the 2FA of the owner.

- npm compares the trusted publisher with the calling workflow, not with the shared workflow that holds `npm publish` ([npm docs, trusted publishers](https://docs.npmjs.com/trusted-publishers)).
- The npm docs do not tell how npm accepts a shared workflow of a different repository. The question is open ([npm/documentation#1755](https://github.com/npm/documentation/issues/1755)).
- A composite action operates in the job that uses it. Thus the OIDC token and the provenance statement stay the same as before.

Thus the job that holds `id-token: write` stays in `release.yml`, and only its steps are shared. The other jobs need no OIDC token. They are shared workflows.

### The security of the release

- `release.yml` starts with `permissions: {}`. Each job gets only the permissions that it needs.
- The jobs `build` and `verify` run the code of the repository with `contents: read` only.
- The first step of the job `build` stops the run when the commit is not on `main`. Thus a manual run on a different branch publishes nothing (`RELEASING.md`).
- The job `publish` holds `id-token: write`. It does no checkout and no install. It starts only the pinned action.
- The job `tag` holds `contents: write`, from its caller job. It starts no code of the repository.
- Renovate does not change `release.yml`. The release session moves its pins (`RELEASING.md`).

## Pages

`reusable-pages.yml` has two jobs. The job `build` installs, builds the site, adds the pages of `site-pages` and uploads the Pages artifact. It gets only read permissions. The job `deploy` deploys the artifact. It starts no code of the repository.

```yaml
on:
  push:
    branches: [main]
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
      actions: read
      issues: read
      pull-requests: read
      checks: read
      statuses: read
      pages: write
      id-token: write
    with:
      build: pnpm --filter @crawler/site run build
      out: packages/site/dist
      env: '{"SITE_BASE": "/${{ github.event.repository.name }}", "ASTRO_TELEMETRY_DISABLED": "1"}'
      roadmap: docs/ROADMAP.md
      packages: polite-crawler,polite-crawler-mcp
```

- A caller on `workflow_run` after CI is also correct. A failed CI run or a CI run of a pull request builds nothing.
- A scheduled build uses the commit of `green-main`. The input `pending` goes to that action.
- The inputs of `site-pages` go to the action: `site-pages-version`, `roadmap`, `base`, `packages`, `changesets`, `group`, `css`, `site-name` and `data-only`.
- `site-pages: false` builds the site without the Releases page and the Status page.
- `deploy: false` builds and uploads the artifact, with no deploy.
- `github-token: true` gives the build `GITHUB_TOKEN`, with the read permissions of the build job.
- The workflow gets the actions of the same template commit as the workflow file. A second checkout gets them.

## Pins and Renovate

A repository pins each shared workflow and action to a commit of `main`:

```yaml
uses: mark1russell7/template/.github/workflows/reusable-ci.yml@<full commit SHA> # main
```

- Renovate reads the comment `# main` and moves the pin to the newest commit of `main` (the preset of `renovate/`).
- These updates come in one group, "template workflows and actions", with no wait. Renovate merges them when CI passes.
- Renovate does not change `release.yml`. The release session moves the pins of `release.yml`.

## The template and new repositories

The workflows of the template call the shared workflows and actions by a local path, for example `./.github/workflows/reusable-ci.yml`. Thus each pull request of the template tests them:

- `ci.yml` tests `reusable-ci.yml`.
- `actions-test.yml` tests the actions, `reusable-pages.yml` and the release workflows, with `dry-run`. It publishes nothing. On a pull request, it sets the input `require-main` of the release build to `false`.

The job `publish` of `release.yml` uses the pinned form of `npm-publish`, also in the template. A local action needs a checkout, and that job does no checkout.

`new-repo.ps1` does not copy the shared workflows, the actions or `actions-test.yml`. It changes each local path and each pin of the template to the pinned form, with the commit of the template that it copies.
