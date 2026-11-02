/**
 * The rule `typed-files`: each TypeScript file that git keeps is in a tsconfig that a `typecheck`
 * script examines.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { byCode } from "../workspace.ts";
import {
  codePackages,
  inFolder,
  lineOf,
  readJsonc,
  type Break,
  type Edit,
  type PackageInfo,
  type Rule,
} from "../rule.ts";

/** A TypeScript source: `.ts`, `.tsx`, `.mts` or `.cts`, and not a declaration file. */
const TYPESCRIPT = /\.(?:[cm]?ts|tsx)$/;
const DECLARATION = /\.d\.(?:[cm]?ts|tsx)$/;

/** The compilers that read `-p <config>` (or `tsconfig.json` without it). */
const COMPILERS = new Set(["tsc", "tsgo", "vue-tsc"]);

/** This function gives the commands of a script: its parts between `&&`, `||`, `;`, `|` and parentheses, each as words. */
function commandsOf(script: string): string[][] {
  return script
    .split(/&&|\|\||[;|()]/)
    .map((part) =>
      part
        .trim()
        .split(/\s+/)
        .filter((word) => word !== ""),
    )
    .filter((words) => words.length > 0);
}

/** The last part of a path of a command (`node_modules/.bin/tsc` gives `tsc`). */
const commandName = (word: string): string =>
  word.slice(word.lastIndexOf("/") + 1);

/** This function gives the configs that one `tsc` command examines, from the words after the command. */
function compilerConfigs(words: readonly string[]): string[] {
  const configs: string[] = [];
  let named = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index] as string;
    if (word === "-p" || word === "--project") {
      const next = words[index + 1];
      if (next !== undefined) configs.push(next);
      named = true;
      index++;
    } else if (word.startsWith("-p=") || word.startsWith("--project=")) {
      configs.push(word.slice(word.indexOf("=") + 1));
      named = true;
    } else if (word === "-b" || word === "--build") {
      named = true;
      let more = 0;
      while (
        words[index + 1] !== undefined &&
        !(words[index + 1] as string).startsWith("-")
      ) {
        configs.push(words[index + 1] as string);
        index++;
        more++;
      }
      if (more === 0) configs.push("tsconfig.json");
    }
  }
  if (!named) configs.push("tsconfig.json");
  return configs;
}

/** This function gives the configs that one `typecheck` script examines, relative to the folder of the package. */
export function configsOfScript(script: string): string[] {
  const configs: string[] = [];
  for (const words of commandsOf(script)) {
    const at = words.findIndex(
      (word) =>
        COMPILERS.has(commandName(word)) ||
        commandName(word) === "svelte-check",
    );
    if (at < 0) continue;
    const rest = words.slice(at + 1);
    if (commandName(words[at] as string) !== "svelte-check") {
      configs.push(...compilerConfigs(rest));
      continue;
    }
    for (let index = 0; index < rest.length; index++) {
      const word = rest[index] as string;
      if (word === "--tsconfig" && rest[index + 1] !== undefined)
        configs.push(rest[index + 1] as string);
      else if (word.startsWith("--tsconfig="))
        configs.push(word.slice("--tsconfig=".length));
    }
  }
  return configs.map((config) => config.replace(/^["']|["']$/g, ""));
}

/** The package managers whose `run <script>` (or `<script>`) starts another script of the same package. */
const MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
/** The options that start the script in other packages: the rule reads those packages on their own. */
const OTHER_PACKAGES =
  /^(?:-r|--recursive|-F|--filter(?:=.*)?|--workspaces?|-w|-ws)$/;

/**
 * This function gives the text of the script `name` and of each script of the same package that it
 * starts (`pnpm run typecheck:scripts`), once each.
 */
export function scriptsOf(
  scripts: Readonly<Record<string, unknown>>,
  name: string,
  seen: Set<string> = new Set(),
): string[] {
  const text = scripts[name];
  if (typeof text !== "string" || seen.has(name)) return [];
  seen.add(name);
  const texts = [text];
  for (const part of text.split(/&&|\|\||[;|]/)) {
    const words = part.trim().split(/\s+/);
    if (
      !MANAGERS.has(words[0] ?? "") ||
      words.some((word) => OTHER_PACKAGES.test(word))
    )
      continue;
    const rest = words.slice(1).filter((word) => !word.startsWith("-"));
    const next =
      rest[0] === "run" || rest[0] === "run-script" ? rest[1] : rest[0];
    if (next !== undefined) texts.push(...scriptsOf(scripts, next, seen));
  }
  return texts;
}

/** This function gives the path of `bin/tsc` of `typescript` of the repository, or of this package, or `undefined`. */
function findTsc(root: string): string | undefined {
  for (const from of [join(root, "package.json"), import.meta.url]) {
    try {
      const tsc = join(
        dirname(createRequire(from).resolve("typescript/package.json")),
        "bin",
        "tsc",
      );
      if (existsSync(tsc)) return tsc;
    } catch {
      // Try the next place
    }
  }
  return undefined;
}

/** This function gives the files of the program of one config (`tsc --listFilesOnly`), or the error of tsc. */
function listFiles(
  tsc: string,
  config: string,
): { readonly files: readonly string[] } | { readonly error: string } {
  const result = spawnSync(
    process.execPath,
    [tsc, "-p", config, "--listFilesOnly"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const lines = (result.stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  if (result.status !== 0)
    return {
      error:
        (result.stderr || result.stdout || `exit ${String(result.status)}`)
          .trim()
          .split(/\r?\n/)[0] ?? "",
    };
  return { files: lines.map((line) => line.trim()) };
}

/** This function gives the paths of the `references` of a config, as absolute paths. */
function referencesOf(config: string): string[] {
  const json = readJsonc(config);
  const references =
    typeof json === "object" && json !== null
      ? (json as { references?: unknown }).references
      : undefined;
  if (!Array.isArray(references)) return [];
  return references.flatMap((item: unknown) =>
    typeof item === "object" &&
    item !== null &&
    typeof (item as { path?: unknown }).path === "string"
      ? [resolve(dirname(config), (item as { path: string }).path)]
      : [],
  );
}

/** A config file of a tool (`vitest.config.ts`), with its extension. */
const CONFIG_FILE = /\.config(\.[cm]?ts)$/;

/** A `rootDir` that is the folder of the tsconfig, so that the config files at the root are in it. */
const ROOT_DIRS = new Set([".", "./", "${configDir}", "${configDir}/"]);

/**
 * This function gives the `rootDir` that a tsconfig gets from the configs it extends, as an absolute path, or `null` when
 * no config of the chain sets it. It gives `undefined` when it cannot read a config of the chain, for example a package
 * that is not installed.
 */
function inheritedRootDir(
  tsconfig: string,
  leaf: string = tsconfig,
  seen: ReadonlySet<string> = new Set(),
): string | null | undefined {
  const json = readJsonc(tsconfig) as { extends?: unknown } | undefined;
  if (json === undefined || seen.has(tsconfig)) return undefined;
  const specs = Array.isArray(json.extends)
    ? json.extends
    : json.extends === undefined
      ? []
      : [json.extends];
  let found: string | null = null;
  // A later config of the list wins, as in tsc
  for (const spec of specs) {
    if (typeof spec !== "string") return undefined;
    let file: string;
    try {
      file =
        spec.startsWith(".") || spec.startsWith("/")
          ? resolve(dirname(tsconfig), spec)
          : createRequire(tsconfig).resolve(spec);
    } catch {
      return undefined;
    }
    if (!existsSync(file) && existsSync(`${file}.json`)) file = `${file}.json`;
    const parent = readJsonc(file) as
      { compilerOptions?: { rootDir?: unknown } } | undefined;
    if (parent === undefined) return undefined;
    const own = parent.compilerOptions?.rootDir;
    // `${configDir}` is the folder of the config that tsc reads first, the others are relative to their own config
    const rootDir =
      typeof own === "string"
        ? own.startsWith("${configDir}")
          ? resolve(dirname(leaf), `.${own.slice("${configDir}".length)}`)
          : resolve(dirname(file), own)
        : inheritedRootDir(file, leaf, new Set([...seen, tsconfig]));
    if (rootDir === undefined) return undefined;
    if (rootDir !== null) found = rootDir;
  }
  return found;
}

/**
 * This function gives the edit that adds the config files at the root of a package to its `tsconfig.test.json`. It adds
 * the include `*.config.ts`. When the `rootDir` is a subfolder, it sets `rootDir: "."`. This is also so when the file
 * gets the `rootDir` from a config that it extends, or when that config cannot be read: a `rootDir` of the folder does
 * no harm to a test config that does not emit. The edit changes only these values and keeps the format of the file. It
 * gives no edit for a tsconfig with comments, so that no comment goes. It also gives no edit when the changed text does
 * not parse as the intended config.
 */
function configEdit(root: string, tsconfig: string, extension: string): Edit[] {
  const text = readFileSync(tsconfig, "utf8");
  let json: { include?: unknown; compilerOptions?: Record<string, unknown> };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    return [];
  }
  const globs = json.include;
  if (!Array.isArray(globs)) return [];
  const prefix =
    globs.length > 0 &&
    globs.every(
      (glob) => typeof glob === "string" && glob.startsWith("${configDir}/"),
    )
      ? "${configDir}/"
      : "";
  const glob = `${prefix}*.config${extension}`;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let after = text;
  if (!globs.includes(glob)) {
    after = after.replace(
      /("include"\s*:\s*\[)([^\]]*)\]/,
      (_all, start: string, items: string) => {
        const kept = items.replace(/\s+$/, "");
        const end = items.slice(kept.length);
        if (kept.trim() === "") return `${start}${JSON.stringify(glob)}]`;
        const indent = kept.includes("\n")
          ? (/\n([ \t]*)[^\n]*$/.exec(kept)?.[1] ?? "")
          : undefined;
        return `${start}${kept},${indent === undefined ? " " : `${eol}${indent}`}${JSON.stringify(glob)}${end}]`;
      },
    );
  }
  const options = json.compilerOptions;
  const rootDir = options?.["rootDir"];
  const moveRoot = typeof rootDir === "string" && !ROOT_DIRS.has(rootDir);
  if (moveRoot)
    after = after.replace(/("rootDir"\s*:\s*)"(?:[^"\\]|\\.)*"/, '$1"."');
  // With no rootDir of its own, the file can get a subfolder (`src`) from a config that it extends
  const inherited =
    rootDir === undefined && after !== text ? inheritedRootDir(tsconfig) : null;
  const addRoot =
    inherited !== null &&
    (inherited === undefined ||
      resolve(inherited) !== resolve(dirname(tsconfig)));
  if (addRoot && options !== undefined) {
    after =
      Object.keys(options).length === 0
        ? after.replace(
            /("compilerOptions"\s*:\s*\{)\s*\}/,
            '$1 "rootDir": "." }',
          )
        : after.replace(
            /("compilerOptions"\s*:\s*\{)(\s*)/,
            (_all, start: string, space: string) =>
              `${start}${space}"rootDir": ".",${space}`,
          );
  } else if (addRoot) {
    after = after.replace(
      /^(\s*\{)(\s*)/,
      (_all, start: string, space: string) =>
        `${start}${space}"compilerOptions": { "rootDir": "." },${space}`,
    );
  }
  const include = globs.includes(glob) ? globs : [...globs, glob];
  const intended = addRoot
    ? options === undefined
      ? { compilerOptions: { rootDir: "." }, ...json, include }
      : { ...json, compilerOptions: { rootDir: ".", ...options }, include }
    : {
        ...json,
        ...(moveRoot ? { compilerOptions: { ...options, rootDir: "." } } : {}),
        include,
      };
  let parsed: unknown;
  try {
    parsed = JSON.parse(after);
  } catch {
    return [];
  }
  if (JSON.stringify(parsed) !== JSON.stringify(intended)) return [];
  return after === text
    ? []
    : [{ file: fromRoot(root, tsconfig), before: text, after }];
}

/** The path of `file` relative to `root`, with `/`. */
const fromRoot = (root: string, file: string): string =>
  relative(root, file).split("\\").join("/");

export const typedFiles: Rule = {
  id: "typed-files",
  title:
    "Each TypeScript file that git keeps is in a tsconfig that a `typecheck` script examines: the tests, the e2e specs, the scripts, the benches and the configs too.",
  reason:
    "A file that no tsconfig of a typecheck holds has no type check. Its type errors hide until it runs, and a broken test or script can pass a gate. A test runner such as vitest strips the types, so it does not examine them. In the fleet audit of 2026-10-30, every repository had such files (in one, 90 of 612 files, its e2e specs among them), and the new checks found real defects.",
  fix: 'Add the file to the `include` of a tsconfig that the `typecheck` script names (for example `tsconfig.test.json`, with `*.config.ts`, `scripts/**`, `bench/**` and `e2e/**`). A config file at the root of a package needs `rootDir: "."` there. For the files at the root of the repository, add a `tsconfig.repo.json` and name it in the root `typecheck`. A file that cannot be in a typecheck (it imports a module that only a tool makes) goes in `ignore` with its reason.',
  sources: [
    {
      repo: "fleet",
      rule: "fail-closed",
      doc: "docs/STRATEGY.md (2026-10-30, gates and probes fail closed)",
    },
  ],
  options: {
    configs: {
      type: "strings",
      default: [],
      description:
        "More tsconfig files, relative to the root, that CI examines with another command (for example a script that the typecheck starts).",
    },
  },
  check(context, options) {
    const tracked = context.gitFiles();
    if (tracked === undefined)
      return { skipped: "the root is not in a git repository" };
    const files = tracked
      .filter((file) => TYPESCRIPT.test(file) && !DECLARATION.test(file))
      .sort(byCode);
    if (files.length === 0) return [];
    const tsc = findTsc(context.root);
    if (tsc === undefined)
      return [
        {
          file: "package.json",
          message:
            "The rule cannot find typescript, so it cannot read the tsconfig files.",
          fix: "Add typescript to the devDependencies of the root package.",
        },
      ];
    const breaks: Break[] = [];
    // The configs that a typecheck examines, as absolute paths
    const queue: string[] = [];
    // The tsconfig.test.json of each package folder that its typecheck names, for the edits
    const testConfigs = new Map<string, string>();
    const packages: PackageInfo[] = [
      context.rootPackage,
      ...codePackages(context).filter((info) => info !== context.rootPackage),
    ];
    for (const info of packages) {
      const scripts = info.manifest["scripts"];
      const table =
        typeof scripts === "object" && scripts !== null
          ? (scripts as Record<string, unknown>)
          : {};
      const typecheck = table["typecheck"];
      if (typeof typecheck !== "string") continue;
      for (const config of scriptsOf(table, "typecheck").flatMap(
        configsOfScript,
      )) {
        const path = resolve(info.dir, config);
        if (!existsSync(path)) {
          const line = lineOf(info.text, '"typecheck"');
          breaks.push({
            file: info.file,
            ...(line === undefined ? {} : { line }),
            message: `The script typecheck names ${inFolder(info.folder, config)}, and that file does not exist.`,
          });
          continue;
        }
        queue.push(path);
        if (
          basename(path) === "tsconfig.test.json" &&
          resolve(dirname(path)) === resolve(info.dir)
        )
          testConfigs.set(info.folder, path);
      }
    }
    const extra = Array.isArray(options["configs"]) ? options["configs"] : [];
    for (const config of extra) {
      const path = resolve(context.root, config);
      if (!existsSync(path))
        breaks.push({
          file: "package.json",
          message: `The option configs names ${config}, and that file does not exist.`,
        });
      else queue.push(path);
    }
    // Read each config and its references, once
    const covered = new Set<string>();
    const seen = new Set<string>();
    while (queue.length > 0) {
      let path = queue.shift() as string;
      if (existsSync(path) && statSync(path).isDirectory())
        path = join(path, "tsconfig.json");
      if (seen.has(path)) continue;
      seen.add(path);
      queue.push(...referencesOf(path));
      const listed = listFiles(tsc, path);
      if ("error" in listed) {
        breaks.push({
          file: fromRoot(context.root, path),
          message: `tsc cannot list the files of ${fromRoot(context.root, path)}: ${listed.error}`,
        });
        continue;
      }
      for (const name of listed.files)
        covered.add(fromRoot(context.root, resolve(name)));
    }
    if (seen.size === 0) {
      breaks.push({
        file: "package.json",
        message:
          "No typecheck script names a tsconfig, so no TypeScript file has a type check.",
        fix: "Add a script typecheck (`tsc -p tsconfig.json`) to each package.",
      });
    }
    for (const file of files) {
      if (covered.has(file)) continue;
      const folder = file.includes("/")
        ? file.slice(0, file.lastIndexOf("/"))
        : "";
      const extension = CONFIG_FILE.exec(file)?.[1];
      const tsconfig = testConfigs.get(folder);
      const edits =
        extension === undefined || tsconfig === undefined
          ? []
          : configEdit(context.root, tsconfig, extension);
      breaks.push({
        file,
        message: `${file} is in no tsconfig that a typecheck script examines.`,
        edits,
      });
    }
    return breaks;
  },
};
