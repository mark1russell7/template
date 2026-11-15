# @mark1russell7/api-report

This package keeps a report of the public API of each package of a workspace. The report comes from the built `.d.ts` files. A check in CI fails when a report differs from the build. Thus each change of the public API shows in the diff of the pull request.

## What a report has

Each public package has its report in `test/api/public-api.txt`. The report has these parts:

- The names of each entry of the `exports` field, with the declaration file of each name. A subpath pattern (`./*`) gives one entry for each file that it matches.
- The ambient declarations (`declare module`, `declare global`, `export as namespace`) of each file that an entry reaches.
- The files of each entry without a declaration file, for example `./tsconfig/*.json`. Thus the removal of a file changes the report.
- The commands of the `bin` field.
- The declaration of each name, without comments and without private members.

The tool reads the fields of `publishConfig` as pnpm publishes them. Thus a source package (`main` is `src/index.ts`) gets the report of its built entries. The text is the same on Windows and on Linux. A change of a comment or of a private field does not change the report.

TypeScript 7 has no stable compiler API. Thus the tool reads the declaration files as text. It knows the output of `tsc` and of `tsdown`. An unknown form of statement gives an error, not a wrong report.

### The chunks of a bundler

A bundler gives a shared chunk a hash in its name, for example `build/html-o5bDHjNi.d.mts`. The hash changes when the bundler or private code changes. So the report gives each such file a label with no hash: `build/html.chunk.d.mts`, and then `build/html.chunk2.d.mts` for a second chunk of that stem. Chunks of one stem sort by their text, so no hash decides the order. An entry of the package keeps its name. A changed declaration in a chunk still changes the report.

The label is for the report only: it is not a file of the package. Two limits apply:

- A hash of small letters and hyphens only reads as a word, so it stays in the report until the next build. This occurs in approximately 1 of 1,000 builds of a chunk.
- A bundler can add a number to a local name, for example `Options$1`. The report keeps that name, so a change of that number changes the report.

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
| `api-report check` | It compares each report with the built `.d.ts` files. It shows the diff of each changed report. The exit code is 1 when a report differs, is missing or has an error, when a folder has a report that the command does not read, or when the command finds no package. A repository of private packages passes. |
| `api-report update` | It writes each report that is not current. It removes each report that the command does not read: the report of a private package, an excluded package or a removed package. The exit code is 1 when the command finds no package. |

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
| `pages` | none | The pages of an API. See [A page of the API](#a-page-of-the-api). |

A glob knows `*` (a part of one folder name), `?`, `**` (zero or more folders) and `{a,b}`. A repository with no workspace is one package: the root.

```json
{
  "apiReport": {
    "packages": ["packages/*", "apps/*", "!packages/internal-*"]
  }
}
```

## A page of the API

A hand-written page can explain each call, but its names can go out of date. The field `pages` holds them. The command `check` fails in these cases:

- The package exports a name, and no code block or code span on the page shows it. Prose does not count, because a type name can also be a common word.
- A code block imports a name from the package, and that entry does not export it.
- A code block has a signature with no body, an `interface` or a `type`, and the package does not export that name.

A name that the page leaves out goes in `except`, with its reason. An exception that removes no fault is also a fault, so the list stays current.

```json
{
  "apiReport": {
    "pages": [
      {
        "package": "packages/lib",
        "pages": ["packages/site/src/content/docs/reference/api.mdx"],
        "except": { "InternalShape": "The type is the input of one function, and the page shows its fields." }
      }
    ]
  }
}
```

The check does not read the meaning of the prose. It holds the names, and a person holds the words.

### A page of each export

A library with many exports can keep each name on a page that the report makes. The field `reference` gives the file of that page.

```json
{
  "apiReport": {
    "pages": [
      {
        "package": "packages/lib",
        "pages": ["packages/site/src/content/docs/reference/api.mdx"],
        "reference": "packages/site/src/content/docs/reference/each-export.md"
      }
    ]
  }
}
```

- The command `update` writes the file. Do not edit it.
- The command `check` fails when the file differs from the text that the report gives.
- The file has a section for each entry, with an import of its names and their declarations. It has no comments, because the report has none. The field `docs` adds the doc comments.
- The hand-written pages explain the main calls. The first rule above does not apply to them, because the file shows each export. The rules for imports and declarations still apply. The list `pages` can be empty.

A site can need more fields in the front matter of the page, for example an `order` for its menu. The field `frontmatter` gives them. A field `title` or `description` replaces the default text.

```json
{
  "apiReport": {
    "pages": [
      {
        "package": "packages/lib",
        "pages": [],
        "reference": "packages/site/content/docs/each-export.mdx",
        "frontmatter": { "order": 42 }
      }
    ]
  }
}
```

Each value is a text, a number or a boolean. The field `frontmatter` needs the field `reference`.

The field `docs` puts the doc comment of each declaration above the declaration. The doc comments come from the built `.d.ts` files.

```json
{
  "apiReport": {
    "pages": [
      {
        "package": "packages/lib",
        "pages": [],
        "reference": "packages/site/content/docs/each-export.md",
        "docs": true
      }
    ]
  }
}
```

- The report does not change. A change of a doc comment changes only the page.
- The field `docs` needs the field `reference`. Without the field, the page has no doc comments.

## The model of the API

The function `packageModel(folder)` gives the public API of a package as data. A site can render it in its own shell.

- `entries` has each entry point, with its subpath and its names.
- Each name has its exported name, its kind, a type-only flag and the key of its declaration.
- `declarations` has the text of each declaration by key, and the text of its doc comment.

The model has the same entries, names and declarations as the report. `apiModel(report, packageName, docs)` gives the model of the text of a report. The text of a report has no doc comments, so the argument `docs` gives them.

## Library

The package also exports the functions of the tool:

- `runReports(options)` compares or writes the reports, and gives the result of each package. `runCli(args, io)` is the bin.
- `packageReport(folder)` and `apiReport(name, root, entries)` give the text of one report.
- `entriesOf(manifest, folder)`, `publishedManifest(manifest)` and `binsOf(manifest)` read a `package.json`.
- `parseDeclarations(text)` and `statementsOf(text)` read a declaration file.
- `packageFolders(root, globs)`, `globFolders(root, glob)`, `globToRegExp(glob)` and `workspaceGlobs(root)` find the packages. They come from `@mark1russell7/conventions/workspace`.
- `diffLines(before, after)` and `unifiedDiff(before, after)` give a line diff.
- `pageFaults(report, packageName, pages, except, complete)` and `reportEntries(report)` hold a hand-written page against a report.
- `referencePage(model, frontmatter)` and `referencePage(report, packageName, frontmatter)` give the Markdown of the page of each export. The argument `frontmatter` is optional.
- `packageModel(folder)` and `apiModel(report, packageName, docs)` give the model of the API.
