/**
 * The `site-pages build` command. It reads the sources. Then it writes the JSON data and the two
 * standalone pages into the built output folder of a site.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { headCommit, originRepository } from "./data/git.ts";
import { readReleases, ReleaseDataError } from "./data/releases.ts";
import { readStatusBoard, RoadmapParseError } from "./data/status.ts";
import type { Release, StatusBoardData } from "./data/types.ts";
import { plural } from "./render/html.ts";
import { renderReleasesPage } from "./render/releases.ts";
import { renderStatusPage } from "./render/status.ts";
import type { PageOptions } from "./render/theme.ts";

/** An error in the command line. The CLI shows the help and exits with code 2. */
export class UsageError extends Error {}

/** The options of `build`. */
export interface BuildOptions {
  /** The folder of the repository. Relative paths start here. */
  repoDir: string;
  /** "owner/name" of the repository on GitHub. */
  repository: string;
  /** The built output folder of the site. */
  out: string;
  /** The path of the site home, for example `/client/`. */
  base: string;
  /** The roadmap file, from `repoDir`. Without it, the status page has only the GitHub part. */
  roadmap?: string | undefined;
  /** The npm names or scopes for the npm dates. */
  packages?: readonly string[] | undefined;
  /** The glob pattern of the changelog files. */
  changesets?: string | undefined;
  /** The npm name of the package whose changelog gives the versions. */
  group?: string | undefined;
  token?: string | undefined;
  /** The commit of the build. */
  commit?: string | null | undefined;
  /** A CSS file whose content each page gets after the default CSS. */
  css?: string | undefined;
  /** The name of the site in the header of the pages. */
  siteName?: string | undefined;
  /** True to write only the JSON data, without the pages. */
  dataOnly?: boolean | undefined;
  fetch?: typeof fetch | undefined;
  /** The ISO time of the build. The default is the time of the call. */
  now?: string | undefined;
  warn?: ((message: string) => void) | undefined;
}

/** The result of `build`. */
export interface BuildResult {
  /** The written files, as absolute paths. */
  files: string[];
  releases: Release[];
  status: StatusBoardData;
}

function write(file: string, content: string, files: string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  files.push(file);
}

/**
 * This function reads the sources and writes `data/releases.json`, `data/status.json`,
 * `releases/index.html` and `status/index.html` into the output folder.
 *
 * @throws ReleaseDataError or RoadmapParseError when a source on disk is not correct
 */
export async function build(options: BuildOptions): Promise<BuildResult> {
  const { repoDir, repository, warn = () => {} } = options;
  const now = options.now ?? new Date().toISOString();
  const commit = options.commit === undefined ? headCommit(repoDir) : options.commit;
  const [owner = "", repo = ""] = repository.split("/");
  const out = isAbsolute(options.out) ? options.out : resolve(repoDir, options.out);
  const fetcher = options.fetch ? { fetch: options.fetch } : {};

  const releases = await readReleases({
    repoDir,
    repository,
    token: options.token,
    changesets: options.changesets,
    packages: options.packages,
    group: options.group,
    ref: commit ?? undefined,
    now,
    warn,
    ...fetcher,
  });
  const status = await readStatusBoard({ repoDir, roadmap: options.roadmap ?? null, owner, repo, token: options.token, commit, generatedAt: now, ...fetcher });
  if (!status.github.available) warn(`the status page has no GitHub data: ${status.github.reason ?? "no reason"}.`);

  const files: string[] = [];
  write(join(out, "data", "releases.json"), `${JSON.stringify(releases, null, 2)}\n`, files);
  write(join(out, "data", "status.json"), `${JSON.stringify(status, null, 2)}\n`, files);
  if (!options.dataOnly) {
    const page: PageOptions = {
      repository,
      base: options.base,
      siteName: options.siteName,
      extraCss: options.css ? readFileSync(isAbsolute(options.css) ? options.css : resolve(repoDir, options.css), "utf8") : undefined,
      generatedAt: now,
      commit,
    };
    write(join(out, "releases", "index.html"), renderReleasesPage(releases, page), files);
    write(join(out, "status", "index.html"), renderStatusPage(status, page), files);
  }
  return { files, releases, status };
}

/** The help of the CLI. */
export const HELP = `Usage: site-pages build --out <dir> [options]

Writes <out>/data/releases.json, <out>/data/status.json, <out>/releases/index.html
and <out>/status/index.html. Start it in the repository, after the build of the site.

Options:
  --out <dir>           The built output folder of the site (necessary)
  --repo <owner/name>   The GitHub repository (default: $GITHUB_REPOSITORY, else the remote "origin")
  --base </name/>       The path of the site home (default: "/<name>/", or "/" for <owner>.github.io)
  --roadmap <file>      The roadmap file (default: none, the status page has only the GitHub part)
  --packages <names>    npm names or a @scope, separated by commas, for the npm dates
  --changesets <glob>   The changelog files (default: packages/*/CHANGELOG.md, else CHANGELOG.md)
  --group <name>        The npm name of the package whose changelog gives the versions
  --token <token>       A GitHub token with read access (default: $GITHUB_TOKEN)
  --css <file>          A CSS file for the pages, after the default CSS
  --site-name <name>    The name of the site in the header (default: the repository name)
  --data-only           Write only the JSON data, not the pages
  -h, --help            Show this help
`;

/** The input and output of `runCli`. A test gives its own values. */
export interface CliIo {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch?: typeof fetch;
  now?: string;
}

/**
 * This function reads the command line into the options of `build`.
 *
 * @throws UsageError when the command line is not correct
 */
export function parseBuildArgs(argv: readonly string[], io: Pick<CliIo, "cwd" | "env">): BuildOptions | "help" {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) return "help";
  if (positionals[0] !== "build" || positionals.length > 1) {
    throw new UsageError(positionals.length === 0 ? "no command was given" : `unknown command: ${positionals.join(" ")}`);
  }
  if (!values.out) throw new UsageError("--out is necessary");
  const repository = values.repo || io.env["GITHUB_REPOSITORY"] || originRepository(io.cwd) || "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new UsageError(repository ? `--repo must be "owner/name", not "${repository}"` : "give --repo <owner/name> or set GITHUB_REPOSITORY");
  }
  const name = repository.split("/")[1] ?? "";
  let base = values.base ?? (/\.github\.io$/i.test(name) ? "/" : `/${name}/`);
  if (!base.startsWith("/")) base = `/${base}`;
  if (!base.endsWith("/")) base = `${base}/`;
  const packages = (values.packages ?? []).flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean);
  const changesets = values.changesets;
  return {
    repoDir: io.cwd,
    repository,
    out: values.out,
    base,
    roadmap: values.roadmap,
    packages,
    changesets,
    group: values.group,
    token: values.token || io.env["GITHUB_TOKEN"] || undefined,
    css: values.css,
    siteName: values["site-name"],
    dataOnly: values["data-only"] === true,
  };
}

function parseCommandLine(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      out: { type: "string" },
      repo: { type: "string" },
      base: { type: "string" },
      roadmap: { type: "string" },
      packages: { type: "string", multiple: true },
      changesets: { type: "string" },
      group: { type: "string" },
      token: { type: "string" },
      css: { type: "string" },
      "site-name": { type: "string" },
      "data-only": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

/**
 * This function starts the CLI and gives the exit code. The code is 0 after a build, 1 when a
 * source is not correct, and 2 for an incorrect command line.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let options: BuildOptions | "help";
  try {
    options = parseBuildArgs(argv, io);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`site-pages: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (options === "help") {
    io.stdout(HELP);
    return 0;
  }
  try {
    const result = await build({
      ...options,
      warn: (message) => io.stderr(`site-pages: ${message}\n`),
      ...(io.fetch ? { fetch: io.fetch } : {}),
      ...(io.now ? { now: io.now } : {}),
    });
    const open = result.status.items.filter((item) => item.statusClass !== "done").length;
    const github = result.status.github.available
      ? `${plural(result.status.pullRequests.length, "open pull request")} and ${plural(result.status.issues.length, "open issue")}`
      : "no GitHub data";
    io.stdout(
      `site-pages: ${plural(result.releases.length, "release")}, ${plural(result.status.items.length, "roadmap item")} (${open} open), ${github}.\n` +
        result.files.map((file) => `  ${file}\n`).join(""),
    );
    return 0;
  } catch (error) {
    if (error instanceof ReleaseDataError || error instanceof RoadmapParseError || (error as NodeJS.ErrnoException)?.code === "ENOENT") {
      io.stderr(`site-pages: ${(error as Error).message}\n`);
      return 1;
    }
    throw error;
  }
}
