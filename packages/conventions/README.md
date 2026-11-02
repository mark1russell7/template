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
- `tests-required`: the option `passWithNoTests` in a config or a script, in a package with test files. A package with no tests needs a person, who removes its test script.
- `typed-files`: a config file at the root of a package (`vitest.config.ts`). The fix adds `*.config.ts` and `rootDir: "."` to the `tsconfig.test.json` of the package, when that file has no comments.
- `trust-policy`: the settings `trustPolicy`, `trustPolicyIgnoreAfter` and `trustPolicyExclude` of `pnpm-workspace.yaml`. The fix makes the file when the repository has none.
- `main-check`: a compare of `process.argv[1]` with the path of the script. The fix writes `import.meta.main` when each Node version of `engines.node` has it (`^22.18`, `>=24.2`). Else it writes a compare of the two real paths, and it adds the imports. It removes the imports that only the old compare used.

The text output marks each break that has a fix. In the JSON output, such a break has `fixable: true`. The release train starts `conventions fix` in its update pull requests. Thus a break that a script can fix does not block a repository.

## Rules

The rules come from the invariants audit of 2026-10-26 (strategy item s38). The audit read the rule documents of 7 repositories. Each rule here is a convention that 3 or more repositories tell, and that a script examines exactly. The column "From" gives the repository and the id of each audit row.

| Rule | What it examines | From |
|---|---|---|
| `pinned-git-deps` | A dependency from git (`github:`, `git+https:`, `owner/repo`) names a full commit SHA. The rule also examines `overrides`, `resolutions` and `pnpm.overrides`. | coeval `pinned-deps`, `unpublished-dep-pinned`. headroom `non-npm-deps-pinned`, `pinned-github-specifier`. Graph `github-dep-full-sha`, `github-dep-pinned`. client `general-npm-version`. |
| `workspace-protocol` | A dependency on a package of the workspace uses `workspace:`. The rule does not examine peer dependencies. | client `workspace-protocol`, `workspace-deps`. coeval `pinned-deps`. headroom `non-npm-deps-pinned`. crawler `mcp-workspace-dep`. |
| `trust-policy` | A repository with a `pnpm-lock.yaml` sets `trustPolicy: no-downgrade` in `pnpm-workspace.yaml`: pnpm refuses a version with less trust evidence than an earlier version, for example one with no provenance after versions from a trusted publisher. `trustPolicyIgnoreAfter` is 10080 or more, so the check examines the versions of the last 7 days. A stolen-token version is new, and older versions can have less evidence for other reasons. `trustPolicyExclude` has the scopes of the release train, which checks the provenance of their versions itself. | fleet `trust-policy` (STRATEGY.md, 2026-11-01). |
| `source-main` | The `main` of each workspace package is `src/index.ts` (a package with only a `bin` has no `main`, and a private package with no entry is an app). A public package that has a source entry has the same field in `publishConfig`, and that field points at the build. | coeval `package-main-source`, `source-package-main`. crawler `pkg-source-main`, `source-package-main`, `publish-config-build`. Graph `new-package-main-index`, `source-package-main`. headroom `source-package-main`. |
| `tsconfig-test` | Each package with a `tsconfig.json` has a `tsconfig.test.json`, and its `typecheck` script names it. | coeval, crawler, Vex `package-tsconfig-test` or `pkg-tsconfig-test`, and `tsconfig-test`. headroom `tsconfig-test`, `tsconfig-test-per-package`. |
| `cue-preset` | The `tsconfig.json` of each package extends a preset of `@mark1russell7/cue`. No config of a package turns off a strict option that its preset turns on. | client `cue-config`, `no-manual-tsconfig`. Graph `cue-preset-strict`, `strict-preset`, `new-package-via-cli`. coeval, crawler, headroom, Vex `package-scaffold`. |
| `required-scripts` | The root `package.json` has the script `typecheck`. It also has `lint:ste` when the repository uses `ste-lint`: a dependency on `@mark1russell7/ste-lint`, or a `ste.config.json` at the root. The shared CI skips a missing script, so a removed script turns its check off with no sign. | client, coeval, crawler, Graph, headroom, Vex `ste-prose`. systems `lint-ste-in-ci`. coeval, crawler, headroom, Vex `tsconfig-test`. |
| `no-build-output` | Git keeps no file in a folder named `dist` or `build`. | client `no-build-output`, `no-dist`, `no-dist-commit`. Only one repository of the audit tells this rule. The `.gitignore` of the template has it for each repository. |
| `no-local-paths` | No tracked file has the home folder of a user: `C:\Users\<name>`, `/Users/<name>` or `/home/<name>`. A CI user (`runner`), a name of one character and a placeholder (`<you>`) are not a break. | client `I12`. systems `no-identifying-names`, `no-private-identifiers`, `no-private-names`. coeval `no-private-names`. |
| `release-files` | A pull request changes `.github/workflows/release.yml` or `scripts/release/` only with a line `Release-Edit: <reason>` in a commit message or in the body of the pull request. The commits of the release bot (the sync of the template) need no reason. | coeval `no-release-edit`, `no-release-edits`. crawler `no-release-edit`, `no-release-edits`. headroom `no-release-edits`, `release-files-frozen`. |
| `typed-scripts` | Git keeps no JavaScript source (`.js`, `.mjs`, `.cjs`, `.jsx`, or a file with a `#!` line of `node`) and no shell script (`.sh`, `.bash`, `.zsh`, `.ps1`, or a `#!` line of a shell) of more than one line of code. Each script is TypeScript, which Node 22.18 and later starts directly. A file that must stay (generated output, vendored code, a configuration that a tool reads only as JavaScript) goes in `ignore` with its reason, so the list of exceptions can only get shorter. | fleet `typed-everything` (STRATEGY.md, direction 15). |
| `typed-files` | Each TypeScript file that git keeps (`.ts`, `.tsx`, `.mts`, `.cts`, not `.d.ts`) is in the program of a tsconfig that a `typecheck` script names: the tests, the e2e specs, the scripts, the benches and the configs too. The rule reads the configs of each `tsc`, `tsgo` or `vue-tsc` (`-p`, `--project`, `-b`, or `tsconfig.json`) and of `svelte-check --tsconfig`, follows their `references`, and lists the files with `tsc --listFilesOnly`. A file that a covered file imports is covered. A config that does not exist, and a repository where no typecheck names a config, are a break. | fleet `fail-closed` (STRATEGY.md, 2026-10-30). |
| `main-check` | No script finds out that it is the main module by a compare of `process.argv[1]` with its own path. Through a link (for example `~/git` to `D:/git`), the two paths differ: the script does nothing, and it ends with exit code 0. A script uses `import.meta.main`, or `realpathSync` on each side. | fleet `main-check` (STRATEGY.md, 2026-11-02). |
| `tests-required` | No test runner passes when it finds no test: no `passWithNoTests: true` in a config of vitest, vite, jest or Playwright, and no `--passWithNoTests` in `package.json`. With the option, a broken include pattern turns the test gate green with no test run. | fleet `fail-closed` (STRATEGY.md, 2026-10-30). |
| `roadmap-parses` | Each call of the Pages workflow of the template (`reusable-pages.yml`) gives a `roadmap`, or `site-pages: false`. Without it, the Status page shows no item of the plan. Each roadmap that a workflow gives to the Status page (a `roadmap:` key) parses as `@mark1russell7/site-pages` reads it. The rule uses the parser of site-pages. Thus a pull request finds a bad row, and the Pages job on `main` does not stop on it. | fleet `fail-closed` (STRATEGY.md, 2026-10-30). |
| `runner-budget` | All repositories of the account share 40 runners. Each `strategy` with a `matrix` has a `max-parallel` of 3 or less. Each workflow has a concurrency group at the top or in each job. A job that calls a shared workflow of the option `grouped` gets its group from that workflow, and each job of that workflow has a group. The minute of each `cron` comes from a hash of the repository and the file (1 to 59), so the schedules of the repositories do not start together. The repository comes from `GITHUB_REPOSITORY` or from the remote `origin`. | fleet `runner-slots` (STRATEGY.md, 2026-10-30). |

The rule `release-files` needs the base of the change. On a pull request, the checkout is a merge commit, and the rule reads its two parents (`fetch-depth` 2 or more). In other runs, give `--base <ref>`. Without a base, the rule shows `skip`.

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
| `rules.<id>.ignore` | The globs of the files whose breaks the rule does not report. It needs `reason`. |
| `rules.<id>.reason` | The reason of `ignore` or of a changed option. |
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
| `no-local-paths.patterns` | `[]` | More regular expressions of text that no file has. The environment variable `CONVENTIONS_PRIVATE_PATTERNS` adds one on each line, so a private name stays out of `package.json`. |
| `release-files.paths` | `[".github/workflows/release.yml", "scripts/release/**"]` | The globs of the files of the release flow. |
| `release-files.trailer` | `Release-Edit` | The key of the line that gives the reason. |
| `release-files.authors` | `["mark1russell7-release-train[bot]"]` | The authors of the release flow. Their commits need no reason. |
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

## Commands

| Option | What it sets |
|---|---|
| `check` | Start each rule. |
| `fix` | Write the fixes of the breaks that have one, and check again. The exit code is 1 when a break stays. |
| `--list` | Show each rule: the reason, the fix, the options, the state and the audit rows. |
| `--root <folder>` | The root of the repository. The default is the current folder. |
| `--rule <id>` | Only this rule. Use it again for more rules. |
| `--base <ref>` | The base commit of the change, for the rule `release-files`. |
| `--json` | Write the result as JSON. |

## Add a rule

A rule is a module in `src/rules/` that exports a `Rule`. A `Rule` has an `id`, a `title`, a `reason`, a `fix` and its audit `sources`. It also has its `options` with defaults, and a function `check(context, options)`. The function gives a list of breaks, or `{ skipped: "<reason>" }`. 

A break can have `edits`: each edit gives a file, its whole text `before` and its whole text `after`. Give an edit only when the fix is certain, and test it with `runFix`. Add the rule to `RULES` in `src/rules/index.ts`, with a test of a case that passes and a case that breaks. Add a rule only when 3 or more repositories tell it and a script examines it exactly.

## Library

The package also exports the functions of the tool:

- `runChecks(options)` starts the rules and gives the result of each rule. `runFix(options)` writes the edits and gives the changed files and the last result. `runCli(args, io)` is the bin.
- `replaceLine(text, line, lines)` gives the text with one line replaced, for the edits of a rule.
- `formatResult(result)`, `summaryMarkdown(result)`, `annotations(result)` and `listRules(config)` give the output.
- `parseConfig(value, rules)` and `readConfig(root)` read the field `conventions`.
- `RULES` and each rule, with the helpers `isGitSpecifier`, `isPinned`, `isSourcePath` and `parseJsonc`.
