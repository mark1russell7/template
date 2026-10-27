# @mark1russell7/boundaries

This package gives the import boundaries of a pnpm workspace as a [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) configuration. Each package is a unit. Another package imports it only through an entry of its `package.json`.

## Rules

| Rule | It fails when |
|---|---|
| `relative-import-out-of-<package>` | A relative import (`../../b/src/x.js`) goes into the folder of a different package. |
| `deep-import-into-<package>` | An import gets to a file of a package that is not an entry of its `package.json` (`exports`, `main`, `module`, `types` or `bin`). |
| `not-a-declared-export` | An import of a workspace package does not resolve. The path is not in its `exports`, or the package is not built. |
| `unknown-workspace-package` | An import in a scope of the workspace (for example `@x/typo`) does not resolve, and the name is not a workspace package or a declared dependency. |
| `import-of-the-app-<package>` | A package imports an app. An app is a leaf of the graph. This rule is only on with the option `apps`. |

A type-only import is a boundary too. Tests, fixtures and declaration files are not part of a boundary.

The rule `import-of-the-app-<package>` examines only the path of an import that resolves. When the name of an app does not resolve, `not-a-declared-export` finds the import.

The scopes of `unknown-workspace-package` are the scopes of the workspace package names. For example, the packages `@x/a` and `@x/b` give the scope `@x`. A declared dependency is a name in a dependency field (`dependencies`, `devDependencies`, `peerDependencies` or `optionalDependencies`) of the root `package.json` or of a workspace package.

## Use

Install the package, `dependency-cruiser` and, for TypeScript 7 or for source with no TypeScript compiler, `@swc/core`:

```sh
pnpm add -D @mark1russell7/boundaries dependency-cruiser @swc/core
```

Since pnpm 11, the install fails with `ERR_PNPM_IGNORED_BUILDS` when a package has an install script that `allowBuilds` does not name. `@swc/core` has an install script. That script only examines the native package, and pnpm installs the native package as an optional dependency. Thus disallow the script in `pnpm-workspace.yaml` before the install:

```yaml
allowBuilds:
  "@swc/core": false
```

The option `--allow-build='!@swc/core'` of `pnpm add` writes the same setting.

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
| `reference` | none | A text before each comment, for example the name of the decision record. The rules of `forbidden` get it too, when their comment does not start with it. |
| `scopes` | the scopes of the workspace package names | The scopes of `unknown-workspace-package`. A list replaces the scopes. `{ add: ["@y"], remove: ["@x"] }` changes them. `[]` turns off the rule. |
| `buildFolders` | `["dist", "build"]` | The build folders of each package. The analysis does not follow them. `[]` follows them. |
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
      comment: "A transport does not import the server.",
      from: { path: "^packages/client/src/adapters/" },
      to: { path: "^packages/server/" },
    },
  ],
});
```

## The default options

- `doNotFollow`: `node_modules` and the build folders of each package (`buildFolders`). An import of a different package stops at its entry, for example `packages/b/dist/index.js`. The analysis does not go into the imports of that built file. It also does not start from the files of a build folder.
- `enhancedResolveOptions.conditionNames`: `["import", "node", "default"]`, as Node resolves an ESM import. An entry that is only for `require` does not resolve.
- `exclude`: tests, fixtures, declaration files and `node_modules`.

To change a default option, give the option in `options`. For example, `options: { enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"], mainFields: ["module", "main"] } }` also resolves the entries for `require`.

## The parser

dependency-cruiser reads TypeScript with the TypeScript compiler of the repository only for TypeScript 2 to 6. With TypeScript 7, or with no TypeScript, `boundaries()` sets the parser `swc` when `@swc/core` is installed. Without `@swc/core`, dependency-cruiser reads only JavaScript. For a check of built JavaScript, set `buildFolders: []`.

## Changes in 0.2.0

These changes can give different results than 0.1.0:

- The analysis does not follow the build folders (`dist/` and `build/`) of the packages.
- The resolution does not use the condition `require`.
- The new rule `unknown-workspace-package` finds an import of an unknown name in a scope of the workspace.
- The rules of `forbidden` get the text of `reference`.

## Other exports

- `boundaryRules(packages, options)` gives only the rules, for a list of packages.
- `workspacePackages(root, globs)` gives the packages of the workspace, their entries and their declared dependencies.
- `workspaceScopes(packages, scopes)` gives the scopes of `unknown-workspace-package`.
- `declaredDependencies(manifest)` gives the names in the dependency fields of a `package.json`.
- `defaultOptions(root, { packages, buildFolders })`, `doNotFollowPaths(packages, buildFolders)` and `parserOptions(root)` give the default options.
