/**
 * The stamp: it makes a new repository from a commit of the template. Start it with
 * `node scripts/stamp/main.ts <name> --description <line>`. `new-repo.ps1` calls it.
 *
 * The stamp copies only what `KEEP` names, so a new folder of the template stays out by default.
 * It stops when the result has a part that cannot work, and the test of `ci.yml` installs, checks
 * and builds the result. On 2026-11-04 the repository `collections` needed five hand edits.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePackage } from "../../packages/cli/src/commands/package/add.ts";

/** The files that a new repository gets from the template: a path, or a folder with `/` at the end. */
export const KEEP: readonly string[] = [
  ".dependency-cruiser.ts",
  ".gitattributes",
  ".gitignore",
  ".github/workflows/ai-review.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/codex-review.yml",
  ".github/workflows/release.yml",
  ".github/workflows/security.yml",
  "AI-REVIEW.md",
  "CI.md",
  "CLAUDE.md",
  "CODEX-REVIEW.md",
  "LICENSE",
  "RELEASING.md",
  "package.json",
  "pnpm-workspace.yaml",
  "renovate.json",
  "ste.config.json",
  "tsconfig.scripts.json",
];

/** The form of the name of a new repository. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** A local path of a shared workflow or action, in a `uses:` line. */
const LOCAL_USE = /^([ \t]*(?:-[ \t]*)?uses:[ \t]*)\.\/(\.github\/(?:workflows\/reusable-[\w.-]+\.ya?ml|actions\/[\w.-]+))[ \t]*(?:#[^\r\n]*)?$/gm;

/** A pin of a shared workflow or action, in a `uses:` line. */
const REMOTE_USE = /^([ \t]*(?:-[ \t]*)?uses:[ \t]*)mark1russell7\/template\/(\.github\/(?:workflows|actions)\/[\w./-]+)@[0-9a-f]{40}[ \t]*(?:#[^\r\n]*)?$/gm;

/** This function gives the text of a workflow, with each shared workflow and action pinned to the commit. */
export function pinWorkflow(text: string, sha: string): string {
  const pinned = `@${sha} # main`;
  return text.replace(LOCAL_USE, `$1mark1russell7/template/$2${pinned}`).replace(REMOTE_USE, `$1mark1russell7/template/$2${pinned}`);
}

/** This function gives the paths in a root script that the template has and a new repository does not have. */
const missingPaths = (command: string): string[] => [...command.matchAll(/(?:^|[\s"'\\])((?:scripts|\.github\/actions)\/[\w./*-]*)/g)].flatMap((match) => match[1] ?? []);

/**
 * This function gives the root scripts of a new repository. A script that names a path of the
 * template goes, and each script drops its call of that script. Thus `test` cannot start a script
 * that does not exist.
 */
export function rootScripts(scripts: Readonly<Record<string, string>>): Record<string, string> {
  const gone = new Set(Object.keys(scripts).filter((name) => missingPaths(scripts[name] ?? "").length > 0));
  const kept: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) {
    if (gone.has(name)) continue;
    kept[name] = command
      .split(" && ")
      .filter((part) => ![...gone].some((script) => part === `pnpm run ${script}`))
      .join(" && ");
  }
  kept["package"] = "template package";
  kept["template"] = "template repo";
  return kept;
}

/** The first roadmap of a new repository. The rule `roadmap-parses` refuses a table with no row, and the Status page reads this row. */
export function firstRoadmap(name: string): string {
  return `# Roadmap\n\nThis file is the plan of ${name}. The Status page of the site reads it, and the tracker of the project mirrors it.\n\n| ID | Item | Status | Summary |\n| --- | --- | --- | --- |\n| R1 | The first package | open | Make the first package with \`pnpm package add\`, and replace the first site with a demo. |\n`;
}

/** The input of `stamp`. */
export interface StampOptions {
  /** The name of the new repository. */
  readonly name: string;
  /** This one line tells what the project does. The home page shows it. */
  readonly description: string;
  /** The npm name of the first package. Without it, the home page gives `git clone`. */
  readonly npm?: string | undefined;
  /** The clone of the template. */
  readonly template: string;
  /** The folder of the new repository. It must not exist. */
  readonly out: string;
  /** The commit of the template to copy, and the commit that the workflows pin. */
  readonly ref: string;
  /** This function gives the newest version of an npm package. */
  readonly latest: (name: string) => string;
}

const git = (cwd: string, ...args: string[]): Buffer => execFileSync("git", ["-C", cwd, ...args], { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] });

/** The root package.json, in the fields that the stamp sets. */
export interface RootManifest {
  name: string;
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  readonly [field: string]: unknown;
}

/** This function gives the npm name of each package of the template at a commit. */
function templatePackages(template: string, sha: string, tracked: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const path of tracked.filter((file) => /^packages\/[^/]+\/package\.json$/.test(file))) {
    names.add((JSON.parse(git(template, "show", `${sha}:${path}`).toString("utf8")) as { name: string }).name);
  }
  return names;
}

/**
 * This function gives the root package.json of a repository from the one of the template. A package of the template
 * gets the range of its newest npm version, because the repository does not have the workspace of the template.
 */
export function stampRoot(template: RootManifest, name: string, packages: ReadonlySet<string>, latest: (name: string) => string): RootManifest {
  const dev = { ...template.devDependencies, "@mark1russell7/template-cli": "workspace:*" };
  return {
    ...template,
    name: `${name}-monorepo`,
    scripts: rootScripts(template.scripts),
    devDependencies: Object.fromEntries(
      Object.entries(dev)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dep, range]) => [dep, packages.has(dep) && range === "workspace:*" ? `^${latest(dep)}` : range]),
    ),
  };
}

/** The state of one file of `KEEP` in a repository, as `checkStamp` gives it. */
export interface StampFileCheck {
  readonly path: string;
  /** `missing`: the repository has no such file. `differs`: the stamp at the commit would change it. */
  readonly state: "same" | "differs" | "missing";
  /** For package.json: the fields that the stamp would add or change. */
  readonly fields?: readonly string[];
}

/** A version range that the stamp gives from npm: a caret and a version. The check accepts each one. */
const LATEST_RANGE = /^\^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/**
 * This function gives a workflow text with no part that changes from one repository to another: the commit of each pin
 * and the minute of each schedule, which the fix runner-budget sets for each repository.
 */
export function workflowShape(text: string): string {
  return pinWorkflow(text, "0".repeat(40)).replace(/(cron:[ \t]*["'])[\d,*/-]+([ \t])/g, "$1M$2");
}

/**
 * This function gives the fields of a root package.json that the stamp would add or change. The name, scripts and
 * devDependencies of the repository may have more entries than the stamp gives; a range from npm matches each caret
 * range. Each other field of the template must be equal.
 */
export function rootFieldsBehind(expected: RootManifest, actual: Readonly<Record<string, unknown>>, packages: ReadonlySet<string>, templateDev: Readonly<Record<string, string>>): string[] {
  const behind: string[] = [];
  const scripts = (actual["scripts"] ?? {}) as Record<string, string>;
  for (const [script, command] of Object.entries(expected.scripts)) if (scripts[script] !== command) behind.push(`scripts.${script}`);
  const dev = (actual["devDependencies"] ?? {}) as Record<string, string>;
  for (const [dep, range] of Object.entries(expected.devDependencies)) {
    const fromNpm = packages.has(dep) && (templateDev[dep] ?? "workspace:*") === "workspace:*";
    if (fromNpm ? !LATEST_RANGE.test(dev[dep] ?? "") : dev[dep] !== range) behind.push(`devDependencies.${dep}`);
  }
  for (const [field, value] of Object.entries(expected)) {
    if (field === "name" || field === "scripts" || field === "devDependencies") continue;
    if (JSON.stringify(actual[field]) !== JSON.stringify(value)) behind.push(field);
  }
  return behind;
}

/**
 * This function tells, for each file of `KEEP`, whether the stamp at a commit of the template would change it in an
 * existing repository. It writes nothing and uses no network. The site and docs/ROADMAP.md are made only at the first
 * stamp, so it does not examine them.
 */
export function checkStamp({ repo, template, ref }: { readonly repo: string; readonly template: string; readonly ref: string }): { sha: string; files: StampFileCheck[] } {
  const sha = git(template, "rev-parse", `${ref}^{commit}`).toString().trim();
  const tracked = git(template, "ls-tree", "-r", "--name-only", sha).toString().split("\n").filter(Boolean);
  const packages = templatePackages(template, sha, tracked);
  const files = KEEP.map((path): StampFileCheck => {
    const file = join(repo, path);
    if (!existsSync(file)) return { path, state: "missing" };
    const blob = git(template, "show", `${sha}:${path}`);
    const actual = readFileSync(file);
    if (path === "package.json") {
      const source = JSON.parse(blob.toString("utf8")) as RootManifest;
      const expected = stampRoot(source, "", packages, () => "0.0.0");
      const fields = rootFieldsBehind(expected, JSON.parse(actual.toString("utf8")) as Record<string, unknown>, packages, source.devDependencies);
      return fields.length > 0 ? { path, state: "differs", fields } : { path, state: "same" };
    }
    const same = path.startsWith(".github/workflows/")
      ? workflowShape(actual.toString("utf8").replace(/\r\n/g, "\n")) === workflowShape(blob.toString("utf8").replace(/\r\n/g, "\n"))
      : actual.toString("utf8").replace(/\r\n/g, "\n") === blob.toString("utf8").replace(/\r\n/g, "\n");
    return { path, state: same ? "same" : "differs" };
  });
  return { sha, files };
}

/** This function gives each path of a package manifest under a folder. */
function manifests(root: string, folder = ""): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    if (entry.isDirectory()) return manifests(root, path);
    return entry.name === "package.json" ? [path] : [];
  });
}

/**
 * This function makes the new repository.
 *
 * @throws Error when the name is not valid, the folder exists, or the result has a part that cannot work
 */
export async function stamp({ name, description, npm, template, out, ref, latest }: StampOptions): Promise<string> {
  if (!NAME.test(name)) throw new Error(`The repository name must match ${String(NAME)}.`);
  if (existsSync(out)) throw new Error(`The folder exists: ${out}`);
  const sha = git(template, "rev-parse", `${ref}^{commit}`).toString().trim();

  const tracked = git(template, "ls-tree", "-r", "--name-only", sha).toString().split("\n").filter(Boolean);
  for (const path of KEEP) if (!tracked.includes(path)) throw new Error(`The template at ${sha} has no file ${path}.`);
  for (const path of KEEP) {
    const target = join(out, path);
    mkdirSync(dirname(target), { recursive: true });
    const blob = git(template, "show", `${sha}:${path}`);
    writeFileSync(target, path.startsWith(".github/workflows/") ? pinWorkflow(blob.toString("utf8"), sha) : blob);
  }

  const rootFile = join(out, "package.json");
  const root = stampRoot(JSON.parse(readFileSync(rootFile, "utf8")) as RootManifest, name, templatePackages(template, sha, tracked), latest);
  writeFileSync(rootFile, `${JSON.stringify(root, null, 2)}\n`);

  mkdirSync(join(out, "docs"), { recursive: true });
  writeFileSync(join(out, "docs", "ROADMAP.md"), firstRoadmap(name));

  // The site needs the workflows above: the CLI reads the pin from them
  const written = await writePackage(out, "site", "site", undefined, { description, npm });
  if (written.skipped.length > 0) throw new Error(`The preset site did not write ${written.skipped.join(", ")}.`);
  const siteFile = join(written.dir, "package.json");
  const site = JSON.parse(readFileSync(siteFile, "utf8")) as { devDependencies: Record<string, string> };
  for (const dep of ["vite", "@mark1russell7/site-pages"]) site.devDependencies[dep] = `^${latest(dep)}`;
  site.devDependencies = Object.fromEntries(Object.entries(site.devDependencies).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(siteFile, `${JSON.stringify(site, null, 2)}\n`);

  for (const path of manifests(out)) {
    if (readFileSync(join(out, path), "utf8").includes('"workspace:')) throw new Error(`${path} has a workspace range of a package that is not in the new repository.`);
  }
  execFileSync("git", ["init", "-q", "-b", "main", out]);
  // The rule reads the files that git tracks, and its fix sets the schedule minutes of this repository
  git(out, "add", "-A");
  const conventions = join(template, "packages", "conventions", "src", "cli.ts");
  execFileSync(process.execPath, [conventions, "fix", "--rule", "runner-budget"], { cwd: out, env: { ...process.env, GITHUB_REPOSITORY: `mark1russell7/${name}` }, stdio: "ignore" });
  git(out, "add", "-A");
  return sha;
}
