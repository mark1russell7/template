# Shared CI workflows

The template holds the CI, the release and the Pages workflows of the repositories of mark1russell7. Each repository keeps short caller workflows. The callers use the shared workflows from GitHub, so a change in the template gets to each repository.

| File | Type | What it does |
|---|---|---|
| `.github/workflows/reusable-ci.yml` | Workflow | Installs with pnpm and starts the standard scripts of `package.json`. |
| `.github/workflows/reusable-release-build.yml` | Workflow | Builds and packs the published packages, and writes the plan of the tags. |
| `.github/actions/npm-publish` | Action | Publishes the tarballs to npm with trusted publishing (OIDC) and provenance. |
| `.github/workflows/reusable-release-tag.yml` | Workflow | Makes a git tag and a GitHub release for each published version. |
| `.github/workflows/reusable-mutation.yml` | Workflow | Starts the mutation tests of each package with Stryker, with a gate for each package. |
| `.github/workflows/reusable-pages.yml` | Workflow | Builds a site, adds the Releases page and the Status page, and deploys it to GitHub Pages. |
| `.github/workflows/reusable-pages-check.yml` | Workflow | Builds and checks the site of a pull request in the job `site` of CI, with no deploy. |
| `.github/actions/site-config` | Action | Reads `.github/site.json`, the one home of the values of the site, and gives them as JSON. |
| `.github/actions/pages-build` | Action | Builds the site from the site config, adds the pages of `site-pages`, checks it and uploads the artifacts. |
| `.github/actions/security-scan` | Action | Scans the dependencies and the code with the dependency review, osv-scanner and CodeQL, in one job. |
| `.github/workflows/reusable-security.yml` | Workflow | Deprecated. The same scans in three jobs ("Security", "The old workflow"). |
| `.github/workflows/reusable-queue.yml` | Workflow | Merges `main` into each pull request with auto-merge that is behind, and starts the held runs of its new head ("The queue"). |
| `.github/workflows/reusable-ai-review.yml` | Workflow | Gives a pull request a review by Claude on request (the `ai-review` label), comment only (`AI-REVIEW.md`). |
| `.github/workflows/reusable-codex-review.yml` | Workflow | Gives a pull request a second review by an OpenAI model, comment only (`CODEX-REVIEW.md`). |
| `.github/workflows/reusable-lockfile.yml` | Workflow | Makes the `pnpm-lock.yaml` of a branch again on a runner, with no local install ("The lockfile of a branch"). |

## CI

The job of `reusable-ci.yml` installs the dependencies with pnpm. The version of pnpm comes from `packageManager` in `package.json`. Then the job starts each script of the list that `package.json` has. It skips the other scripts. Thus most repositories need no inputs:

```yaml
jobs:
  ci:
    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@<commit> # main
```

The job starts all the scripts, also after a failure. Then it fails with the names of the failed scripts. The summary of the run shows a table of the scripts.

When `check:api` fails, the job writes the API reports again and uploads them as the artifact `api-reports-<os>-node-<version>`. A person with no build on their computer can then commit the reports. The log of `check:api` shows at most 400 lines of a diff, so a large change of an API needs the files.

- The job starts the script `update:api` when `package.json` has it. Else it starts `api-report update` with the arguments of `api-report check`.
- The job uses only plain arguments: no quote, no glob and no character of the shell. For a different `check:api`, add a script `update:api`.
- The summary of the run gives the command that downloads the reports: `gh run download <run> -R <owner>/<repo> -n <artifact>`. Start it in the folder of `package.json`, and examine the diff before the commit.
- GitHub keeps the artifact for 7 days.

| Input | Default | What it sets |
|---|---|---|
| `scripts` | `format:check typecheck lint check:conventions test build check:boundaries check:api lint:ste` | The scripts, in sequence. `check:conventions` is the conventions check of `@mark1russell7/conventions`. `check:boundaries` is the import check of `@mark1russell7/boundaries`. `check:api` is the check of the public API of `@mark1russell7/api-report`. |
| `recursive-scripts` | `build` | The scripts that run in each package when the root `package.json` does not have them. |
| `node-versions` | `["26"]` | The Node.js versions of the matrix, as JSON. |
| `os` | `["ubuntu-latest"]` | The runners of the matrix, as JSON. |
| `setup` | (empty) | A command after the install, before the scripts. |
| `cue-version` | (empty) | The version of the cue CLI, for example `0.15.1`. The action `setup-cue` installs it before the install, with retries and a sha256 check. Do not download the CLI in `setup` (the rule `setup-cue`). |
| `run` | (empty) | A command after the scripts. |
| `env` | `{}` | The environment variables of the job, as a JSON object. |
| `working-directory` | `.` | The folder of `package.json`. |
| `fetch-depth` | `2` | The commits of the checkout. `0` gets the whole history. With `2`, the checkout of a pull request has the parents of its merge commit. On a pull request, and on a dispatched run of a pull request, the job then deepens the checkout to the merge base, so `check:conventions` reads each commit of the change and the versions at the merge base. On a push to the default branch, the job fetches the commit before the push, for the rule `unreleased-change`. |
| `timeout-minutes` | `15` | The time limit of each job of the matrix. The job `coverage` has its own limit. |
| `changesets` | `true` | The changeset check on a pull request, and on a dispatched run of a pull request (refer to "The changeset check"). |
| `changeset-ignore` | (empty) | More globs of files that need no changeset. |
| `coverage` | `false` | The job `coverage` starts the tests of each package with Vitest again, with coverage. A failure fails the CI (refer to "Coverage"). |
| `coverage-floor` | `0` | The lowest percent of each measure of each package. `0` is no floor. |
| `coverage-on-main` | `true` | With `coverage: false`, a push to the default branch of a public repository still gives the coverage, not strict. It does not fail the CI (refer to "Coverage"). |
| `coverage-timeout-minutes` | `30` | The time limit of the job `coverage`. Each step of the job stops 2 minutes before it. |
| `coverage-scripts` | (empty) | The scripts before the tests in the job `coverage`. The default takes each `build` or `build:*` script before `test` in `scripts`. |
| `release-check` | `true` | The release check on a pull request, and on a dispatched run of a pull request (refer to "The release check of a pull request"). `false` turns it off. |
| `release-check-private` | `false` | The release check also starts in a private repository. A private repository pays for each job start, so the default skips the job there. |
| `release-build` | (empty) | The input `build` of the `release.yml` of the repository, for the release check. |
| `release-node-version` | `26` | The input `node-version` of the `release.yml` of the repository, for the release check. |
| `release-window` | `true` | A pull request that changes a workflow or `scripts/release/` fails while a release of its base branch is open (refer to "The release window"). |
| `pull-request-private` | `false` | In a private repository, the job `pull` finds the pull request of a dispatched run. The caller also gives `pull-requests: read` (refer to "A dispatched run of a pull request"). |

### Coverage

With `coverage: true`, the job `coverage` starts `vitest run` with coverage in each package whose `test` script starts Vitest. The job has the first runner and the first Node.js version of the matrix. It starts at the same time as the job `checks`, so the coverage does not make the checks slower.

- Before the tests, the job installs, starts the command `setup` and the build scripts. These are each `build` or `build:*` script before `test` in `scripts`, or the scripts of `coverage-scripts`.
- The job has its own time limit, `coverage-timeout-minutes` (30). The install, the command `setup`, the scripts and the tests stop at a deadline 2 minutes before that limit. Each package that the deadline stopped fails the step, and the message names it.
- A job that reaches its time limit gets the result `cancelled`, also with `continue-on-error`, and the CI fails. A step that stops at the deadline fails only the step. Thus the job ends with its summary and its artifact.
- The script `deadline.ts` of the action `coverage` holds the deadline. At the deadline, it sends `TERM` to the processes of the step, and `KILL` 10 seconds later. It works on Linux, macOS and Windows.
- Node.js starts `deadline.ts` and `coverage.ts` from 22.18. With an older first version in `node-versions`, the steps have no deadline and give a warning. The step `Coverage` measures nothing: strict, it fails, and not strict, it gives a warning.
- The summary gives the time of the job and its limit. A time above 80 % of the limit gives a warning.
- The workflow `limit-audit.yml` of the template finds each job of a default branch that stopped at its time limit. It examines the runs of the last 24 hours of each public repository, each day.
- The audit finds a job that reached its `timeout-minutes`, a step of the job `coverage` that stopped at the deadline, and the warning above 80 %.
- The scheduled run fails when the audit cannot read a repository. The summary has a table of the jobs, and the artifact `limit-audit` has `limit-audit.json`.
- Until the day `FAILS_FROM` of the workflow (2026-11-23), a job that stopped at a limit gives a warning. From that day, it fails the run.

- The summary of the job gets a table: the statements, branches, functions and lines of each package.
- The artifact `coverage` has `coverage-summary.json` and `coverage-final.json` of each package.
- A package with no summary fails the step. Its tests failed, or it does not have `@vitest/coverage-v8`.
- A package whose tests fail also fails the step, after the summary. The thresholds of its Vitest config can cause this. The message names the package and the exit code.
- With `coverage-floor`, a package with a measure under the floor fails the step. The message names the package and the measure.

With `coverage: false` and `coverage-on-main: true` (the default), a push to the default branch of a public repository also starts the job, not strict (a private repository pays for its minutes, so it uses `coverage: true`). It skips a package with no `@vitest/coverage-v8`, and it gives a warning for a failure. The job has `continue-on-error`, so a failure or a stop at the deadline does not fail the CI. The gate of `release.yml` does not start it, so a release does not wait for the coverage. So each repository has the artifact `coverage` on main, and a tool can read which exported functions no test starts.

Each package with Vitest needs `@vitest/coverage-v8` in its `devDependencies`, with the version of its Vitest. The configuration of the coverage in `vitest.config.ts` (for example `include` and `exclude`) stays. The action sets only the reporters and the folder `coverage`.

The secret `CONVENTIONS_PRIVATE_PATTERNS` is optional. It has private regular expressions, one on each line. The rule `no-local-paths` of `check:conventions` finds each of them in the files and in the commit messages of the change. It also finds them in the title and the body of the pull request. A break of a private pattern shows only the line of the pattern in the secret, not the text. The job also masks each line of the secret in the log. A caller gives the secret by name, or with `secrets: inherit`:

```yaml
jobs:
  ci:
    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@<commit> # main
    secrets:
      CONVENTIONS_PRIVATE_PATTERNS: ${{ secrets.CONVENTIONS_PRIVATE_PATTERNS }}
```

A pull request from a fork gets no secret, so the private patterns are not examined there.

### The release window

GitHub refuses the tag of a release (HTTP 403) when a workflow file changes between the version merge and the tag job (`RELEASING.md`, "A tag that GitHub refuses").

Thus the job `release-window` examines each pull request that changes a file in `.github/workflows/` or `scripts/release/`. While a `release.yml` run of the base branch is queued, waiting or in progress, the job fails at once. The message names the run.

- The job does not wait, so it holds no runner. Start the check again after the tag job of the release.
- The job reads the files of the change from the merge commit. A token with `contents: read` reads the runs of a public repository, so a caller gives no other permission.
- In a private repository, the token cannot read the runs with `contents: read`. Then the job gives a warning and passes.
- A repository with no `release.yml` passes.
- `release-window: false` turns the job off.

The job stops a merge only while its check is red. A check that passed before the release started stays green. Thus the release train merges the pins of the workflows, and it examines the open releases at the merge.

### The changeset check

On a pull request, the job `changesets` examines the changesets (`.github/actions/changeset-check`). On a dispatched run of a pull request, it examines the change of that pull request (refer to "A dispatched run of a pull request"). A repository with no `.changeset/config.json` passes. The job fails in these cases:

- A published package changes, and no changeset names it. Markdown, tests, fixtures and a change of only `devDependencies` or `scripts` in `package.json` need no changeset.
- A changeset names a package that the repository does not have, or it does not parse.
- A changeset gives `major` to a `0.x` package. changesets makes `1.0.0` from it. Before `1.0`, a breaking change is a `minor`. A decided `1.0` release adds the label `release-1.0`.

In a fixed group, a changeset of one member sets the version of all members. The other members that change get a note, not an error. The summary shows each package, its changeset and the release of each fixed group. Before `1.0`, a `minor` of a group is a breaking change, and the note asks for a migration note.

A change with no release has an empty changeset (`pnpm changeset --empty`) or the label `no-changeset`. The version pull request of changesets (`changeset-release/*`) is skipped. The check also knows a version pull request on each other branch, for example `release/<version>`: the pull request deletes changesets and adds none. In such a pull request, a `package.json` change of only the version and the ranges of the packages of the repository needs no changeset. Each other change of a package still needs a changeset.

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

### The release check of a pull request

On a pull request, the job `release-check` starts the release build on the commit (`.github/actions/release-check`). It does the same steps as the build job of `reusable-release-build.yml`: the install with the lockfile, the build, `scripts/release/pack.ts` and `scripts/release/tags.ts`. Thus a pull request fails when its merge makes the release on `main` fail. An example: a shipped file of a package changes, and the version of that package is already on npm. The error names the package, its version and each file that differs.

- The job uses the merge commit of the pull request, not its head. That commit is the `main` of the release after the merge.
- On a dispatched run of a pull request, the job uses the commit of the run, that is the head of the pull request.
- The job does not compare with the base branch. When `main` already has such a change, each pull request fails until a pull request raises the version.
- A repository with no published package passes at once, with a notice. The job does no install.
- In a private repository, the job starts only with `release-check-private: true`. A private repository pays for each job start, also for a job with no published package.
- In a repository with Changesets (`.changeset/config.json`), a pending changeset raises the version of a package later. Thus a change of that package passes, with a note. A changeset of one member of a `fixed` group raises each member. A shipped change of a different package at a version on npm fails. An empty changeset raises no version.
- The job uses the dependency cache of the job `checks`. The install still uses the lockfile only.
- A repository with its own `build` or `node-version` in its `release.yml` gives the same values in `release-build` and `release-node-version`.

The job is in `reusable-ci.yml`, so `CI OK` covers it. A repository needs no change other than the usual move of its pin.

### The check of the ruleset

Each workflow of the merge gate has one summary job, with the name `<Name> OK`. The template has two: `ci-ok` (name `CI OK`) of `ci.yml` and `security-ok` (name `Security OK`) of `security.yml`. A summary job needs each other job of its file (`Security OK` has no other job, and does the scans itself, as "Security" tells). It starts also after a failure (`if: ${{ !cancelled() }}`). After a cancel it does not ask for a runner. It concludes `cancelled`, which does not pass the ruleset, and the next run does not wait behind it.

A summary job passes only when each job passed. A job can be skipped only when the list `ALLOW_SKIP` of the summary job names it. For example, outside the template, the `if` of `presets` skips it. Each other skipped job fails the summary. An empty `needs` also fails it, because a job that did not start is not a pass.

The ruleset names only the summary checks. Thus it does not change when a job is added. `gh pr merge --auto` merges only after the whole gate. A ruleset that names only some jobs lets `--auto` merge before the other jobs end.

- Add each new job of the gate to `needs` of `ci-ok`.
- `release.yml` uses `ci.yml` with `contents: read` only. A called job cannot get more permissions than its caller. Thus a gate job that needs more (the scans need `security-events: write`, a download of an artifact of another run needs `actions: read`) stays in its own workflow, with its own summary job.
- A gate workflow must start on each pull request, with no `paths` filter. Otherwise its summary check does not start, and the ruleset blocks the pull request. To skip the work, use the action `changes` and an `if` on the other jobs ("A gate with paths").
- Set the ruleset once with `node scripts/workflows/ruleset-ci-ok.ts <owner/repo> --apply`. Without `--apply`, it only prints the changes. It reads the checks of the newest of the last 5 pull requests into the default branch where "CI OK" passed. It adds each check with a name `<Name> OK` that passed there and that no ruleset names. It skips a repository where "CI OK" did not pass on any of the 5. A check that starts only on a push to `main` is not added, because it does not start on a pull request.
- To make the summary checks the only checks of the ruleset, add `--only-summary`. Then the script also removes each check that started in the same workflow run as that "CI OK", because "CI OK" covers it. It deletes a ruleset with no rule left. Then a repository can join or split the jobs of its CI, and its ruleset stays correct.
- The workflow `rulesets.yml` runs the script with `--check` each day. The check changes nothing. It fails when a public repository has a summary check that passed and that no ruleset names. Thus a new repository gets its ruleset after its first merged pull request: the summary of the red run gives the command that adds it. A repository with no "CI OK" that passed is a no read, not a pass.

### One run for each commit

A commit on a branch with an open pull request starts `push` and `pull_request`. Thus a workflow with no limit on `push` starts two times for each commit. The rule `push-main-only` of `@mark1russell7/conventions` stops this, and `pnpm exec conventions fix` writes the change. A workflow that starts on the two events has this form:

```yaml
on:
  push:
    branches: [main]
  pull_request:
  # A person starts a run on a branch with no pull request: gh workflow run ci.yml --ref <branch>
  workflow_dispatch:
```

`branches` names the default branch. The rule reads it from the event file of the run, and then from `origin/HEAD`. If it finds neither, it uses `main`.

| Trigger | What the rule does |
|---|---|
| `push` with no filter, or with only `paths` or `paths-ignore` | The fix adds `branches`. The path filter stays. |
| `push` with `branches: ["**"]` or `branches: ["*"]` | The fix writes the default branch. |
| `push` with `branches` and `tags` | The fix keeps `tags`, so a tag push stays. |
| `push` with only `tags` or `tags-ignore` | No break, because GitHub starts this trigger on no branch. |
| `push` with no filter in a workflow that reads `refs/tags` or `github.ref_type` | The fix adds `branches` and `tags: ["**"]`, so the tag run stays. The rule also reads the local workflows that the file calls. |
| `push` and `release` with no `pull_request` | No break. Only the two events together start a commit two times. |
| `pull_request.types` with no `synchronize` | No break. Such a trigger does not start on a new commit, so `push` gives the only run. |
| `pull_request_target` | No break. It uses the code of the base, so only `push` tests the branch. |
| `workflow_call` or `schedule` next to the triggers | They stay as they are. |
| `on: [push, pull_request]` | The fix writes the block form. A comment stays on its line. |
| A caller of a shared workflow | The same as each other workflow. The fix does not change the jobs. |

The fix gives a break with no edit, and a person chooses the change, in these cases:

- `push` has `branches-ignore`.
- `branches` names another branch, for example `[main, develop]`.
- The workflow reads another branch, for example `github.ref == 'refs/heads/develop'`.
- `on` or `push` has the flow form of a map, for example `on: { push: {}, pull_request: {} }`.
- The file is `release.yml`. The fix does not change this file.

For a long-lived branch, add its name to the option `branches` of the rule, with a reason. To keep a workflow out of the rule, use `ignore`, with a reason.

The limit has these results:

- A branch with no pull request gets no automatic run. Start a run with `gh workflow run`.
- GitHub does not start `pull_request` on a pull request with a merge conflict. Correct the conflict to get a run.
- A pull request into a branch that `on.pull_request.branches` does not name gets no run. Start a run with `gh workflow run`.
- A tag push no longer starts a CI that does not read the tag.
- The checks of a pull request do not change. `CI OK` and `Security OK` come from the run for `pull_request`, and the ruleset stays as it is.

A run from `workflow_dispatch` on the default branch is the same as a run from a push to `main`, with these points:

- The concurrency group of `ci.yml` is the group of the commit, and `cancel-in-progress` is `false`. A newer push does not cancel the run. A run of the same commit waits for the first run.
- The jobs `pull`, `changesets` and `release-check` skip, because the run has no pull request. The job `ci` stays green, as on a push to `main`.
- The steps "Deepen to the merge base" and "Fetch the commit before the push" skip.
- The action `changes` gives a match, because the run has no pull request.
- The rules of `conventions` that read a range of commits skip, because the run has no base.
- After a CI run of `workflow_dispatch` on `main`, a caller of `reusable-pages.yml` on `workflow_run` of CI deploys only the head of `main`.

A run from `workflow_dispatch` on another branch examines the open pull request of that branch (refer to the next section). A branch with no open pull request gives a notice. Then the run examines no change, as a run on the default branch.

### A dispatched run of a pull request

A run from `workflow_dispatch` on a branch has no pull request in its event. The owner can start `ci.yml` on the branch of the pull request (`workflow_dispatch`, from the Actions tab of the repository). The job `pull` of `reusable-ci.yml` finds the pull request of the run (`.github/actions/pull-of-run`):

1. It lists the open pull requests whose head is the branch of the run. It keeps only those of the same repository.
2. It reads the pull request again until its head is the commit of the run, at most 3 more times, 10 s apart. GitHub can update the head some seconds after a push.
3. It reads the tip of the base branch. The change is from the merge base of that tip to the commit of the run.

Then the run examines that change, as a `pull_request` run does:

- The job `changesets` examines the changesets of the change, with the labels of the pull request.
- The job `release-check` starts the release build on the commit of the run.
- The job `checks` deepens the checkout to the merge base. It gives the tip of the base branch to `check:conventions` in the variable `CONVENTIONS_BASE`.
- The job `pull` saves the pull request as the artifact `pull-request-of-run`: its title, its body and its number of commits, in a JSON file. The job `checks` downloads it, and the variable `CONVENTIONS_PULL_REQUEST` gives its path. The job uses a file, not an output: a step gets an output of a job through an environment variable. On Windows, an environment variable takes at most 32,767 characters, and a body can be longer.
- Thus the rules `release-files`, `unreleased-change`, `home-package`, `home-module`, `version-title` and `no-local-paths` examine the change. The README of `@mark1russell7/conventions` tells how.
- A gate with paths finds the pull request with the same action. It skips its jobs when no file of the gate changes (refer to "A dispatched run of a gate").

The job `pull` fails when it cannot tell the change, and a failure of the job `pull` fails `CI OK`:

- Two open pull requests have the branch as their head. The job cannot tell the base.
- The head stays different from the commit of the run. If the branch has a newer commit, the `pull_request` run of that commit examines it. Else start the run again.
- A read of the API is refused (HTTP 403 or 404), or the rate limit of the API stops it. The error tells which, and what to do.
- A read of the API fails for a time (HTTP 429 or 5xx, or no answer) after 3 more reads, 10 s apart. This limit is for all reads of the run together.
- The base branch of the pull request is not in the repository: it was deleted or renamed.

The job `checks` starts also after a failure of the job `pull`, so the run still shows its results. A run on the default branch does not start the job `pull`, for example the gate of `release.yml`.

The job `pull` has no `permissions` key, so it gets the permissions of the caller. A job of a called workflow cannot ask for more than its caller gives. A `permissions` key on the job stops each caller that gives only `contents: read`. In a public repository, each token can read the pull requests.

In a private repository, the job `pull` starts only with the input `pull-request-private: true`. A private repository pays for each job start. The job that calls `reusable-ci.yml` gives the input and `pull-requests: read`:

```yaml
jobs:
  ci:
    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@<commit> # main
    permissions:
      contents: read
      pull-requests: read
    with:
      pull-request-private: true
```

Without the input, a dispatched run in a private repository examines no change, as a run on the default branch. The changeset check and the release check do not start. With the input and without the permission, the job `pull` fails, and its error names the permission.

### A gate with paths

A gate that is only about some files (a bench of the core, a corpus) starts on each pull request too. Two shared actions do the rest:

- `changes` reads the files of the pull request and gives `match`. It has the patterns of `on.pull_request.paths`: `*` does not match `/`, `**` matches each part of a path, and `!` takes files out. A different event is a match, but a run of `workflow_dispatch` can give its pull request (refer to "A dispatched run of a gate").
- `gate-summary` is the step of the summary job. It passes when each job passed. When `changes` gives `match: false`, a skipped gate job passes too. A failure, a cancel or another skip fails it.
- A skip is green only after a pass. Give each job that `allow-skip` names a line `<job id>=<check name>` in `last-result`, and give the summary job `checks: read`. A skip of that job then reads the last result of its check on the commit:
  - A pass passes, and a failure fails the summary.
  - With no result on the commit, the line says `no read` and the step writes a warning. A no read is not a pass.
  - The check of a matrix job is each entry, `<check name> <entry>`. A skip, a cancel or a run in progress decides nothing, so the read goes back to the last run that decided.

```yaml
on:
  pull_request:
  push:
    branches: [main]
    paths: ["packages/core/src/**"]
  workflow_dispatch:

jobs:
  changes:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    outputs:
      match: ${{ steps.changes.outputs.match }}
    steps:
      # A dispatched run on the branch of a pull request gives that pull request to changes
      - if: github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/') && github.ref != format('refs/heads/{0}', github.event.repository.default_branch)
        uses: actions/setup-node@<commit> # v7.1.0
        with:
          node-version: "26"
      - id: pull
        if: github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/') && github.ref != format('refs/heads/{0}', github.event.repository.default_branch)
        continue-on-error: true
        uses: mark1russell7/template/.github/actions/pull-of-run@<commit> # main
      - id: changes
        uses: mark1russell7/template/.github/actions/changes@<commit> # main
        with:
          pull-request: ${{ steps.pull.outputs.found == 'true' && steps.pull.outputs.number || '' }}
          paths: |
            packages/core/src/**
            .github/workflows/bench.yml

  bench:
    needs: changes
    if: needs.changes.outputs.match == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: pnpm bench

  bench-ok:
    name: Bench OK
    if: ${{ !cancelled() }}
    needs: [changes, bench]
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - uses: mark1russell7/template/.github/actions/gate-summary@<commit> # main
        with:
          needs: ${{ toJSON(needs) }}
```

A `push` filter can stay, because the ruleset reads only pull requests. With the patterns of the old filter, the gate runs on the same pull requests as before. `changes` also reads the old name of a moved file, so a move out of the gate paths starts the gate too. A pull request with 3000 files or more always starts the gate, because the API gives no more files. The conventions rule `gate-trigger` finds a pull request trigger with `paths` or `paths-ignore`. `actions-test.yml` of the template is an example.

### A dispatched run of a gate

A person can start the gates of a pull request with `workflow_dispatch`. Such a run has no pull request in its event. Without the input `pull-request`, `changes` gives a match, and each gate job runs. The steps `pull` and `changes` of the example give the pull request of the run to `changes`:

1. The action `pull-of-run` finds the open pull request of the branch of the run (refer to "A dispatched run of a pull request").
2. Its output `number` goes to the input `pull-request` of `changes`, when its output `found` is `true`.
3. `changes` reads the head of that pull request. When the head is the commit of the run, it reads the files, as on a `pull_request` run.
4. After the files, `changes` reads the head again. A push during the read can change the files.

The lookup fails open. Thus a gate skips only after a read of its files:

- A schedule, a run on `main` and a run on a branch with no open pull request give no number. Then the gate runs.
- A head that is not the commit of the run gives a match. A failed read gives a match too. The log gives the reason.
- `pull-of-run` fails when it cannot tell the pull request, for example with two open pull requests of one branch. The key `continue-on-error` keeps the job. With no number, the gate runs.
- A run by hand on the branch of an open pull request also reads the files of that pull request. When no file of the gate changes, the gate jobs skip. A run on `main` starts each gate job.

`pull-of-run` is TypeScript, so it needs Node.js 22.18 or later. Thus the job sets up Node.js before it. A composite action cannot start a different action of its repository with a path that works for a caller outside the repository. Thus the job of the caller has the two steps, and the template has one lookup of the pull request.

### The read of the CI minutes

The action `changes` skips a whole gate job when no file of the gate changes. A finer selector starts only the tests that a change can affect. The workflow `ci-minutes.yml` of the template measures what each part of a selector can save, before the selector exists. Each Monday it reads the pull-request runs of the last 7 days of each public repository.

- The read takes 10 completed runs of each repository, spread over the week. For each run, it reads the jobs with the time of each step, and the changed files of the pull request.
- Each step gets a class from its name: setup, install, build, test, check or other. The first rule that matches decides. Thus "Build and test" counts as test time, and the test time is an upper bound.
- Each pull request gets a kind from its files. The kinds are large (a full page of 100 files), docs only, lockfile, workflow, root file, packages and other. The first kind that applies decides.
- The summary gives the minutes of each class, each kind and each job by name. It also gives the minutes that each part of a selector can save. The part "packages" is an upper bound: the test time times the share of the packages that the change does not touch.
- The artifact `ci-minutes` has `ci-minutes.json` with each record of a job and of a pull request. A later study takes its quantiles from these records with no new read.
- The token of GitHub Actions has 1000 reads each hour. Before each repository, the read examines the limit. When too few reads are left, it waits for the next hour of the token, up to 65 minutes. Else it stops and names each repository that it did not read. The scheduled run fails when the read cannot read a repository.

## The queue

Several writers merge into one `main` with `gh pr merge --auto`. Two pull requests can each pass their gate alone and break `main` together. For example, two pull requests set the same version, or one pull request removes an export that the other starts to use.

Strict status checks in the ruleset stop this. With strict on, GitHub merges a pull request only when its branch has the newest `main`. The checks of the ruleset must also pass on that head. But then a pull request with auto-merge stops each time that a different merge makes it behind. The merge queue of GitHub is not available to a personal account, so the queue does not use `merge_group`.

`reusable-queue.yml` keeps these pull requests up to date. A repository uses it in its `queue.yml`:

```yaml
on:
  push:
    branches: [main]
  pull_request:
    types: [auto_merge_enabled]
  workflow_dispatch:

permissions: {}

concurrency:
  group: queue
  cancel-in-progress: false

jobs:
  queue:
    uses: mark1russell7/template/.github/workflows/reusable-queue.yml@<commit> # main
    permissions:
      contents: write
      pull-requests: write
      actions: write
```

A run of the queue does these steps (`scripts/workflows/queue.ts`):

1. It reads the checks that the rules of the default branch need (`GET /repos/{owner}/{repo}/rules/branches/{branch}`).
2. It reads the open pull requests into the default branch. It takes only a pull request with auto-merge on, not a draft, and not from a fork. When GitHub did not compute a merge state (`UNKNOWN`), it reads them again, at most 6 times, 5 s apart.
3. It merges `main` into each pull request with the merge state `BEHIND`. It uses `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch` with `expected_head_sha`.
4. It waits for the new heads, at most `wait-seconds` (90 s). A push with `GITHUB_TOKEN` makes the `pull_request` runs of the new head, but GitHub holds each one. A held run has the conclusion `action_required`, and it starts no job.
5. It reads the `pull_request` runs of each new head until the set is stable (`GET /repos/{owner}/{repo}/actions/runs?head_sha=`). It starts each held run with `POST /repos/{owner}/{repo}/actions/runs/{id}/approve`. When approve refuses, it uses `POST /repos/{owner}/{repo}/actions/runs/{id}/rerun`. These runs give the checks on the new head, as a push of a person does.
6. It reads the runs of the head of each other queued pull request one time. It starts each held run of that head in the same way.

- The queue starts only a held run of the repository itself, on the head that it read, whose actor is `github-actions[bot]`. Each other held run is a no read in the summary. A held run of a fork waits for a person.
- The documents of GitHub name approve only for a run of a fork. The queue uses it for a run of its own token. A measurement found that approve gave HTTP 201 and started such a run at once. Rerun also started such a run.
- When GitHub changes this behavior, approve and rerun refuse, and the job fails with the id of each held run. Thus the change shows as a failed run, not as a pull request that waits with no sign.
- A push to `main` makes the other pull requests behind. A pull request can be behind when it gets auto-merge (`auto_merge_enabled`). A person can start a run from the Actions tab. The queue does not use `pull_request_target`.
- One run at a time operates in a repository (`cancel-in-progress: false`). GitHub keeps only the newest run that waits. Each run reads all the pull requests, so the newest run does the work of a cancelled run.
- A refused update (HTTP 422, for example a merge conflict) skips only that pull request, with a warning. Each other pull request gets its turn. A pull request with a merge conflict (`DIRTY`) waits for a person.
- The job fails for a different failure of an update, for a failed read and for a held run that approve and rerun both refuse. It also fails when a head does not change in the wait time. It also fails when GitHub makes no `pull_request` run on a new head in the wait time.
- A failed read of the rules or of the pull requests changes nothing and fails the job.
- GitHub can make a run after the end of the wait. That run stays held until the next run of the queue starts it (step 6).
- With strict off, GitHub merges a pull request that is behind. Then no pull request is `BEHIND`, and the queue updates no branch. Set strict in the ruleset to use the queue.
- In a private repository, the job starts only when the caller gives the input `private: true`. A private repository pays for each job start, and the queue starts on each push to `main`, also when no pull request is behind. When the input is false, the job skips, and a skipped job costs nothing.
- An example: two pull requests set the same version, and the first one merges. The queue merges `main` into the second one. Then its change sets no version that `main` does not have. Its gate fails when its title names the version (`version-title`). It also fails when npm has the version and the repository sets `versionEachChange` (`unreleased-change`).

The queue does not do these things:

- `GITHUB_TOKEN` cannot write a workflow file. When the new commits of `main` change a file of `.github/workflows`, GitHub can refuse the update. Then a person updates the branch.
- When the head does not change in the wait time, the queue starts no run. The next run of the queue does not see that pull request as `BEHIND`, but it starts the held runs of its head (step 6).
- Each merge updates each other pull request that is behind, and starts its gates again. With N pull requests in the queue, the merge of all of them starts about N × N / 2 runs of each gate.

## A tree that passed CI

`release.yml` starts `verify`, the gates of `ci.yml`, on the commit on `main`. When the pull request passed CI on the same tree, `verify` does the same work again. `scripts/workflows/verified-tree.ts` tells if the tree of a commit already passed CI in its pull request. The job `tree` of `release.yml` starts it through `reusable-release-tree.yml`, and `verify` starts only when the answer is not yes.

```sh
node scripts/workflows/verified-tree.ts [--sha <commit>] [--workflow <file>] [--job <name>]...
```

| Input | Default |
|---|---|
| The repository | `GITHUB_REPOSITORY` |
| `--sha` | `GITHUB_SHA` |
| `--workflow` | `WORKFLOW_FILE`, else `ci.yml` |
| `--job`, one time for each job that must pass | The lines of `REQUIRED_JOBS`, else `CI OK` |
| The token | `GH_TOKEN`, else `GITHUB_TOKEN` |

`reusable-release-tree.yml` gets the script from the template commit of the workflow, so a repository needs no copy. Its inputs are `workflow` (default `ci.yml`) and `jobs` (default `CI OK`, one name on each line). Its outputs are `verified` and `reason`. The caller job gives it `actions: read`, `contents: read`, `issues: read` and `pull-requests: read`. The timeline of a pull request is an issue endpoint.

The script writes `verified=true` or `verified=false`, and `reason=<code>`, to `GITHUB_OUTPUT`. It writes one line to the step summary and the same line to stdout. The exit code is 0 for a yes and for a no. A no is not an error. Then the caller starts the full checks.

The answer is yes only when each rule holds. Each rule that fails has its own reason code. The cheap rules come first:

1. The commit has exactly one parent (`not-one-parent`).
2. Exactly one merged pull request has this commit as its merge commit (`no-pull`, `many-pulls`). Its base is the default branch (`pull-base-not-default`). Its head is a branch of the same repository (`pull-head-fork`).
3. The tree of the commit is the tree of the head of the pull request (`tree-differs`).
4. The parent of the commit is the head, or an ancestor of the head (`head-behind-parent`). The compare of the parent and the head gives `behind_by` 0.
5. Of the runs of the workflow with the event `pull_request` on the head commit, the newest run passed. Each run must be from the head branch of the same repository. Its status is `completed` (`run-not-completed`), and its conclusion is `success` (`run-not-success`). The newest run has the highest `run_number`, then the highest `run_attempt`. With no such run, the answer is no (`no-run`).
6. GitHub made the newest run before the merge (`run-after-merge`). Its `created_at` is at least one second before `merged_at`.
7. At the second of the newest run, no other pull request of the head branch was open (`other-pull-at-run`). Also, no other pull request of the head branch has the head commit (`many-pulls-of-head`).
8. No base change of the pull request came in the second of the newest run or after it (`base-changed-after-run`). The timeline events are `base_ref_changed`, `automatic_base_change_succeeded` and `base_ref_force_pushed`.
9. Each job that must pass is in that run (`job-missing`) with the conclusion `success` (`job-not-success`). A skipped job is not a pass.

The `created_at` of a run is the time of its event. A rerun keeps that time. Thus rules 6, 7 and 8 also apply to a rerun.

For rule 7, the script reads the pull requests of the head branch in each state:

- Another pull request was open at the second of the run when two conditions are true. Its `created_at` is at that second or earlier. Its `closed_at` is empty, or at that second or later.
- An older pull request of the same branch, closed before the run, is a yes. A release tool that uses its branch again gives this case.
- The pull request of rule 2 must be in the list, with the head commit. Its `created_at` must be at the second of the run or earlier. Else the facts do not agree (`no-read-head-pulls`).

The rules prove that CI tested the tree of the release:

- A `pull_request` run tests the merge of its base branch into the head. The base commit is the newest commit of the base branch at the time of the event.
- Rule 5: the run is a run of the head branch of this pull request.
- Rule 7: at the second of the newest run, no other pull request of the head branch was open. Thus the run is a run of this pull request.
- A workflow with the type `closed` can make a run after the close of a pull request. That pull request keeps the head of its close. Thus the check of the head commit in rule 7 stops that run.
- Rule 8: no base change came after the run. Thus the base of the run is the base of the merge, the default branch. A stacked pull request that GitHub retargeted before its newest run is a yes.
- Rule 6: the run is older than the merge. Thus the base commit is a commit of `main` before the merge.
- `main` only moves forward. Thus that base commit is the parent of the release commit, or an ancestor of the parent.
- Rule 4 makes the parent an ancestor of the head. Thus the base commit is also an ancestor of the head.
- The merge of an ancestor into the head gives the tree of the head. Rule 3 makes that tree the tree of the release commit.

Each HTTP error, each missing or malformed field and each fact that the script cannot read gives `verified=false`. Its reason starts with `no-read-`. A no read is not a pass at any time.

- Each sha must match `^[0-9a-f]{40}$` before the script puts it in a URL or an output.
- Each time must be an ISO time in UTC, for example `2026-11-16T12:02:47Z`. The script compares times to the second.
- Each value in the outputs is a fixed text of the script, a checked sha or a number. A text of the API, for example a branch name, does not go to an output.
- The head branch goes only into a URL, through `encodeURIComponent`.
- The script imports only the built-in modules of Node.js, so it needs no install.

The script has these limits:

- The run of the pull request has the event `pull_request`. `verify` of a release has the event `push` or `workflow_dispatch`. A job of `ci.yml` with a condition on the event is not the same in the two runs. For example, `ci / changesets` starts only for a pull request. The list of jobs is the tool for this: the owner of the release names each job that must pass.
- The proof needs a `main` that only moves forward. A ruleset that blocks a force push gives this.
- Rules 6, 7 and 8 compare the times of GitHub to the second. A change in the time between an event and its run is not seen.

## The lockfile of a branch

A dependency update needs a new `pnpm-lock.yaml`. On a computer with low memory, a local install can fail. `reusable-lockfile.yml` makes the file on a runner. A repository uses it in its `lockfile.yml`:

```yaml
on:
  workflow_dispatch:

permissions: {}

concurrency:
  group: lockfile-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lockfile:
    uses: mark1russell7/template/.github/workflows/reusable-lockfile.yml@<commit> # main
    permissions:
      contents: read
```

To make the lockfile of a branch:

```sh
gh workflow run lockfile.yml -R <owner/repo> --ref <branch>
gh run download <run id> -R <owner/repo> -n lockfile -D <folder>
git merge <commit of merge.txt>
cp <folder>/pnpm-lock.yaml pnpm-lock.yaml && git add pnpm-lock.yaml && git commit --no-edit
```

A run does these steps:

1. A dispatch on the default branch fails. The file is for a branch, and a person merges that branch.
2. It merges the default branch into the branch, with no commit. It stops when a file other than `pnpm-lock.yaml` conflicts.
3. It takes the lockfile of the default branch, then starts `pnpm install --lockfile-only --no-frozen-lockfile --ignore-scripts`. No script of a package starts, and nothing is built.
4. It fails when the install changes a file other than `pnpm-lock.yaml`.
5. It uploads the artifact `lockfile`: `pnpm-lock.yaml` and `merge.txt`, with the commit of the default branch.

- In CI, pnpm makes a frozen install by default. A frozen install does not write the file, so the job gives `--no-frozen-lockfile`.
- The job has only `contents: read`, and it pushes nothing. A push with the token of a run starts no checks.
- After the commit of the new file, the CI of the branch does a frozen install. That install fails when the file does not agree with the `package.json` files.
- No input names a branch. The run uses the code of its own branch, so the cache of the default branch stays out of reach.
- GitHub starts a `workflow_dispatch` workflow only when its file is on the default branch. Add `lockfile.yml` to the default branch first, in its own pull request.
- The branch also needs the file. Merge the default branch into it first.
- The caller has no `pull_request` trigger. A trigger with `paths` fails the rule `gate-trigger` of `@mark1russell7/conventions`.
- The stamp gives each new repository this `lockfile.yml`.

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

### Inputs of the release

Most repositories need no inputs. A repository with more release steps uses these inputs. Each default keeps the standard release.

| Workflow or action | Input | Default | What it sets |
|---|---|---|---|
| `reusable-release-build.yml` | `require-main` | `true` | The check that the commit is on `main`. Only `actions-test.yml` sets `false`. |
| `reusable-release-build.yml` | `node-version` | `26` | The Node.js version of the build. |
| `reusable-release-build.yml` | `node-version-file` | (empty) | A file with the Node.js version, for example `.nvmrc`. It replaces `node-version`. |
| `reusable-release-build.yml` | `build` | (empty) | The build command. Empty starts the root `build` script, or else the `build` script of each published package and its dependencies. |
| `reusable-release-build.yml` | `after-pack` | (empty) | A command after `pack.ts` and `tags.ts`, before the upload of the artifacts. |
| `npm-publish` | `new-packages` | `error` | `warning`: a package that is not on npm gives a warning, and the step does not fail. |
| `npm-publish` | `node-version` | `26` | The Node.js version of npm. |
| `reusable-release-tag.yml` | `published` | (empty) | The versions that the job `publish` published. |

The command `after-pack` operates in the build job, with `contents: read` only:

- `RELEASE_DIR` is the folder of `packages.txt` and the tarballs. `TAGS_FILE` is the plan of the tags.
- The command can test the tarballs, add files to the artifact `release`, and change the plan.
- Each line `name=value` that it writes to `GITHUB_OUTPUT` goes into the output `after-pack` of the workflow. This output is a JSON object.
- A later job reads a value with `fromJSON(needs.build.outputs.after-pack).<name>`.

Each entry of the plan of the tags has `name`, `version`, `tag`, `prerelease` and `notes`. The job `tag` also reads three optional fields:

- `title`: the title of the GitHub release. The default is the tag.
- `tarballs`: an array of package names. The release gets the tarball of each package as a file.
- `latest`: `true` makes the release of this entry the latest release of the repository (`--latest`). The other releases of the run get `--latest=false`.

At most one entry sets `latest`. A prerelease does not become the latest release. When no entry sets `latest`, the job gives no `--latest` flag, the same as before.

The `tags.ts` of the template does not write these fields. The `tags.ts` of a repository can write them. The command `after-pack` can also add them.

### More jobs in `release.yml`

A step that needs `id-token: write` stays in `release.yml`, for example a publish to the MCP registry. It does not go into a shared workflow:

- Put it in a job after the job `publish`, with only the permissions that it needs.
- The job does no checkout and no install. It reads its files from the artifact `release`.
- The output `published` of the job `publish` and the output `after-pack` of the job `build` tell the job when to operate.

## Mutation

The workflow `reusable-mutation.yml` starts the mutation tests of a repository with [Stryker](https://stryker-mutator.io) and `@mark1russell7/rigor-mutation`. A mutation test changes the source a little (a mutant) and starts the tests. The score is the percent of the mutants that the tests detect.

The lane file `mutation.json` of the repository names the packages, their globs, their parts and their gates. The README of `@mark1russell7/rigor-mutation` tells its format. The repository has these `devDependencies`: `@mark1russell7/rigor-mutation`, `@stryker-mutator/core` and `@stryker-mutator/vitest-runner`, 10.1.0 or later. Stryker 10.0 started no test on each mutant with Vitest 5. The workflow needs `@mark1russell7/rigor-mutation` 0.1.8 or later. The job `plan` fails with an older version.

The job `plan` checks the disabled mutants (`rigor-mutation disables`) and the relative paths of each package (`rigor-mutation load-check`). Then it gives the selections. Stryker copies the folder of each package, so a relative path that leaves the folder finds no file in the copy. A test file that does not load fails no test, so the plan fails before any runner starts. The job `mutate` starts Stryker for each selection on its own runner. Then it applies the gate of the package. A selection under its gate fails, and the message names it. The artifact `mutation-<selection>` has the HTML and JSON reports.

Stryker stops after `stop-minutes`, before the time limit of the job. Then the job writes "no score" to the summary, uploads the report and fails. The job `gate` starts after each `mutate` job, also after a failure. It reads the reports of all the selections in one `scores` command (`--reports`) and applies the gate again. A selection with no report fails, and the gate names it.

The gate of a package with parts applies to each part. With `"gateOver": "package"` in the lane, the job `gate` applies it to the sum of the mutants of all the parts. A part that has no report makes the package a no read. The job `mutate` of a part then applies no gate (`--alone`).

A score is a read of the tests only when the run read all of them. Thus `Score` and the job `gate` also fail a selection when its report does not read a test file on the disk (`--test-files`). The field `notRead` of the package in the lane names each exception, with its reason.

Four inputs change a run.

- `test-counts` names a file with the last good count of the tests of each selection. A count that fell by more than `maxTestFall` percent of the lane fails the selection. The default is 20. The job `gate` uploads the new counts as the artifact `mutation-test-counts`. Commit the file after a good run.

- `dry-run` starts only the tests of each selection under Stryker, with no mutant. Start it on a pull request that changes the lane files or the test config. A selection whose tests fail under Stryker then fails before the long run. A dry run has no score, so `Score` and the job `gate` do not run.
- `changed` names the changed files, from the folder of the lane file. Only the runs with a changed file start, and each run mutates only its changed files. A plan with no run starts no job `mutate`.
- `report-only` writes the scores, but a score under the gate fails nothing. A run of the changed files of a night is a sample of the package, so it is report only. The weekly run of all files keeps the gate.

A mutation run is long. Thus a repository starts it from a scheduled workflow, not from each pull request. The workflow states its size in its `env`. A check compares the real run with these values:

```yaml
on:
  schedule:
    - cron: "<minute> 4 * * 1"
  workflow_dispatch:
env:
  STATED_JOBS: 3
  STATED_JOB_MINUTES: 90
  STATED_REASON: one runner for each part of the package
jobs:
  mutation:
    uses: mark1russell7/template/.github/workflows/reusable-mutation.yml@<commit> # main
```

`STATED_JOBS` is the number of jobs, with the job `plan`. `STATED_JOB_MINUTES` is the sum of the minutes of the jobs.

| Input | Default | What it sets |
|---|---|---|
| `selections` | (empty) | The packages or parts to mutate, separated by spaces or commas. Empty gives each part of each package with parts, and each other package. |
| `lane` | `mutation.json` | The lane file. |
| `concurrency` | `4` | The test processes of Stryker on each runner. |
| `timeout-minutes` | `120` | The time limit of each selection. Divide a package into parts when one selection needs more. |
| `stop-minutes` | `0` | The time after which Stryker stops. `0` gives `stopMinutes` of the lane, at most `timeout-minutes` minus 10. |
| `dry-run` | `false` | Start only the tests, with no mutant and no gate. |
| `changed` | (empty) | The changed files, separated by commas or lines. Only their runs start. It takes an empty `selections`. |
| `report-only` | `false` | Write the scores, but do not fail a score under the gate. |
| `test-counts` | (empty) | The file of the last good test counts. A fall of a count fails the selection. Empty compares no count. |
| `node-version` | `26` | The Node.js version. |
| `working-directory` | `.` | The folder of the root `package.json`. |

The gates are in the lane file, not in an input. Thus a local run and CI use the same gate.

## Pages

`reusable-pages.yml` has three jobs. The job `ref` decides if the commit of the event builds and deploys. It starts no code of the repository.

The job `build` checks out the commit of the event, with no ref of its own. It installs, builds the site, adds the pages of `site-pages` and uploads the Pages artifact. It gets only read permissions. The job `deploy` deploys the artifact. It starts no code of the repository. Its action cancels a deployment after 606 s, before the job limit of 12 minutes.

The job `build` uses two actions. `site-config` reads the site config, and `pages-build` builds the site. The check of a pull request uses the same two actions ("The site config").

The site values are in `.github/site.json`:

```json
{
  "build": "pnpm --filter @crawler/site run build",
  "out": "packages/site/dist",
  "env": { "SITE_BASE": "/{repo}", "ASTRO_TELEMETRY_DISABLED": "1" },
  "roadmap": "docs/ROADMAP.md",
  "packages": "polite-crawler,polite-crawler-mcp",
  "site-check": true
}
```

The caller `pages.yml` gives only the permissions:

```yaml
on:
  push:
    branches: [main]
  # After a release, so that the Releases page has the new version (the rule pages-after-release)
  workflow_run:
    workflows: [Release]
    types: [completed]
    branches: [main]
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
      actions: read
      issues: read
      pull-requests: read
      checks: read
      statuses: read
      pages: write
      id-token: write
```

The job `site` of `ci.yml` checks the site of each pull request, and "CI OK" needs it:

```yaml
  site:
    uses: mark1russell7/template/.github/workflows/reusable-pages-check.yml@<commit> # main
    permissions:
      contents: read
```

- A repository that publishes a package also starts Pages after a release, with `workflow_run` of `Release`, and on each day. A release starts no Pages run by itself, so the Releases page is behind npm until the next build. The rule `pages-after-release` of `@mark1russell7/conventions` examines both triggers, and `conventions fix` writes them.
- The job `ref` writes its decision and the reason to the step summary of the run.
- A push to `main` deploys its commit. A pull request and a push to a different branch only build.
- A schedule, a run by hand, a repository dispatch and a run after a release build the head of `main`. They deploy it when its CI passed, or while its CI runs and `pending` is `head`.
- A red head of `main` deploys nothing. The site keeps its last deploy and does not go back to an older commit.
- A run after CI deploys only when the commit of CI is the head of `main`. Else the CI run of the newer commit deploys it.
- A caller on `workflow_run` after CI is also correct. A failed CI run, a CI run of a pull request and a CI run of a push to a different branch build nothing. The job `build` examines the branch, so the filter `branches: [main]` of the caller is not necessary.
- The input `pending` is `head` by default. With `pending: green`, a head whose CI runs deploys nothing.
- The inputs of `site-pages` go to the action: `site-pages-version`, `roadmap`, `base`, `packages`, `changesets`, `group`, `css`, `site-name` and `data-only`.
- An empty `site-pages-version` (the default) builds the Releases page and the Status page from the source of site-pages at the template commit of the workflow. A version range installs that version from npm.
- `site-pages: false` builds the site without the Releases page and the Status page.
- Without `roadmap`, the Status page shows only the open pull requests and issues. The rule `roadmap-parses` of `@mark1russell7/conventions` thus needs `roadmap` in the site config or in each call, or `site-pages: false`.
- `site-check: true` checks the built pages in a headless Chromium before the upload. A failed check stops the deploy. The next list tells the check.
- The check opens each page of `site-check-pages` (default: the home) at the widths 360, 400 and 1280, in light and dark.
- A page fails when it is wider than the screen, or an element goes past the right edge.
- A page also fails when it shows no text, or a text area hides its text.
- A page also fails when a box with `overflow-x: hidden` or `clip` cuts text.
- A page also fails when a table in a box that scrolls goes out of view at a phone width.
- The attribute `data-overflow-ok` marks a box that is meant to scroll or to clip. The `README.md` of `site-pages` tells the rule and what does not count.
- A console error, an exception or a failed request also fails the page.
- A page that links to other sites of its origin names their paths in the meta tag `site-check-other-paths`. The `README.md` of `site-pages` tells the rule.
- `site-check-probe` is a JavaScript or TypeScript file that tests the interactive core of the home. Its checks run at each width. The check removes the types of a `.ts` file, so the site needs no build step for its probe. `site-pages check --help` tells its functions.
- `site-check-probe` also takes a probe for other pages, as `<page>=<file>` pairs separated by commas, for example `test-probe.js, /structures/=src/structures-probe.ts`. A file with no page is the probe of the first page. A page with no probe has none.
- The check uses the Chromium of `playwright-core` at `site-check-playwright`, from the action `setup-playwright`. The artifact `site-check` has the screenshots and `report.json`.
- `playwright-browsers` names the Playwright browsers that the build needs, for example `chromium`. The action `setup-playwright` installs them before the build.
- `playwright-command` is the Playwright CLI of the repository, for example `pnpm --filter @vex/site exec playwright`. Its version is the version of the build.
- The install has a cache, a time limit and one more try. Thus the build command needs no `playwright install` of its own. The rule `playwright-install` of `@mark1russell7/conventions` finds such an install.
- Two calls of `reusable-pages.yml` in one run need two values of `artifact-prefix`. The prefix goes before the names `github-pages` and `site-check` of the artifacts.
- A download by name gets only the latest artifact of the name. `download-artifact` also finds by ID only the latest artifact of each name. Thus two artifacts of one name in one run are a fault.
- The check runs from `packages/site-pages/src/check` of the template commit of the workflow. It needs Node.js 22.18 or later.
- A site with its own Pages workflow uses the action `site-check` before the upload of the Pages artifact. The inputs have the same names, and `out` is the built site.
- A site with its own Pages workflow uses the action `data-stamps` for the freshness gate. Its input `stamps` is the file of stamps in the built site.
- A scheduled build or a build after a release can build an older green commit. When that commit does not have the file of stamps yet, the gate warns and skips. When the build is of the commit of the workflow, a missing file fails the gate.
- The workflow `site-audit.yml` of the template checks the live home of each public site each Monday. Start it by hand from the Actions tab.
- The audit does not fail for a bad site. Its artifact `site-audit` has the screenshots, `report.json` of each site and `audit.json`.
- The job `nav` of the audit starts `site-pages nav` on each site. Its artifact `site-nav` has the screenshots, `report.json` of each site and `nav.json`.
- Each pull request starts `site-audit.yml`, so its check "Site audit OK" is always there. A pull request that changes `site-audit.yml` or the crawl starts the job `nav`. A pull request that changes the site check starts the job `compare`.
- `site-bar: true` writes the shared site bar into each built HTML page. `site-bar-pages` names the pages of the bar, for example `Demo=demo/,Docs=docs/`. `site-bar-npm` gives the npm link.
- With `site-bar: true`, the crawl `site-pages nav` examines the built site. A page with no bar, a page more than 2 clicks from home or a page with no way back stops the deploy.
- `scroll-cue` (default `true`) gives each code block of each built HTML page the scroll cue of `site-pages cue`. A block wider than its box shows a fade at the edge with more content.
- A code block with `data-overflow-ok` keeps no cue. `scroll-cue: false` stops the step.
- `deploy: false` builds and uploads the artifact, with no deploy.
- `indexnow-key` sends the URLs of `sitemap.xml` to the IndexNow engines after each deploy that is not scheduled.
- The site must serve `<key>.txt` with the key. The key is public. A failure of the job `indexnow` does not fail the deploy.
- `github-token: true` gives the build `GITHUB_TOKEN`, with the read permissions of the build job.
- The workflow gets the actions of the same template commit as the workflow file. A second checkout gets them.
- Each public repository has a site. The rule `pages-site` of `@mark1russell7/conventions` needs a call of this workflow without `deploy: false`.
- The Pages source of the repository is "GitHub Actions". To set it, start `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow` one time.

### The compare of the site check

A change of the site check can fail a page that passed before. The site sees the failure only when its pin moves. Thus the job `compare` of `site-audit.yml` examines each change of the check before it merges.

- The job starts on a pull request that changes `packages/site-pages/src/check`, `bar`, `render/html.ts`, `scripts/workflows/site-compare.ts` or `site-audit.yml`.
- For each public site with a site check, `scripts/workflows/site-compare.ts` reads the pages and the widths of its site config.
- The config is `.github/site.json`, the inputs of the call of `reusable-pages.yml` without `deploy: false`, or the inputs of the action `site-check`.
- The script starts the check of the base and the check of the pull request on the live pages. Then it compares the problems of each view.
- A view is a page at one width in one color scheme. A problem that only the new check finds is a new problem.
- A site with a new problem gets a second pair of checks. Only a new problem of both pairs fails the job. A problem of one pair is a warning.
- A site with no report of the base is a no read, with a warning. A site with a report of the base and no report of the pull request fails.
- A site with no site check is out of scope, because no change of the check fails its deploy. The probes of the sites are not part of the compare.
- The job has 4 shards. Two shards start at one time, after the job `nav`. One check of all sites is approximately 1000 views, or 65 minutes.
- The artifact `site-compare-<shard>` has `compare-<shard>.json`, and the report and the log of each check. Only a site with a new problem keeps its screenshots.

### The compare of the conventions rules

A change of a rule of `@mark1russell7/conventions` can fail a repository that passed before. The repository sees the failure only when its pin moves. Thus the job `rules` of `ci.yml` examines each change of the rules before it merges.

- The job starts on a pull request of the template that changes `packages/conventions/src`, `scripts/workflows/rule-compare.ts`, `scripts/lib/gh.ts` or `ci.yml`. A change of a test file only does not start it.
- The job asks only for `contents: read`. The job `verify` of `release.yml` uses `ci.yml` with that grant, and a job that asks for more stops each release run at its start. The test `scripts/workflows/call-permissions.test.ts` holds this for each call of a workflow of the template.
- `scripts/workflows/rule-compare.ts` lists the public repositories that are not archived, of each owner of `packages/conventions/src/owners.ts`. Thus a repository that moves to another owner stays in the compare.
- The list comes from `publicRepos` of `scripts/lib/gh.ts`, with its retry after a transient error. The script clones each repository at its default branch, with one commit.
- A repository with no dependency on `@mark1russell7/conventions` in its root `package.json` is out of scope. The template is out of scope, because its own CI examines it.
- In each clone, the script starts `conventions check --json --no-base` of the base and then of the pull request.
- The two checks get the event file of a dispatched run of that repository. Thus no rule reads the pull request of the template, and a rule that examines a change skips.
- The checks do not get the secret `CONVENTIONS_PRIVATE_PATTERNS`. Thus no private name goes into the report.
- A place is a rule with a file and a line. A failure is a break of a rule with the status `break`, or a rule that threw.
- A place with more failures in the check of the pull request than in the check of the base has new failures.
- A place with the same count and a different text has a changed text. A changed text is not a new failure, and the summary counts it.
- A failure of the base at a place with fewer failures in the pull request is a gone failure. The summary counts and lists them, so a fix shows each repository that it changes.
- A repository with a new failure gets a second pair of checks. Only a new failure of both pairs fails the job. A new failure of one pair is a warning.
- A repository with no result of the base is a no read, with a warning. A repository with a result of the base and no result of the pull request fails.
- The summary names each rule that skips in each repository with a result. The compare cannot read such a rule.
- The artifact `rule-compare` has the folder `conventions`. It has `rule-compare.json`, and the output, the log and the event file of each check.
- The fix of a new failure merges with its migration. An example is a sync rule of the release train that changes each repository before the rule fails.

### The compare of the import boundaries

A change of `@mark1russell7/boundaries` can also fail a repository that passed before. The same job `rules` examines it with `rule-compare.ts --tool boundaries`.

- The step starts on a pull request that changes `packages/boundaries/src`, `scripts/workflows/rule-compare.ts`, `scripts/lib/gh.ts` or `ci.yml`. A change of a test file only does not start it.
- The step starts also after a failure of the compare of the rules. Thus the summary has the result of each compare.
- A repository is in scope when its root `package.json` has a dependency on `@mark1russell7/boundaries` and the script `check:boundaries`.
- The script must be one `depcruise` command with plain words. Each other script is a no read, with a warning.
- The script installs each clone with `pnpm install --frozen-lockfile --ignore-scripts`. A failed install is a no read.
- Before each check, the script links the package of the base, or of the pull request, into the `node_modules` of the clone.
- Each check starts the words of `check:boundaries` with a JSON output. The clone gets no build, so an import that resolves only after a build gets the same result in both checks.
- Each rule of the rule set is a rule of the result. A violation of a rule with the severity `error` is a failure. A violation of each other severity warns.
- A place is a rule and the file of the import. The text of a failure tells the target of the import.
- New failures, changed texts and gone failures follow the rules of the compare of the conventions rules.
- The artifact `rule-compare` has the folder `boundaries`. It has `rule-compare.json`, the install log of each clone, and the result and the log of each check.

### The site config

The file `.github/site.json` is the one home of the values of the site. The deploy of `main` and the check of each pull request read it. Thus a pull request checks the site that `main` deploys.

- The keys of the file are the site inputs of `reusable-pages.yml`, with the same names and the same defaults. The file needs `build` and `out`.
- The inputs `pending`, `deploy`, `fetch-depth`, `ci-workflow`, `artifact-prefix`, `page-url` and `timeout-minutes` stay in the call. They are not keys of the file.
- In each string value, `{owner}` is the owner of the repository and `{repo}` is its name. For example, `"SITE_BASE": "/{repo}"`.
- A boolean key takes `true` or `false`. The key `env` is an object of strings.
- An unknown key, a value of the wrong type or a file that is not JSON stops the build with a message.
- When the repository has the file, a call that also gives a site input with a value different from its default fails. Give each site value in one place.
- A repository with no file keeps its site inputs in the call of `reusable-pages.yml`. The check of a pull request needs the file.
- The job `site` of `ci.yml` uses `reusable-pages-check.yml`. "CI OK" needs the job, so a pull request with a bad site does not merge.
- The check builds the site and starts the site check and the probe, as the deploy does. It uploads the artifacts and deploys nothing.
- GitHub counts the permissions of a called workflow against the grant of the caller job. A CI job of a pull request has no write permission.
- Thus `reusable-pages-check.yml` gets only `contents: read`. On a public repository, each read of `site-pages` works with this token.
- The rule `roadmap-parses` of `@mark1russell7/conventions` reads the file. It reports a bad file on the pull request, before the deploy reads it.
- The rule `site-check-in-ci` of `@mark1russell7/conventions` holds this form. It needs the file and a job that checks the site, in the needs of "CI OK".
- The rule also finds a site input in the call of the deploy. It finds a deploy that a pull request starts, directly or through a call.
- The preset `site` of `template-cli` writes `.github/site.json`, and the stamp writes the job `site` into `ci.yml`.

## Security

The action `security-scan` has three scans in one job. On a pull request, a scan fails only for a new finding at or above `fail-on-severity`. On a push, a schedule or a manual run, the scans upload their findings to code scanning. Then they do not fail. Thus the Security tab shows the old findings, and the old findings do not block a pull request.

| Scan | On a pull request | On a push, a schedule or a manual run |
|---|---|---|
| `dependency-review` | GitHub compares the dependencies of the base and of the pull request. The scan fails for a new dependency with a known vulnerability. | The scan does not start. |
| `osv-scanner` | The scan reads the lockfiles of the base and of the pull request. It fails for a vulnerability that only the pull request has. | The scan reads all the lockfiles and uploads the results. |
| `codeql` | CodeQL analyzes the source with no build. The scan fails for a new alert on a line that the pull request adds or changes. | CodeQL analyzes the source and uploads the results. |

CodeQL first downloads the bundle of the version of `codeql-action`. If that download fails (for example, GitHub gave HTTP 504 again and again on 2026-11-08), the action waits 60 seconds. Then it starts CodeQL again, with a second download of the same bundle. If the second start also fails, the scan fails. The step summary names the bundle and the start that passed. A start with no download is not possible, because `codeql-action` ignores `tools: toolcache` in a run of a push or a pull request.

An alert of CodeQL that is already open on the base branch is not new. The step groups the alerts by rule, file and message. A group is new only when the pull request has more alerts of it than the base branch has open. Thus a second alert of a known group fails. The step reads the open alerts of the base branch from the code-scanning API, with `security-events: read`. If it cannot read them, the step fails.

To accept one alert of CodeQL, write the comment `codeql[<rule id>]` on the line above the alert. Write the reason in the same comment:

```ts
// codeql[js/disabling-certificate-validation] The probe reads the certificate and does not send data.
const socket = connect({ host, port, rejectUnauthorized: false });
```

The step `Languages` gives CodeQL the query `AlertSuppression.ql` of each language that has one (`codeql-config.ts`). Then the SARIF result of the alert has `suppressions`, and the step skips it. The languages `actions` and `rust` have no such query. Thus a comment in a workflow file changes nothing.

### A private repository

In a private repository, the dependency review and the code-scanning API need GitHub Advanced Security. A personal account cannot buy it. Thus the inputs `dependency-review`, `codeql` and `osv-upload` have the default `auto`:

- In a public repository, `auto` starts the part.
- In a private repository, `auto` skips the part. osv-scanner runs, and its pull request check stays the same.
- `true` and `false` keep their meaning. A private repository with GitHub Advanced Security sets `true`.
- The first step reads the visibility from the event. The event of a schedule has no repository, so then the step reads the API.

A skip is not a pass. The last step gives a warning for each scan that `auto` skips, and the table of the summary shows `skip`. On a push, a schedule or a manual run, osv-scanner does not upload its results. Then a warning gives the count, and the summary of the run lists the vulnerable packages.

Each scan starts also when an earlier scan failed. The last step of the action fails when a scan fails, and its error names that scan. The summary of the run shows a table of the scans. If the inputs start a scan and no step of it starts, the last step also fails.

The job is the summary job `Security OK` ("The check of the ruleset"). One job asks for one runner. Before, the scans had three jobs and a summary job, and each job waited in the queue for its runner. The scans start one after the other, so a run takes approximately 15 seconds more.

The job of the caller gives the permissions and the time limit. A composite action cannot set `timeout-minutes` for its job:

```yaml
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "<minute> 5 * * 1" # the minute that the rule runner-budget gives
  workflow_dispatch:

permissions: {}

concurrency:
  group: security-${{ github.event_name == 'pull_request' && github.ref || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  security-ok:
    name: Security OK
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      security-events: write
      actions: read
    steps:
      - uses: mark1russell7/template/.github/actions/security-scan@<commit> # main
```

| Input | Default | What it sets |
|---|---|---|
| `fail-on-severity` | `high` | A pull request fails for a new finding at or above this severity: `low`, `moderate`, `high` or `critical`. |
| `dependency-review` | `auto` | The scan `dependency-review`: `true`, `false` or `auto` ("A private repository"). |
| `dependency-review-scopes` | `runtime, development, unknown` | The scopes of the dependencies that the dependency review examines. |
| `osv` | `true` | The scan `osv-scanner`. |
| `osv-upload` | `auto` | The upload of the results of osv-scanner to code scanning: `true`, `false` or `auto`. |
| `osv-lockfile` | (empty) | The lockfiles of osv-scanner, separated by spaces. Empty scans each lockfile of the repository. |
| `codeql` | `auto` | The scan `codeql`: `true`, `false` or `auto`. |
| `codeql-languages` | `javascript-typescript,actions` | The CodeQL languages. The scan skips a language with no files in the repository. |
| `codeql-build-mode` | `none` | The CodeQL build mode. |

- The action checks out the repository. On a pull request, the checkout is the merge commit, with its base as the first parent.
- `security-events: write` lets the scans upload the results. `actions: read` lets CodeQL and the upload read the run in a private repository. The dependency review needs only `contents: read`.
- No step installs or starts the code of the repository.
- The severity of a finding is its CVSS score or its CodeQL `security-severity`. `high` is 7.0 or more, and `critical` is 9.0 or more.
- A file `osv-scanner.toml` next to a lockfile tells osv-scanner which vulnerabilities to ignore.
- A repository with the default setup of code scanning sets `codeql: false`, because the default setup refuses the results of a CodeQL workflow.
- The last step starts `verdict.ts` with the Node of the runner. Node 22.18 or later runs TypeScript with no build, and the `ubuntu-latest` image has such a Node.

### The old workflow

`reusable-security.yml` is deprecated. It has the same scans in three jobs, and a repository that pins it continues to work. To change to the action, replace the jobs `security` and `security-ok` of the caller with the one job above. Keep the job name `Security OK`, because the ruleset needs that check. A later release of the template removes the workflow.

## Pins and Renovate

A repository pins each shared workflow and action to a commit of `main`:

```yaml
uses: mark1russell7/template/.github/workflows/reusable-ci.yml@<full commit SHA> # main
```

- Renovate reads the comment `# main` and moves the pin to the newest commit of `main` (the preset of `renovate/`). The manager `github-actions` does this since Renovate 43.84.0.
- These updates come in one group, "template workflows and actions", with no wait. The pull request gets the label `train-merge`. The release train merges it when CI passes and no release of the repository is open.
- The group comes on Monday before 06:00 (New York time). A workflow change during a release makes the tag job fail with HTTP 403 (`RELEASING.md`).
- Renovate does not change `release.yml`. The release session moves the pins of `release.yml` with `scripts/release/bump-pins.ts` (`RELEASING.md`).
- A change of the template that must not wait for Renovate goes out with `bump-pins.ts --file <workflow>` (`RELEASING.md`).
- Renovate also moves `CLAUDE_CODE_VERSION` of `reusable-ai-review.yml` to the newest version on npm. A person reviews and merges that pull request.

### The packages of the workflow scripts

Some workflow scripts import a package of the template, for example `@mark1russell7/text`. The workflow installs that package with npm, outside pnpm. It does not pin a version of its own.

- The install step starts `.github/actions/pull-of-run/locked-version.ts`. The script reads the version that `pnpm-lock.yaml` of the template gives for the root package.
- The script is in the folder of the action. Thus each checkout of the action has it, also a sparse checkout of `.github/actions`.
- Thus a bump of the lockfile, for example by the release train, also moves each such install. No pin in a workflow stays behind.
- `reusable-queue.yml` and the action `pull-of-run` install `@mark1russell7/text` in this way.
- The job `rules` of `ci.yml` installs `@mark1russell7/text` and `@mark1russell7/service` in this way, into `scripts`. Thus `scripts/workflows` and `scripts/lib` both find them.
- A test of `scripts/workflows/locked-version.test.ts` fails when a workflow or an action installs a package of the lockfile at a version in its text.
- The script imports only Node.js modules, because it starts before the install.

## The template and new repositories

The workflows of the template call the shared workflows and actions by a local path, for example `./.github/workflows/reusable-ci.yml`. Thus each pull request of the template tests them:

- `ci.yml` tests `reusable-ci.yml`.
- `security.yml` tests the action `security-scan`. The tests of `scripts/workflows/security-scan.test.ts` start no scan. They examine the choice of the scans, the last step, the step that finds the new CodeQL alerts and the query of the suppression comments.
- Before the action, `security.yml` checks out the folder `.github/actions` of the template. This step operates only in the template. In a private repository, its partial clone makes the checkout of the base fail.
- `actions-test.yml` tests the actions, `reusable-pages.yml` and the release workflows, with `dry-run`. It publishes nothing. On a pull request, it sets the input `require-main` of the release build to `false`.
- On each pull request, the job `site` of `ci.yml` uses `reusable-pages-check.yml`. It builds the site of the template and starts its probe, with no deploy.
- "CI OK" needs the job `site`. Thus `gh pr merge --auto` waits for the probe of the site.
- `release.yml` uses `ci.yml` with only `contents: read`. The job `site` needs no more permissions.
- The job `pages` of `actions-test.yml` uses `reusable-pages.yml` with no site config. It tests the site inputs of a repository with no `.github/site.json`.
- `ai-review.yml` tests `reusable-ai-review.yml`, and `codex-review.yml` tests `reusable-codex-review.yml`. Without its API key, a review stops at once with a note.
- The tests of `scripts/ai-review/` examine the request, the redaction and the post of the second review, with no network.
- `queue.yml` uses `reusable-queue.yml`, so each push to `main` of the template starts the queue. The tests of `scripts/workflows/queue.test.ts` examine the plan, the calls of the API, the summary and the two workflow files, with a fake API.
- The job `lockfile` of `actions-test.yml` tests `reusable-lockfile.yml`. It merges `main`, makes the file and uploads the artifact, with no dispatch.

The job `publish` of `release.yml` uses the pinned form of `npm-publish`, also in the template. A local action needs a checkout, and that job does no checkout.

The stamp (`scripts/stamp/main.ts`, started by `new-repo.ps1`) copies only the files that its list `KEEP` names. It does not copy the shared workflows, the actions or `actions-test.yml`. It changes each local path and each pin of the template to the pinned form, with the commit of the template that it copies. The job `stamp` of `ci.yml` makes a repository. With no hand edit, that repository must pass its install, its checks, its Pages build and the site check.

The job starts the stamp with `--link`. Then each package of the template in that repository is a `link:` to its folder in the commit, not a range from npm. Thus a pull request can change a rule and the files that the stamp writes together. Without `--link`, the repository gets the rule from npm, which does not have the change before the release.
