# Renovate presets

These presets hold the shared Renovate settings of the repositories of mark1russell7. Each repository extends one preset in its `renovate.json`, and adds only its own rules.

| Preset | What it gives |
|---|---|
| `github>mark1russell7/template//renovate/default` | `base` and `automerge`. Most repositories use it. |
| `github>mark1russell7/template//renovate/base` | The schedule, the groups and the release-age waits, with no automerge. |
| `github>mark1russell7/template//renovate/automerge` | Only the automerge rules. |

## What the settings do

- Renovate opens pull requests on Monday before 06:00 (New York time), with 5 open pull requests at most.
- `rangeStrategy` is `update-lockfile`: Renovate changes the lockfile, and the ranges of a published package stay the same.
- Renovate waits 3 days after a release. For `@procedures/*` and `@mark1russell7/*` it waits 1 day, the same as the age gate of pnpm.
- A security update comes at any time, with no wait.
- The groups:
  - The npm patch updates: one pull request.
  - The minor updates of the development dependencies: one pull request.
  - The minor updates of the runtime dependencies: one pull request for a review.
  - A minor update before 1.0.0 can break (SemVer). These updates get a group of their own, for a review.
  - The GitHub Actions (minor, patch, digest): one pull request. A major update gets a pull request of its own.
- Renovate does not change a range in `peerDependencies`. Change it by hand.
- Renovate does not change `.github/workflows/release.yml` or `scripts/release/`. These files change only from `~/git/template` (`RELEASING.md`).

## Automerge

With `default`, Renovate merges these groups when CI passes: the npm patch updates, the minor updates of the development dependencies, and the minor, patch and digest updates of the GitHub Actions. It never merges a minor update before 1.0.0.

Renovate merges the pull request itself (`platformAutomerge` is `false`). Thus it waits for CI also in a repository with no branch protection.

A repository with no automerge extends `base` in place of `default`.

## The rules of a repository

Add the rules of a repository after `extends` in its `renovate.json`. For example:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>mark1russell7/template//renovate/default"],
  "ignorePaths": ["**/node_modules/**", "packages/harness/image/**"],
  "packageRules": [
    {
      "description": "This package has a pnpm patch for its exact version: update it by hand.",
      "matchPackageNames": ["@stryker-mutator/core"],
      "enabled": false
    }
  ]
}
```

- `ignorePaths` in a repository replaces the list of `config:recommended`. Thus put `**/node_modules/**` in the list too. The release files stay out, because a package rule (not `ignorePaths`) excludes them.
- Renovate adds the `packageRules` of a repository after the rules of the preset, so a rule of the repository wins.

## Move a repository to the preset

1. Replace its `renovate.json` with an `extends` of the preset, and keep only its own rules.
2. Remove `.github/dependabot.yml`, if it exists. Dependabot and Renovate open the same updates twice.
3. Close the open pull requests of Dependabot. The first run of Renovate opens them again, in the groups.
4. Check the file with the validator (below).

## Check a change

Put the file as `renovate.json` in an empty folder, and run the validator in that folder:

```bash
npx -p renovate renovate-config-validator --strict
```

With no file argument, the validator checks the file as the configuration of a repository.
