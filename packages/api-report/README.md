# @mark1russell7/api-report

This package keeps a report of the public API of each package of a workspace. The report comes from the built `.d.ts` files. A check in CI fails when a report differs from the build. Thus each change of the public API shows in the diff of the pull request.

## What a report has

Each public package has its report in `test/api/public-api.txt`. The report has these parts:

- The names of each entry of the `exports` field, with the declaration file of each name. A subpath pattern (`./*`) gives one entry for each file that it matches.
- The ambient declarations (`declare module`, `declare global`, `export as namespace`) of each file that an entry reaches.
- The commands of the `bin` field.
- The declaration of each name, without comments and without private members.

The tool reads the fields of `publishConfig` as pnpm publishes them. Thus a source package (`main` is `src/index.ts`) gets the report of its built entries. The text is the same on Windows and on Linux. A change of a comment or of a private field does not change the report.

TypeScript 7 has no stable compiler API. Thus the tool reads the declaration files as text. It knows the output of `tsc` and of `tsdown`. An unknown form of statement gives an error, not a wrong report.

## Use

Install the package:

```sh
pnpm add -D @mark1russell7/api-report
```

Add the script `"check:api": "api-report check"` to the root `package.json`. The shared CI of the template starts `check:api` after `build` (`CI.md`).

Write the reports the first time, and after each change of the API that you accept:

```sh
pnpm -r build
pnpm exec api-report update
git diff -- 'packages/*/test/api/public-api.txt'
```

Then commit the reports with the change. Put the pathspec of `git diff` in quotes, so that git and not the shell reads the `*`.

## Commands

| Command | What it does |
|---|---|
| `api-report check` | It compares each report with the built `.d.ts` files. It shows the diff of each changed report. The exit code is 1 when a report differs, is missing or has an error. |
| `api-report update` | It writes each report that is not current. It removes the report of a package that became private. |

In GitHub Actions, `check` also writes the diff to the summary of the run (`GITHUB_STEP_SUMMARY`).

| Option | What it sets |
|---|---|
| `--root <folder>` | The root of the repository. The default is the current folder. |
| `--packages <glob>` | A glob of package folders. Use it again for more globs. |
| `--report <path>` | The path of the report in each package folder. |
| `--include-private` | Each private package also gets a report. |
| `--no-publish-config` | The tool reads the fields of `package.json` without `publishConfig`. |
| `<package folder>` | Only these packages. A named private package also gets a report. |

## Configuration

The field `apiReport` of the root `package.json` sets the defaults. The options of the command replace them.

| Field | Default | What it sets |
|---|---|---|
| `packages` | the `packages` list of `pnpm-workspace.yaml`, or the `workspaces` field | The globs of the package folders. A glob that starts with `!` removes folders. |
| `report` | `test/api/public-api.txt` | The path of the report in each package folder. |
| `includePrivate` | `false` | Each private package also gets a report. |
| `publishConfig` | `true` | The fields of `publishConfig` replace the fields of the source. |
| `tool` | `api-report` | The command that the header of each report names. |

A glob knows `*` (a part of one folder name), `?`, `**` (zero or more folders) and `{a,b}`. A repository with no workspace is one package: the root.

```json
{
  "apiReport": {
    "packages": ["packages/*", "apps/*", "!packages/internal-*"]
  }
}
```

## Library

The package also exports the functions of the tool:

- `runReports(options)` compares or writes the reports, and gives the result of each package. `runCli(args, io)` is the bin.
- `packageReport(folder)` and `apiReport(name, root, entries)` give the text of one report.
- `entriesOf(manifest, folder)`, `publishedManifest(manifest)` and `binsOf(manifest)` read a `package.json`.
- `parseDeclarations(text)` and `statementsOf(text)` read a declaration file.
- `packageFolders(root, globs)`, `globFolders(root, glob)`, `globToRegExp(glob)` and `workspaceGlobs(root)` find the packages.
- `diffLines(before, after)` and `unifiedDiff(before, after)` give a line diff.
