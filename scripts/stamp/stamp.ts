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

  const inTemplate = new Map<string, string>();
  for (const path of tracked.filter((file) => /^packages\/[^/]+\/package\.json$/.test(file))) {
    const manifest = JSON.parse(git(template, "show", `${sha}:${path}`).toString("utf8")) as { name: string };
    inTemplate.set(manifest.name, path);
  }
  const rootFile = join(out, "package.json");
  const root = JSON.parse(readFileSync(rootFile, "utf8")) as { name: string; scripts: Record<string, string>; devDependencies: Record<string, string> };
  root.name = `${name}-monorepo`;
  root.scripts = rootScripts(root.scripts);
  const dev = { ...root.devDependencies, "@mark1russell7/template-cli": "workspace:*" };
  root.devDependencies = Object.fromEntries(
    Object.entries(dev)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dep, range]) => [dep, inTemplate.has(dep) && range === "workspace:*" ? `^${latest(dep)}` : range]),
  );
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
