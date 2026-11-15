# Renovate presets

These presets hold the shared Renovate settings of the repositories of mark1russell7. Each repository extends one preset in its `renovate.json`, and adds only its own rules.

| Preset | What it gives |
|---|---|
| `github>mark1russell7/template//renovate/default` | `base` and `automerge`. Most repositories use it. |
| `github>mark1russell7/template//renovate/base` | The schedule, the groups and the release-age waits, with no automerge. |
| `github>mark1russell7/template//renovate/automerge` | Only the automerge rules. |
| `github>mark1russell7/template//renovate/weekly` | Pull requests only on Monday before 06:00, for a repository that pays for its CI minutes. It goes after `default` or `base`. |
| `github>mark1russell7/template//renovate/expo` | No major or minor update of a package that an Expo SDK decides, except a security fix. A new SDK shows on the Dependency Dashboard. An Expo repository extends it after `default` and names the owner who moves the SDK. |

## What the settings do

- Renovate opens pull requests each day before 06:00 (New York time), with 5 open pull requests at most. A repository that pays for its CI minutes extends `weekly` too, and then gets them only on Monday (refer to "The weekly schedule").
- `rangeStrategy` is `update-lockfile`: Renovate changes the lockfile, and the ranges of a published package stay the same.
- Renovate waits 3 days after a release.
- Renovate does not update the npm packages `@procedures/*` and `@mark1russell7/*`. The release train (mark1russell7/release-train) updates them, with no wait. `pnpm-workspace.yaml` excludes them from the age gate of pnpm.
- A security update comes at any time, with no wait.
- The release train can add a commit to a pull request of Renovate, for example the version raise that a release needs. `gitIgnoredAuthors` names the app of the train, so Renovate does not read the pull request as changed by a person. Renovate keeps the pull request current, and the train adds its commit again after a rebase.
- The groups:
  - The npm patch updates: one pull request.
  - The minor updates of the development dependencies and of pnpm (also the field `packageManager` of `package.json`): one pull request.
  - The minor updates of the runtime dependencies: one pull request.
  - A minor update before 1.0.0 can break (SemVer). These updates get a group of their own, for a review.
  - The GitHub Actions (minor, patch, digest): one pull request. A major update gets a pull request of its own.
  - The shared workflows and actions of the template: one pull request, "template workflows and actions".
  - The Claude Code CLI of a workflow (`CLAUDE_CODE_VERSION`): one pull request, "Claude Code CLI", for a review.
- Renovate opens no pull request for a range in `peerDependencies`. It lists each new version on the Dependency Dashboard, and a person ticks it there or changes the range by hand. A range is a promise to the users.
- Renovate does not change `.github/workflows/release.yml` or `scripts/release/`. These files change only from `~/git/template` (`RELEASING.md`).

## The pins of the template

A repository pins each shared workflow and action of the template to a commit of `main` (`CI.md`):

```yaml
uses: mark1russell7/template/.github/workflows/reusable-ci.yml@<full commit SHA> # main
```

- The comment `# main` tells Renovate the branch. Renovate moves the pin to the newest commit of `main`.
- The manager `github-actions` reads the `uses:` of a job (a shared workflow) and of a step (an action).
- Renovate 43.84.0 and later read a comment that is not a version as a branch or a tag ([renovatebot/renovate#40225](https://github.com/renovatebot/renovate/pull/40225)). The datasource `github-digest` then gives the newest commit of that branch. Thus the preset needs no regex manager for these pins.
- The Dependency Dashboard of a repository shows each pin as `mark1russell7/template main@<commit>`, with the update "digest to `<commit>`".
- All the pins of a repository come in one pull request, "template workflows and actions" (branch `renovate/template-workflows`).
- A commit of a branch has no release date. Thus the preset sets no release-age wait for `mark1russell7/template`.
- Without that rule, Renovate holds these updates with no end (`minimumReleaseAgeBehaviour` is `timestamp-required`).
- These pull requests come on Monday before 06:00 (New York time), also when a repository changes its own schedule. A workflow change during a release makes its tag job fail with HTTP 403 (`RELEASING.md`).
- The pins in `release.yml` stay as they are. The release session moves them (`RELEASING.md`).

## The Claude Code CLI

`reusable-ai-review.yml` installs the Claude Code CLI from npm at a fixed version:

```yaml
env:
  CLAUDE_CODE_VERSION: 2.1.307
```

- A regex manager of `base` reads each line `CLAUDE_CODE_VERSION: <x.y.z>` in `.github/workflows/`. It gets the versions of `@anthropic-ai/claude-code` from npm.
- The update comes in a pull request of its own, "Claude Code CLI", after the release-age wait of 3 days.
- Renovate does not merge it, also with `default`. The CLI operates with the API key, so a person reviews each new version.

## Automerge

With `default`, Renovate merges these updates when CI passes:

- the npm patch updates,
- the minor updates of the runtime and the development dependencies,
- the minor and patch updates of pnpm, also in the field `packageManager`. The release check of a package ignores this field.

It does not merge a major update, a minor update before 1.0.0, or an update of the Claude Code CLI. With `rangeStrategy` `update-lockfile`, a range that holds the new version stays the same, and only the lockfile changes.

The minor, patch and digest updates of the GitHub Actions, with the pins of the template, get the label `train-merge`. The release train merges them when CI passes and no release of the repository is open. A workflow change during a release makes GitHub refuse its tag (HTTP 403).

Renovate merges the pull request itself (`platformAutomerge` is `false`). Thus it waits for CI also in a repository with no branch protection.

A repository with no automerge extends `base` in place of `default`.

## Rebases

Renovate rebases a branch only when the branch has a conflict (`rebaseWhen` is `conflicted`). With the default of Renovate, an automerge branch gets a rebase each time `main` moves. Each rebase starts CI again, so a long CI can stop the merge for days.

Two updates can merge with no test of the two together. The CI of `main` tests them after the merge.

If up-to-date branches are necessary in a repository, that repository changes this setting to `behind-base-branch`. If it does not, Renovate cannot merge a branch that is behind `main`.

## Lock file maintenance

Each Monday before 06:00 (New York time), Renovate deletes the lockfile and makes it again with the package manager: one pull request, "Lock file maintenance". With `default`, Renovate merges it when CI passes.

- Most security advisories are for an indirect dependency, for example a dependency of a development tool. Renovate does not update an indirect dependency of a pnpm lockfile alone. A new lockfile takes the newest version in each range, and thus the fixed version.
- The ranges in `package.json` stay the same. Only the lockfile changes.
- The release-age wait of Renovate does not apply to a new lockfile. The wait of pnpm applies: since pnpm 11, pnpm installs no version newer than 1 day (`minimumReleaseAge`, default 1440 minutes), also for an indirect dependency. Each install of pnpm has this wait, so the maintenance adds no new risk.
- A dependency can pin an exact version, for example `minimatch: 10.2.3`. Then a new lockfile keeps that version. An `overrides` entry in `pnpm-workspace.yaml` replaces it, with the reason and the end of the override in a comment.
- A new lockfile can change a build tool, and thus the built files of a package. Then the release check (`scripts/release/unchanged.ts`) names the files, and the package gets a new PATCH version.

## The weekly schedule

Each day, Renovate can open a pull request that waited for its 3 days of release age. Thus a new version arrives approximately 3 days sooner than with one run on Monday. Each pull request and each merge starts CI, and a public repository gets its Actions minutes free.

A repository that pays for its CI minutes extends `weekly` after `default` or `base`:

```json
{ "extends": ["github>mark1russell7/template//renovate/default", "github>mark1russell7/template//renovate/weekly"] }
```

The reason is the cost of CI. When the CI of the repository operates on its own runners, it removes `weekly`. A security update comes at any time, also with `weekly`.

## The validator

The CI of the template starts the validator of Renovate (`renovate-config-validator --strict`) on each file of `renovate/` (the job `renovate-presets` of `ci.yml`). Each repository extends these presets, so a fault in one of them stops Renovate in each repository. A custom manager of `base` updates the version of the validator (`RENOVATE_VERSION` in `ci.yml`).

## The rules of a repository

Add the rules of a repository after `extends` in its `renovate.json`. For example:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>mark1russell7/template//renovate/default"],
  "ignorePaths": [
    "**/node_modules/**",
    "**/bower_components/**",
    "**/vendor/**",
    "**/examples/**",
    "**/__tests__/**",
    "**/test/**",
    "**/tests/**",
    "**/__fixtures__/**",
    "packages/harness/image/**"
  ],
  "packageRules": [
    {
      "description": "This package has a pnpm patch for its exact version: update it by hand.",
      "matchPackageNames": ["@stryker-mutator/core"],
      "enabled": false
    }
  ]
}
```

- Leave `ignorePaths` out, unless the repository has paths of its own to ignore. Renovate does not merge `ignorePaths`: the list of a repository replaces the default list of `config:recommended`. Thus a repository list repeats the eight default paths of the example, and then adds its own paths.
- The release files stay out in all cases, because a package rule (not `ignorePaths`) excludes them.
- Renovate adds the `packageRules` of a repository after the rules of the preset, so a rule of the repository wins.

## Move a repository to the preset

1. Replace its `renovate.json` with an `extends` of the preset, and keep only its own rules.
2. Remove `.github/dependabot.yml`, if it exists. Dependabot and Renovate open the same updates twice.
3. Close the open pull requests of Dependabot. Renovate opens them again at its first start, in the groups.
4. Check the file with the validator (below).

## Check a change

Put the file as `renovate.json` in an empty folder, and start the validator in that folder:

```bash
npx -p renovate renovate-config-validator --strict
```

With no file argument, the validator checks the file as the configuration of a repository.
