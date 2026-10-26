# @mark1russell7/boundaries

This package gives the import boundaries of a pnpm workspace as a [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) configuration. Each package is a unit. Another package imports it only through an entry of its `package.json`.

## Rules

| Rule | It fails when |
|---|---|
| `relative-import-out-of-<package>` | A relative import (`../../b/src/x.js`) goes into the folder of a different package. |
| `deep-import-into-<package>` | An import gets to a file of a package that is not an entry of its `package.json` (`exports`, `main`, `module`, `types` or `bin`). |
| `not-a-declared-export` | An import of a workspace package does not resolve. The path is not in its `exports`, or the package is not built. |
| `import-of-the-app-<package>` | A package imports an app. An app is a leaf of the graph. This rule is only on with the option `apps`. |

A type-only import is a boundary too. Tests, fixtures and declaration files are not part of a boundary.

## Use

Install the package, `dependency-cruiser` and, for TypeScript 7 or for source with no TypeScript compiler, `@swc/core`:

```sh
pnpm add -D @mark1russell7/boundaries dependency-cruiser @swc/core
```

Write `.dependency-cruiser.mjs` at the root of the repository:

```js
import { boundaries } from "@mark1russell7/boundaries";

export default boundaries(import.meta.dirname);
```

Add the script `"check:boundaries": "depcruise --config .dependency-cruiser.mjs packages"`. The shared CI of the template starts `check:boundaries` after `build` (`CI.md`).

## Options

`boundaries(root, options)` reads the packages of `pnpm-workspace.yaml`. These options change it:

| Option | Default | What it sets |
|---|---|---|
| `packages` | the `packages` list of `pnpm-workspace.yaml` | The globs of the package folders. |
| `apps` | none | The apps. `"private"` makes each private package an app. |
| `reference` | none | A text before each comment, for example the name of the decision record. |
| `forbidden` | none | More rules of the repository, after the rules of the boundaries. |
| `options` | the default options | More options of dependency-cruiser. They replace the default options that have the same key. |

An example with the rules of a repository:

```js
const { boundaries } = require("@mark1russell7/boundaries");

module.exports = boundaries(__dirname, {
  apps: "private",
  reference: "Invariant I9 of ARCHITECTURE.md.",
  forbidden: [
    {
      name: "transport-imports-server",
      severity: "error",
      from: { path: "^packages/client/src/adapters/" },
      to: { path: "^packages/server/" },
    },
  ],
});
```

## The parser

dependency-cruiser reads TypeScript with the TypeScript compiler of the repository only for TypeScript 2 to 6. With TypeScript 7, or with no TypeScript, `boundaries()` sets the parser `swc` when `@swc/core` is installed. Without `@swc/core`, dependency-cruiser reads only JavaScript. That is enough for a check of built JavaScript.

## Other exports

- `boundaryRules(packages, options)` gives only the rules, for a list of packages.
- `workspacePackages(root, globs)` gives the packages of the workspace and their entries.
- `defaultOptions(root)` and `parserOptions(root)` give the default options.
