# @mark1russell7/conventions

This package is one check in CI for the conventions that the docs of a repository tell in prose. Each rule is a small module with an id, a reason, a fix and the rows of the invariants audit that it comes from. A repository turns a rule off or changes a rule only with a reason in its `package.json`. Thus each exception is visible in the diff.

## Use

Install the package:

```sh
pnpm add -D @mark1russell7/conventions
```

Add the script `"check:conventions": "conventions check"` to the root `package.json`. The shared CI of the template starts `check:conventions` after `lint` (`CI.md`).

```sh
pnpm exec conventions check
pnpm exec conventions fix
pnpm exec conventions --list
```

Each break shows the file, the line, the rule and the fix. In GitHub Actions, the check also writes an annotation on the line of each break. It also writes a table of the rules to the summary of the run (`GITHUB_STEP_SUMMARY`). The exit code is 1 when a rule has a break.

`conventions fix` writes the fixes that the rules know, and checks again. It continues until no fix applies. Each fix is an exact change of a file, and the fix writes it only when the file did not change after the check. These breaks have a fix:

- `runner-budget`: the minute of a schedule, a `max-parallel` of a matrix, and a concurrency group at the top of a workflow. A new run of a pull request stops the old run. A run of another event waits for the old run.
- `main-runs-finish`: a `cancel-in-progress: true` or a concurrency group that ends with `${{ github.ref }}`, in a workflow that starts on `push` or on `workflow_call`. The fix writes `${{ github.event_name == 'pull_request' }}` and `${{ github.event_name == 'pull_request' && github.ref || github.sha }}`.
- `push-main-only`: a workflow that starts on `push` and on `pull_request`, with no limit of `push` to the default branch or with no `workflow_dispatch`. The fix adds `branches` and `workflow_dispatch`, and keeps the comments and each other trigger. It keeps a tag run when the workflow reads the tag. It does not edit `release.yml`, and a person chooses the change for `branches-ignore` or for another named branch.
- `pipe-fails`: a step with a pipe and no `pipefail`. The fix adds `defaults: { run: { shell: bash } }` to the workflow. It does not write over another shell.
- `gate-after-cancel`: a summary job of a gate with `always()` in its condition. The fix writes `if: ${{ !cancelled() }}`. A condition with other parts needs a person.
- `security-one-job`: a job that uses the shared workflow `reusable-security.yml`, with its summary job `Security OK`. The fix writes one job `Security OK` that runs the action `security-scan`, with the same inputs and time limit. The pin is the first commit of the template with the action, and Renovate moves it. Another summary job, another job that needs the scans or an input of more than one line needs a person.
- `tests-required`: the option `passWithNoTests` in a config or a script, in a package with test files. A package with no tests needs a person, who removes its test script.
- `typed-files`: a config file at the root of a package (`vitest.config.ts`). The fix adds `*.config.ts` and `rootDir: "."` to the `tsconfig.test.json` of the package, when that file has no comments.
- `trust-policy`: the settings `trustPolicy`, `trustPolicyIgnoreAfter` and `trustPolicyExclude` of `pnpm-workspace.yaml`. The fix makes the file when the repository has none.
- `main-check`: a compare of `process.argv[1]` with the path of the script. The fix writes `import.meta.main` when each Node version of `engines.node` has it (`^22.18`, `>=24.2`). Else it writes a compare of the two real paths, and it adds the imports. It removes the imports that only the old compare used.
- `gate-trigger`: a path filter on the pull request trigger of a gate. The fix removes the filter and adds a job `changes` with the same patterns. Each other job needs it and has an `if` on its match. A summary job `<Name> OK` with the action `gate-summary` needs each job. A job with its own `if`, and each job that needs such a job, can be skipped (`allow-skip`). Some workflows need a person, because the fix cannot convert them with certainty. Examples are a trigger in the flow form, an `if` of more than one line, and a job `changes` that already exists.

The text output marks each break that has a fix. In the JSON output, such a break has `fixable: true`. The release train starts `conventions fix` in its update pull requests. Thus a break that a script can fix does not block a repository.

## Rules

The rules come from the invariants audit of 2026-10-26 (strategy item s38). The audit read the rule documents of 7 repositories. Each rule here is a convention that 3 or more repositories tell, and that a script examines exactly. The column "From" gives the repository and the id of each audit row.

| Rule | What it examines | From |
|---|---|---|
| `pinned-git-deps` | A dependency from git (`github:`, `git+https:`, `owner/repo`) names a full commit SHA. The rule also examines `overrides`, `resolutions` and `pnpm.overrides`. | coeval `pinned-deps`, `unpublished-dep-pinned`. headroom `non-npm-deps-pinned`, `pinned-github-specifier`. private `github-dep-full-sha`, `github-dep-pinned`. client `general-npm-version`. |
| `workspace-protocol` | A dependency on a package of the workspace uses `workspace:`. The rule does not examine peer dependencies. | client `workspace-protocol`, `workspace-deps`. coeval `pinned-deps`. headroom `non-npm-deps-pinned`. crawler `mcp-workspace-dep`. |
| `trust-policy` | A repository with a `pnpm-lock.yaml` sets `trustPolicy: no-downgrade` in `pnpm-workspace.yaml`: pnpm refuses a version with less trust evidence than an earlier version, for example one with no provenance after versions from a trusted publisher. `trustPolicyIgnoreAfter` is 10080 or more, so the check examines the versions of the last 7 days. A stolen-token version is new, and older versions can have less evidence for other reasons. `trustPolicyExclude` has the scopes of the release train, which checks the provenance of their versions itself. | private `trust-policy` (STRATEGY.md, 2026-11-01). |
| `source-main` | The `main` of each workspace package is `src/index.ts` (a package with only a `bin` has no `main`, and a private package with no entry is an app). A public package that has a source entry has the same field in `publishConfig`, and that field points at the build. | coeval `package-main-source`, `source-package-main`. crawler `pkg-source-main`, `source-package-main`, `publish-config-build`. private `new-package-main-index`, `source-package-main`. headroom `source-package-main`. |
| `tsconfig-test` | Each package with a `tsconfig.json` has a `tsconfig.test.json`, and its `typecheck` script names it. | coeval, crawler, Vex `package-tsconfig-test` or `pkg-tsconfig-test`, and `tsconfig-test`. headroom `tsconfig-test`, `tsconfig-test-per-package`. |
| `cue-preset` | The `tsconfig.json` of each package extends a preset of `@mark1russell7/cue`. No config of a package turns off a strict option that its preset turns on. `erasableSyntaxOnly` is one of these options, because `node` cannot strip the other syntax. | client `cue-config`, `no-manual-tsconfig`. private `cue-preset-strict`, `strict-preset`, `new-package-via-cli`. coeval, crawler, headroom, Vex `package-scaffold`. |
| `required-scripts` | The root `package.json` has the script `typecheck`. It also has `lint:ste` when the repository uses `ste-lint`: a dependency on `@mark1russell7/ste-lint`, or a `ste.config.json` at the root. The shared CI skips a missing script, so a removed script turns its check off with no sign. | client, coeval, crawler, private, headroom, Vex `ste-prose`. systems `lint-ste-in-ci`. coeval, crawler, headroom, Vex `tsconfig-test`. |
| `no-build-output` | Git keeps no file in a folder named `dist` or `build`. | client `no-build-output`, `no-dist`, `no-dist-commit`. Only one repository of the audit tells this rule. The `.gitignore` of the template has it for each repository. |
| `no-local-paths` | No tracked file has the home folder of a user: `C:\Users\<name>`, `/Users/<name>` or `/home/<name>`. A CI user (`runner`), a name of one character and a placeholder (`<you>`) are not a break. The commit messages of the change (a pull request, or `--base`) and the title and the body of the pull request do not have one either. The same is true for each pattern of the option `patterns` and of the environment variable `CONVENTIONS_PRIVATE_PATTERNS`. A break of a private pattern shows only the line of the pattern in the variable, not the text. A line of the variable that is not a valid regular expression is a break of its own. | client `I12`. systems `no-identifying-names`, `no-private-identifiers`, `no-private-names`. coeval `no-private-names`. |
| `release-files` | A pull request changes `.github/workflows/release.yml` or `scripts/release/` only with a line `Release-Edit: <reason>` in a commit message or in the body of the pull request. The commits of the release bot (the sync of the template) need no reason. | coeval `no-release-edit`, `no-release-edits`. crawler `no-release-edit`, `no-release-edits`. headroom `no-release-edits`, `release-files-frozen`. |
| `unreleased-change` | A change does not set a version that npm has: the release skips such a version. The rule compares the version of the head of the change with the version of its merge base, so a version that only the base branch changed does not count. A repository where each pull request sets its version sets the option `versionEachChange`. Then a change of the shipped files also raises the version, when npm has that version already. The files that ship are the files of the folder of the package, without the tests, the fixtures, the Markdown files and the configs (the option `unshipped`). When git tracks each entry of the field `files`, only those entries ship. A change of `package.json` ships when a field of the option `fields` changes, for example `exports`, but not the dependencies. On a push to the default branch, a version that the push sets breaks only when npm had it before the push. The release of the same push can publish it. An error of the registry makes the rule show `skip`. A repository with `.changeset/config.json`, a private package and a version `0.0.0` or `0.0.0-<stage>` are not examined. | rigor #18 and #20 (2026-11-02): two pull requests set the same version, and the second change did not get to npm. crawler, coeval, template `release.yml`. |
| `version-title` | A merge whose title names a version sets a version in a `package.json`. A title names a version in parentheses at its end, for example `(0.3.3)` before the `(#212)` of a squash, or after `Release` at its start. On a push to the default branch, the rule examines each commit of the first-parent line against its first parent. On a pull request, it reads the title of the event file and examines the merge commit against the base. A title with no version passes. A title that names an other version than the version that the merge sets also passes, because the change gets a release. | template #212 (`5933b34`) and #215 (`e077054`), 2026-11-06: both set `site-pages` 0.3.3, so the squash of #215 changed no `package.json`, and no release started. Template #162 and #164 (2026-11-04) did the same with 0.2.5. crawler, coeval `release.yml`. |
| `published-minor` | A consumer does not stay behind the newest published minor of a package that the option `packages` names. The rule compares each range, and each version of `pnpm-lock.yaml`, with the tag `latest` of npm. A caret range of a `0.x` version cannot reach the next minor. With no `packages`, the rule does not start. | a consumer that stayed behind a published minor |
| `changelog-version` | The top version section of the changelog of a package (`CHANGELOG.md` in its folder) is not above the version of its `package.json`. A section "Unreleased" does not count. With the option `everyVersion`, the top section is the same version. On 2026-11-03 a pull request added the section 0.5.0 with two breaking changes and left `package.json` at 0.4.1. A change of a dependency range then made the train plan the PATCH 0.4.2. | packing #249 and #253, release-train (2026-11-03). |
| `typed-scripts` | Git keeps no JavaScript source (`.js`, `.mjs`, `.cjs`, `.jsx`, or a file with a `#!` line of `node`) and no shell script (`.sh`, `.bash`, `.zsh`, `.ps1`, or a `#!` line of a shell) of more than one line of code. Each script is TypeScript, which Node 22.18 and later starts directly. A file that must stay (generated output, vendored code, a configuration that a tool reads only as JavaScript) goes in `ignore` with its reason, so the list of exceptions can only get shorter. | private `typed-everything` (STRATEGY.md, direction 15). |
| `typed-files` | Each TypeScript file that git keeps (`.ts`, `.tsx`, `.mts`, `.cts`, not `.d.ts`) is in the program of a tsconfig that a `typecheck` script names: the tests, the e2e specs, the scripts, the benches and the configs too. The rule reads the configs of each `tsc`, `tsgo` or `vue-tsc` (`-p`, `--project`, `-b`, or `tsconfig.json`) and of `svelte-check --tsconfig`, follows their `references`, and lists the files with `tsc --listFilesOnly`. A file that a covered file imports is covered. A config that does not exist, and a repository where no typecheck names a config, are a break. | private `fail-closed` (STRATEGY.md, 2026-10-30). |
| `main-check` | No script finds out that it is the main module by a compare of `process.argv[1]` with its own path. Through a link (for example `~/git` to `D:/git`), the two paths differ: the script does nothing, and it ends with exit code 0. A script uses `import.meta.main`, or `realpathSync` on each side. | private `main-check` (STRATEGY.md, 2026-11-02). |
| `tests-required` | No test runner passes when it finds no test: no `passWithNoTests: true` in a config of vitest, vite, jest or Playwright, and no `--passWithNoTests` in `package.json`. With the option, a broken include pattern turns the test gate green with no test run. | private `fail-closed` (STRATEGY.md, 2026-10-30). |
| `roadmap-parses` | Each call of the Pages workflow of the template (`reusable-pages.yml`) gives a `roadmap`, or `site-pages: false`. Without it, the Status page shows no item of the plan. Each roadmap that a workflow gives to the Status page (a `roadmap:` key) parses as `@mark1russell7/site-pages` reads it. The rule uses the parser of site-pages. Thus a pull request finds a bad row, and the Pages job on `main` does not stop on it. | private `fail-closed` (STRATEGY.md, 2026-10-30). |
| `workflow-parses` | Each workflow of `.github/workflows` and each file `action.yml` of `.github/actions` parses as YAML, with the parser of the package `yaml`. GitHub refuses a workflow that does not parse, and starts no job. A workflow that starts only on a schedule, a dispatch or `workflow_run` does not start on its pull request. So the rule finds its fault before the merge. The break names the first fault of each file. | layout-contract `memory-probe.yml`, run 42172612147 (2026-11-06). |
| `runner-budget` | All repositories of the account share 40 runners. Each `strategy` with a `matrix` has a `max-parallel` of 3 or less. Each workflow has a concurrency group at the top or in each job. A job that calls a shared workflow of the option `grouped` gets its group from that workflow, and each job of that workflow has a group. The minute of each `cron` comes from a hash of the repository and the file (1 to 59), so the schedules of the repositories do not start together. The repository comes from `GITHUB_REPOSITORY` or from the remote `origin`. | private `runner-slots` (STRATEGY.md, 2026-10-30). |
| `main-runs-finish` | A workflow that starts on `push` or on `workflow_call` does not cancel a run in progress. A called workflow gets the event of its caller. A newer push cancels only the run of a pull request: `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`. Each commit of `main` has its own concurrency group: `${{ github.event_name == 'pull_request' && github.ref || github.sha }}`. In one group, GitHub cancels a run that waits when a newer run comes, whatever `cancel-in-progress` says. On 2026-11-03 four waiting CI runs of `main` in client were cancelled, so its version commit had no result and no release. On 2026-11-03 the next merge cancelled the CI run of a commit on `main`, so the main check of that commit had no result. A bench run on `main` was cancelled too, and its claim had no measurement. | private `main-runs-finish` (STRATEGY.md, 2026-11-03). |
| `push-main-only` | A workflow that starts on `push` and on `pull_request` limits `push` to the default branch with `branches`, and has `workflow_dispatch`. Without the limit, each commit of a pull request starts two runs. A `push` with only a tag filter, a `pull_request` with `types` that do not have `synchronize`, and `pull_request_target` are not breaks. `CI.md` tells each case in "One run for each commit". |
| `pipe-fails` | A failure on the left of a pipe fails its step. With no `shell` key, GitHub has no `pipefail`, so `tests \| tee out.txt` passes when the tests fail. The fix adds `shell: bash` as the default of the workflow. A step that then turns red had a failure that the pipe hid. |
| `gate-after-cancel` | A summary job of a gate has the condition `if: ${{ !cancelled() }}`, not `always()`. After a cancel, a job with `always()` asks for a runner, and the new run waits behind it. A job with `!cancelled()` concludes `cancelled` with no runner, and the pull request stays blocked. |
| `security-one-job` | The security scans run in one job, the check `Security OK`, with the action `security-scan` of the template. The shared workflow `reusable-security.yml` gives three scan jobs, and its caller adds a summary job. Each job asks for its own runner, so in a full queue a run waits for four runners. On 2026-11-06 each scan job of one repository waited 23 to 40 minutes. |
| `service-run-main` | In a server package, only the entry `src/main.ts` starts the service with `run()`. A server package has a dependency on `@mark1russell7/service` and a file `src/main.ts`, as the preset `service` writes it. A source file that imports the service package and starts `run()` is a break. `run()` owns the process, so a module that starts it cannot be imported by a test. |
| `shared-ci` | The workflow `ci.yml` calls the shared workflow `reusable-ci.yml` of the template, and no workflow or action of the repository has the name of a shared one of the template. A `ci.yml` with its own steps, or a local copy, does not get the fixes and the new checks of the template. The template itself is not examined (option `home`). On 2026-11-07, 3 of 19 repositories of the account ran CI steps of their own. |
| `setup-cue` | No workflow or action installs the cue CLI with its own command (a download of a release asset of `cue-lang/cue`, or `go install`). A caller of `reusable-ci.yml` gives the input `cue-version`. Another job uses the action `setup-cue` of the template. The action installs the CLI from a cache, or with retries and a sha256 check. On 2026-11-08, a 504 of GitHub failed each bare `curl` of the CLI. |
| `gate-trigger` | No workflow has `paths` or `paths-ignore` on `on.pull_request` or `on.pull_request_target`. The ruleset needs the summary check `<Name> OK` of each gate, and a workflow with a path filter does not start on each pull request. Then its check is not there, the ruleset cannot ask for it, and a pull request can merge before the gate ends. A gate uses the actions `changes` and `gate-summary` of the template (`CI.md`, "A gate with paths"). | private `gate-trigger` (STRATEGY.md, 2026-11-02). |
| `license-file` | Each public package has a license field, and a license file with the same license in its own folder. A public repository, or a repository with a public package, has a license file at its root. In a GitHub Actions run, the event file tells if the repository is public, and the option `license` (MIT by default) is the license of a root with no public package. npm packs only the license file of the folder of the package, and GitHub reads only the one of the root: on 2026-11-02 five public repositories showed no license on GitHub while npm said MIT. `conventions fix` writes the missing files. | private strategy (2026-11-02). |
| `home-package` | A change does not add a function with a signature name of another home of the map (for example `median`, `mulberry32` or `writeFileAtomic`). A local copy drifts from the home and splits the fixes. On 2026-11-02 the repositories had 68 local statistics functions in 14 repositories. The rule examines only the lines that the change adds, so the copies that exist do not break. | private direction 18 (STRATEGY.md, 2026-11-02). |
| `pages-site` | A public repository has a workflow that calls the Pages workflow of the template (`mark1russell7/template/.github/workflows/reusable-pages.yml`, any ref), and the call deploys. A call with `deploy: false` makes a test site only. In a GitHub Actions run, the event file tells if the repository is public. Outside a run, the rule shows `skip`. On 2026-11-02 eight public repositories had no site with a Releases page and a Status page. | vex, crawler, client, coeval `pages.yml`. |
| `site-check-in-ci` | A repository that deploys a site with the Pages workflow has `.github/site.json`. The call of the deploy gives no site input, and no pull request starts the deploy, directly or through a call. A job that uses `reusable-pages-check.yml` checks the site, and "CI OK" needs that job. Thus the check of a pull request builds the site that `main` deploys, and a bad site does not merge. | template `ci.yml` (job `site`). |
| `pages-after-release` | A repository with a public package and a release workflow starts its Pages workflow after a release and on each day. `conventions fix` writes the triggers. A workflow with its own deploy steps needs a person. |
| `shared-docs` | Each lock file `shared.lock.json` names a document in its field `file`. Each shared block of the document (`<!-- shared:<id> -->` to `<!-- /shared:<id> -->`) has the SHA-256 that the lock gives, and the lock has each block. A linked block has its home in another repository. Its lock entry gives `{repo, path, commit, sha256}`, with a full commit. The document has a `<!-- linked:<id> -->` block with the link to the home at that commit, and no copy. In CI, the rule downloads each home and compares the hash. A home that does not answer in 30 seconds is a break. On 2026-11-03 three repositories kept copies of a block whose home in rigor had a different hash. | layout-contract `scripts/check-shared.mjs` (#155). |

The rule `release-files` needs the base of the change. On a pull request, the checkout is a merge commit, and the rule reads its two parents (`fetch-depth` 2 or more). In other runs, give `--base <ref>`. Without a base, the rule shows `skip`. The rule also needs each commit of the change. A shallow checkout can end inside the change. Then the authors and the messages that the rule reads are not those of the change, so the rule shows `error`. A pull request of one commit is complete at depth 2. For a longer one, the CI of the template deepens the checkout to the merge base.

The rule `unreleased-change` also needs the base of the change and its merge base. The CI of the template deepens the checkout of each pull request to the merge base. Without it, the rule shows `skip`. The rule also reads a push to the default branch: the event file gives the commit before the push and the time of the push. With `versionEachChange`, two pull requests that set the same version break only on the push. The check of the second pull request passed before the first release.

A repository that collects changes and raises the version in a separate pull request keeps the default. Each pull request can then change the code with no version change.

## Configuration

The field `conventions` of the root `package.json` sets the rules. An exception or a changed option needs a reason:

```json
{
  "conventions": {
    "rules": {
      "no-build-output": { "off": "git installs of this package need dist/" },
      "cue-preset": { "ignore": ["packages/web/**"], "reason": "packages/web keeps TypeScript 6 and its own config" },
      "workspace-protocol": { "prefix": "workspace:*", "reason": "each dependency of the workspace is exact" }
    }
  }
}
```

| Field | What it sets |
|---|---|
| `rules.<id>.off` | The rule does not start. The text is the reason, and the output shows it. |
| `rules.<id>.ignore` | The globs of the files whose breaks the rule does not report. It needs `reason`. On a pull request or with `--base`, a file that the change adds is not ignored: `ignore` keeps only the exceptions that exist. A renamed file is not added. An entry that matches no break of its rule is a break, so the list does not keep converted files. |
| `rules.<id>.generated` | The globs of build output whose breaks the rule does not report, for example `dist/**` in a repository that keeps `dist/` in git. It needs `reason`. A build adds a file there for each new source file, so `generated` also covers a file that the change adds. An entry that matches no break of its rule is a break. |
| `rules.<id>.reason` | The reason of `ignore`, of `generated` or of a changed option. |
| `rules.<id>.<option>` | An option of the rule. It needs `reason`, because a changed option can make a rule weaker. `conventions --list` shows the options and their values. |
| `packages` | The globs of the package folders. The default is the `packages` list of `pnpm-workspace.yaml`. |

An unknown rule, an unknown option, or an exception or a changed option without a reason is an error. Thus a typing error or a quiet change does not make a rule weaker.

| Option | Default | What it sets |
|---|---|---|
| `pinned-git-deps.fullSha` | `true` | When `false`, a short SHA is also a commit. |
| `workspace-protocol.prefix` | `workspace:` | The start of each specifier. |
| `source-main.main` | `src/index.ts` | The path of `main`. |
| `source-main.publishConfig` | `true` | When `false`, the rule does not examine `publishConfig`. |
| `tsconfig-test.file` | `tsconfig.test.json` | The name of the config of the tests. |
| `cue-preset.prefix` | `@mark1russell7/cue/` | The start of the `extends` path of a preset. |
| `required-scripts.scripts` | `["typecheck"]` | The scripts of the root `package.json`. |
| `required-scripts.steScripts` | `["lint:ste"]` | The scripts of the root `package.json` when the repository uses `ste-lint`. |
| `no-build-output.folders` | `["dist", "build"]` | The names of the folders of build output. |
| `no-local-paths.allow` | `[]` | More user names that are not a break. |
| `no-local-paths.patterns` | `[]` | More regular expressions of text that no file has. The environment variable `CONVENTIONS_PRIVATE_PATTERNS` adds one on each line, so a private name stays out of `package.json`. The shared CI gives the variable from the secret of the same name. |
| `release-files.paths` | `[".github/workflows/release.yml", "scripts/release/**"]` | The globs of the files of the release flow. |
| `release-files.trailer` | `Release-Edit` | The key of the line that gives the reason. |
| `release-files.authors` | `["mark1russell7-release-train[bot]"]` | The authors of the release flow. Their commits need no reason. |
| `unreleased-change.versionEachChange` | `false` | When `true`, each change of the shipped files raises the version. Set it when each pull request sets its version. |
| `unreleased-change.unshipped` | tests, fixtures, Markdown, configs, `docs/`, `scripts/` and dot folders | With `versionEachChange`: the globs of the files of a package, relative to its folder, that do not ship. `conventions --list` shows the full list. |
| `unreleased-change.fields` | `main`, `exports`, `bin`, `files`, `publishConfig` and more | With `versionEachChange`: the fields of `package.json` whose change ships. |
| `unreleased-change.registry` | `https://registry.npmjs.org` | The URL of the registry that has the versions. |
| `published-minor.packages` | `[]` | The patterns of the package names that the rule examines, for example `@scope/*`. |
| `published-minor.graceDays` | `0` | The days that a consumer has, from the first publish of a minor that it does not have. |
| `published-minor.registry` | `https://registry.npmjs.org` | The URL of the registry that has the versions. |
| `changelog-version.file` | `CHANGELOG.md` | The name of the changelog in the folder of each package. |
| `changelog-version.everyVersion` | `false` | When `true`, the top section also names the version of `package.json`, so each version has its section. |
| `typed-scripts.javascript` | `[".js", ".mjs", ".cjs", ".jsx"]` | The extensions of JavaScript source. |
| `typed-scripts.shell` | `[".sh", ".bash", ".zsh", ".ps1"]` | The extensions of shell scripts. |
| `typed-scripts.shellLines` | `1` | The most lines of code of a shell script (a launcher). Empty lines and comments do not count. |
| `typed-files.configs` | `[]` | More tsconfig files, relative to the root, that CI examines with another command (for example a script that the typecheck starts). |
| `roadmap-parses.roadmaps` | `[]` | More roadmap files, relative to the root, for a roadmap that no workflow names. |
| `trust-policy.exclude` | `["@mark1russell7/*", "@procedures/*"]` | The patterns that `trustPolicyExclude` must have. |
| `trust-policy.ignoreAfter` | `10080` | The smallest `trustPolicyIgnoreAfter`, in minutes. |
| `runner-budget.maxParallel` | `3` | The largest `max-parallel` of a matrix. |
| `runner-budget.minute` | `true` | When `false`, the rule does not examine the minute of the schedules. |
| `runner-budget.grouped` | `["reusable-ai-review.yml", "reusable-codex-review.yml"]` | The shared workflows that give a concurrency group in each of their jobs. |
| `gate-trigger.allow` | `[]` | The file names of the workflows that can filter pull requests by path, because they are not a gate (for example a preview). |
| `push-main-only.branches` | `[]` | More branches that `on.push.branches` can name, for example a long-lived release branch. |
| `home-package.scope` | `"change"` | `"change"`: only the lines that a pull request or `--base` adds. `"all"`: each line of each tracked file, for a sweep of the copies that exist. |
| `shared-docs.locks` | `[]` | The lock files to check. With no value, the rule checks each tracked file `shared.lock.json`. |
| `shared-docs.remote` | `"ci"` | When the rule downloads the homes of the linked blocks: `"ci"` (only when `CI` is `"true"`), `"always"` or `"never"`. |

## Commands

| Option | What it sets |
|---|---|
| `check` | Start each rule. |
| `fix` | Write the fixes of the breaks that have one, and check again. The exit code is 1 when a break stays. |
| `--list` | Show each rule: the reason, the fix, the options, the state and the audit rows. |
| `--root <folder>` | The root of the repository. The default is the current folder. |
| `--rule <id>` | Only this rule. Use it again for more rules. |
| `--base <ref>` | The base commit of the change, for the rules `release-files`, `home-package` and `unreleased-change`. Outside CI, the default is the default branch of origin, so a local check examines the same added lines as the check of the pull request. |
| `--no-base` | Do not use that default. |
| `--json` | Write the result as JSON. |
| `pre-push <remote> [<url>]` | Examine the new commits of a push with the private name list. The git hook `pre-push` starts it. |
| `hook install` | Write the git hook `pre-push`. In CI, or outside a git repository, the command does nothing. |

## The private name list and the hook `pre-push`

A private name must not get into a public repository. The private names are in a private name list, outside of the public repositories. The git hook `pre-push` examines each push with that list, on the computer of the push.

Set the path of the list one time on each computer:

```sh
git config --global conventions.privateNamesFile ~/private/private-names.json
```

The environment variable `CONVENTIONS_PRIVATE_NAMES_FILE` has priority over the git configuration.

The list is a JSON file. The schema [`schema/private-names.schema.json`](schema/private-names.schema.json) tells its fields, and the package has the schema. This example has made-up names:

```json
{
  "$comment": "The names of private projects.",
  "names": [
    { "id": "acme-app", "project": "The Acme app", "seeds": ["acme-app", "Acme"], "patterns": ["\\bacme-app\\b"], "word": "Acme", "commonAfter": ["corp"] }
  ],
  "allow": [{ "repo": "site", "path": "docs/history.md", "name": "acme-app", "why": "The page tells the history of the name." }]
}
```

- `seeds`: the fixed texts of a name, with case. A line with no seed of the list is no hit. Thus each text that a pattern or the word finds must contain a seed.
- `patterns`: JavaScript regular expressions with no flags. A match in a line or in a path is a hit.
- `word`: a word that is also a common word. A match of the whole word is a hit only in a sentence that names the project. The word in code, in a title, after an article or before a noun is no hit.
- `commonAfter`: the words that make `word` a common word when they come next. In the example, `Acme corp` is no hit, but `the Acme team` is a hit.
- `allow`: the hits that a person examined. An entry permits the name `name` (each name, with no `name`) in the file `path` of the repository `repo`. The command gets the repository from the URL of the remote.

A line has one break or no break of the list: the first name of the line counts. A path of a file has a break only for a pattern.

Install the hook:

```sh
pnpm exec conventions hook install
```

A repository adds `"prepare": "conventions hook install"` to its root `package.json` in the change that raises `@mark1russell7/conventions` to `^0.37.1`. Then `pnpm install` installs the hook. The command writes `pre-push` in the hooks folder of git. It uses the folder of `core.hooksPath`, and it also works in a worktree. It keeps a hook `pre-push` that it did not write, and it shows a warning. In CI, the command does nothing.

All worktrees of a repository use one hook file, but each worktree has its own `node_modules`. A worktree of an older branch can have a conventions before 0.37.1, which has no `pre-push` command. The hook starts the conventions of the worktree only when its version is 0.37.1 or later. Otherwise the hook starts the version that wrote it, with `pnpm dlx`. When no conventions can start, the push stops.

Before each push, the hook starts `conventions pre-push`. The command examines each new commit of the push. A commit is new when no branch of the remote has it. The command examines these texts of each new commit:

- the commit message.
- each path that the commit adds or changes.
- each line that the commit adds.

The command also examines the home folders of users, with the settings of the rule `no-local-paths` in `package.json`. The environment variable `CONVENTIONS_PRIVATE_PATTERNS` adds one regular expression on each line, as in the rule. A break stops the push with the exit code 1.

A break shows the commit, the place and the index of the name in the list. An example is `commit 0123456789ab notes.md:2  A text names name 1 of the private name list.` A break does not show the text, the id, the project or the pattern, because the id is the private name. A break of a path does not show the path.

When no list and no pattern is set, the command writes one line that starts with `conventions pre-push: No read`, and the push continues. A push with no read is not a pass. The push stops when the command cannot read the list that a setting names. It also stops when the list is not JSON, does not agree with the schema, or has a bad regular expression. The line of the stop gives the reason and the index of the entry, not its values.

The check of CI continues to read the environment variable `CONVENTIONS_PRIVATE_PATTERNS` in the rule `no-local-paths`.

## The map of homes

The map gives the home package of each area of code: statistics, seeded random, exact arithmetic, geometry, text, servers, files and commands, tests and more. Before you write a helper, find its home. If the home does not have the function, add the function to the home. Do not make a local copy or a new package.

```sh
conventions map                  # each area and its home
conventions map seeded random    # the areas that match the words
conventions map --markdown       # the table with the rule, for a CLAUDE.md
conventions map --overlay homes.json --markdown   # with more homes from a JSON file
```

Each home can give `signatures`: the names of functions that only the home has, as regular expressions of a whole name. The rule `home-package` breaks on a new function with such a name in another repository. Its message says if the home already exports the name. The index of the exports is `src/home-exports.ts`. The script `scripts/homes/exports.ts` of the template writes it from the latest version of each home on npm.

An overlay file has the shape `{ "homes": [...] }`. A home of the overlay takes the place of the home with the same area. The private repositories use an overlay, because the public map names only public packages.

## Add a rule

A rule is a module in `src/rules/` that exports a `Rule`. A `Rule` has an `id`, a `title`, a `reason`, a `fix` and its audit `sources`. It also has its `options` with defaults, and a function `check(context, options)`. The function gives a list of breaks, or `{ skipped: "<reason>" }`. 

A break can have `edits`: each edit gives a file, its whole text `before` and its whole text `after`. Give an edit only when the fix is certain, and test it with `runFix`. Add the rule to `RULES` in `src/rules/index.ts`, with a test of a case that passes and a case that breaks. Add a rule only when 3 or more repositories tell it and a script examines it exactly.

## Library

The package also exports the functions of the tool:

- `runChecks(options)` starts the rules and gives the result of each rule. `runFix(options)` writes the edits and gives the changed files and the last result. `runCli(args, io)` is the bin.
- `replaceLine(text, line, lines)` gives the text with one line replaced, for the edits of a rule.
- `formatResult(result)`, `summaryMarkdown(result)`, `annotations(result)` and `listRules(config)` give the output.
- `parseConfig(value, rules)` and `readConfig(root)` read the field `conventions`.
- `HOMES` is the map of homes. `findHomes(query)` finds the homes of words, and `mapMarkdown(homes)` and `mapText(homes)` write them. `readOverlay(file)` and `mergeHomes(base, extra)` add more homes.
- `tagName(name, version, packageCount)` gives the git tag of a version. `releaseNotes(name, version, changelog)` gives the text of its GitHub release, with `changelogSection`, `npmUrl` and `MAX_NOTES`. The script `scripts/release/tags.ts` keeps the same rule, and a test compares the two.
- `RULES` and each rule, with the helpers `isGitSpecifier`, `isPinned`, `isSourcePath` and `parseJsonc`.
- `packageFolders(root, globs)`, `globFolders(root, glob)`, `globToRegExp(glob)` and `workspaceGlobs(root)` find the package folders of a repository.
- The subpath `@mark1russell7/conventions/workspace` gives these four functions and `reportFolders(root, globs)`, and no other code. `reportFolders` adds a public root that the globs leave out. `@mark1russell7/api-report` imports them from this subpath.
- `privateTextBreaks(name, text, privates, options)` gives the breaks of one text. The rule `no-local-paths` and the command `pre-push` use it. `privates` has the list (`names`) and the patterns (`patterns`).
- `parsePrivateNames(text)` parses and checks a private name list. It throws a `PrivateNameListError` with a reason that shows no value of the list.
- `lineNameHit(list, line, place)`, `pathNameHit(list, path)`, `firstNameMatch(line, names)`, `isCommonUse(line, index, rule)` and `isAllowedHit(allow, repo, path, id)` find the names of the list. They have no input or output.
- `lineNameHits(list, line, place)` and `nameMatches(line, names)` give each name of a line, one hit for each name. A scan that counts the names uses them. The gate takes the first hit.
- `privateNamesFile(env, git)`, `privatePatterns(env)` and `invalidPatternBreaks(patterns)` read the settings and the patterns.
- `prePush(options, io)` is the command `pre-push`, and `installHook(options, io)` is the command `hook install`. `PRE_PUSH_HOOK` is the text of the hook.
