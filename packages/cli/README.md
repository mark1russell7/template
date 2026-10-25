# @mark1russell7/template-cli

The CLI of the template monorepos. It adds a source package with a preset of [`@mark1russell7/cue`](https://github.com/mark1russell7/cue), and it renames a new repository.

```sh
pnpm add -D -w @mark1russell7/template-cli
```

Give the root `package.json` of the repository these scripts:

```json
{
  "scripts": {
    "package": "template package",
    "template": "template repo"
  }
}
```

## Add a package

```sh
pnpm package add <name> --preset=<node|node-cjs|ts|vite|react|service>
```

- The command makes `packages/<name>` with `package.json`, `tsconfig.json`, `tsconfig.test.json`, `src/index.ts` and `vitest.config.ts`.
- The name of the package is `@<scope>/<name>`. The scope is the name of the root `package.json` without `-monorepo`.
- The package is a source package. Its `main` is `src/index.ts`, so the other packages import its source.
- `tsconfig.json` extends the preset of `@mark1russell7/cue`. The `vite` and `react` presets also add their packages with `pnpm add`.
- Each development dependency gets the range that the repository uses: the root `package.json`, then the packages in name order. A dependency that the repository does not have gets the range of the CLI. Thus `pnpm up -r --latest` keeps the new packages current.
- Without a name or a preset, the command asks for them.

### A server package

The preset `service` makes an HTTP server on the one service runner, [`@mark1russell7/service`](https://www.npmjs.com/package/@mark1russell7/service). The server does not start with a bare `listen()`.

| File | What it does |
| --- | --- |
| `src/api.ts` | The component: an HTTP server (`httpTransport`), its controller and its routes. It does not start. |
| `src/index.ts` | The declaration of the one service: the API, the probe server (`probeServer`), the policies and the profiles. It starts nothing. |
| `src/main.ts` | The entry of the process, and the only file that uses `run()`. `pnpm start` starts it. |
| `src/index.test.ts` | The tests: the declaration passes `describe()` and `lint()`, and the server answers and exits 0. |

- The dependency `@mark1russell7/service` gets the range of the repository, or the range of the CLI.
- `PORT` (8080), `PROBE_PORT` (9090) and `SERVICE_PROFILE` (`local` or `pod`) set the ports and the profile.
- The profile `pod` is for Kubernetes with a grace of 30 s. Make its grace equal to the grace of the pod.
- The files of each preset are in `src/presets/<preset>/`. The CLI replaces `{{name}}`, `{{scope}}` and `{{package}}` in them.
- The job `presets` of the CI makes a package of each preset. The package must pass its typecheck and its tests.

## Rename a new repository

```sh
pnpm template rename <scope> [--dry-run] [--reinit-git] [--force]
```

- A new repository starts with the scope `template`. The command changes `@template/` to `@<scope>/` in the `package.json` files and in the imports of the sources. The root name becomes `<scope>-monorepo`.
- `--dry-run` shows the changes and writes nothing.
- `--reinit-git` removes `.git` after a confirmation, and starts `git init`. `--force` skips the confirmation.

## Where the CLI operates

The CLI operates in the repository of the working folder: the nearest folder with a `pnpm-workspace.yaml`. A command outside a repository stops with an error.

The package works in Node.js 22.12 or later. The license is MIT.
