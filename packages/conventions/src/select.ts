/**
 * The selector of precise CI (CI.md, "The selection"). It reads the change of a pull request and the workspace of the
 * repository. It gives a record of the format `selection/1`: the packages that the change can affect, and the choice of
 * each shared job with its cause.
 *
 * The rules fail open. A global file selects everything, and so does a file that the selector cannot place. A change
 * that the selector cannot read gives "no read", not a smaller selection.
 *
 * The shared actions run with no install, so the action `select` runs a bundle of this module with its dependencies
 * (`.github/actions/bundles/select.mjs`, from `tsdown.actions.config.ts`). The script `check:actions` fails when the
 * bundle is not current.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { getDescendants } from "@mark1russell7/collections/dag";
import { globToRegExp } from "@mark1russell7/files/glob";
import { DEPENDENCY_FIELDS } from "./rule.ts";
import { byCode, isWorkspaceFolder, parseWorkspaceGlobs } from "./workspace.ts";

/** The name of the format of the selection. */
export const SELECTION_FORMAT = "selection/1";

/** A package of the workspace. Its id is its folder relative to the workspace root (`.` for the root), as in the lockfile. */
export interface WorkspacePackage {
  readonly id: string;
  readonly name: string;
  /** The value `true` tells that the package is private, so it has no release. */
  readonly private: boolean;
  /** The ids of the packages of the workspace that this package depends on, in each dependency field. */
  readonly deps: readonly string[];
}

/** A file of the change: its path from the repository root, and its letter of `git diff --name-status` (A, M, D, T). */
export interface ChangedFile {
  readonly path: string;
  readonly status: string;
}

/** The packages and the paths that a job reads. The paths are globs from the repository root. */
export interface JobRule {
  readonly workflow: string;
  readonly job: string;
  /** The value `all` is each package, `published` is each package with a release, and `none` is no package. */
  readonly packages: "all" | "published" | "none";
  readonly paths: readonly string[];
}

/** A glob of a global file, and the reason why a change to it selects everything. */
export interface GlobalRule {
  readonly glob: string;
  readonly reason: string;
}

/** The cause of the choice of a job. */
export type SelectionCause =
  | { readonly kind: "global"; readonly files: readonly string[] }
  | { readonly kind: "unplaced"; readonly files: readonly string[] }
  | { readonly kind: "packages"; readonly packages: readonly string[] }
  | { readonly kind: "paths"; readonly files: readonly string[] }
  | { readonly kind: "none" };

/** The choice of one job. Its packages are the affected packages that the job reads. */
export interface JobChoice {
  readonly workflow: string;
  readonly job: string;
  readonly run: boolean;
  readonly because: SelectionCause;
  readonly packages: readonly string[];
}

/** An affected package. The value `via` is `changed`, `everything`, or the id of a changed package that it depends on. */
export interface AffectedPackage {
  readonly id: string;
  readonly via: string;
}

/** A file and the reason of its rule. */
export interface FileReason {
  readonly path: string;
  readonly reason: string;
}

/** The selection of a change. */
export interface Selection {
  readonly format: typeof SELECTION_FORMAT;
  readonly base: string;
  readonly head: string;
  /** The value `true` tells that a global file, or a file that the selector cannot place, selects everything. */
  readonly everything: boolean;
  readonly global: readonly FileReason[];
  readonly unplaced: readonly FileReason[];
  readonly files: readonly (ChangedFile & { readonly package: string | null })[];
  readonly packages: {
    readonly all: readonly string[];
    readonly changed: readonly string[];
    readonly affected: readonly AffectedPackage[];
  };
  readonly jobs: readonly JobChoice[];
}

/** The record of a selector that cannot read the change. */
export interface SelectionNoRead {
  readonly format: typeof SELECTION_FORMAT;
  readonly noRead: string;
}

/** The record that the action writes: the selection or the no read, the ref of the selector, and its time. */
export type SelectionRecord = (Selection | SelectionNoRead) & {
  /** The commit of the shared actions that ran the selector. It is empty when the caller does not give it. */
  readonly ref: string;
  /** The time of the selector process in milliseconds, from the start of Node.js. */
  readonly durationMs: number;
};

/**
 * The global files, relative to the workspace root. The selector cannot see the effect of these files on each test, so
 * a change to one of them selects everything.
 */
export const GLOBAL_FILES: readonly GlobalRule[] = [
  { glob: "pnpm-lock.yaml", reason: "the lockfile" },
  { glob: "package.json", reason: "the root package.json: the tools, the scripts and the settings of each package" },
  { glob: "pnpm-workspace.yaml", reason: "the packages and the settings of the workspace" },
  { glob: ".npmrc", reason: "the settings of the install" },
  { glob: ".nvmrc", reason: "the Node.js version" },
  { glob: ".node-version", reason: "the Node.js version" },
  { glob: "patches/**", reason: "a patch of a dependency" },
  { glob: "tsconfig*.json", reason: "a root TypeScript config" },
  { glob: "vitest.*", reason: "a root vitest config" },
  { glob: "eslint.config.*", reason: "the root lint config" },
  { glob: "ste.config.json", reason: "the config of the prose lint" },
  { glob: "*.cue", reason: "a CUE preset of the generated configs" },
  { glob: "cue.mod/**", reason: "a CUE preset of the generated configs" },
];

/** The global files relative to the repository root: the workflows and the local actions. */
export const REPOSITORY_GLOBAL_FILES: readonly GlobalRule[] = [
  { glob: ".github/workflows/**", reason: "a workflow" },
  { glob: ".github/actions/**", reason: "a local action" },
];

/** The jobs of `reusable-ci.yml`, and the packages and the paths that each job reads. */
export const SHARED_JOBS: readonly JobRule[] = [
  { workflow: "reusable-ci.yml", job: "checks", packages: "all", paths: [] },
  { workflow: "reusable-ci.yml", job: "coverage", packages: "all", paths: [] },
  { workflow: "reusable-ci.yml", job: "changesets", packages: "published", paths: [".changeset/**"] },
  { workflow: "reusable-ci.yml", job: "release-check", packages: "published", paths: ["scripts/release/**"] },
  { workflow: "reusable-ci.yml", job: "release-window", packages: "none", paths: [".github/workflows/**", "scripts/release/**"] },
];

/**
 * This function gives the packages of a workspace. The input is the text of `pnpm-workspace.yaml` (undefined in a
 * repository of one package) and the text of each `package.json` by its path from the workspace root.
 */
export function readWorkspace(workspaceYaml: string | undefined, manifests: ReadonlyMap<string, string>): WorkspacePackage[] {
  const globs = workspaceYaml === undefined ? [] : (parseWorkspaceGlobs(workspaceYaml) ?? []);
  const found: { id: string; json: Record<string, unknown> }[] = [];
  for (const [path, text] of manifests) {
    const id = posix.dirname(path);
    if (id !== "." && !isWorkspaceFolder(id, globs)) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error(`${path} is not a JSON object`);
    found.push({ id, json: json as Record<string, unknown> });
  }
  const byName = new Map<string, string>();
  for (const { id, json } of found) if (typeof json["name"] === "string") byName.set(json["name"], id);
  return found
    .map(({ id, json }): WorkspacePackage => {
      const deps = new Set<string>();
      for (const field of DEPENDENCY_FIELDS) {
        const block = json[field];
        if (typeof block !== "object" || block === null) continue;
        for (const name of Object.keys(block)) {
          const dep = byName.get(name);
          if (dep !== undefined && dep !== id) deps.add(dep);
        }
      }
      return { id, name: typeof json["name"] === "string" ? json["name"] : id, private: json["private"] === true, deps: [...deps].sort(byCode) };
    })
    .sort((a, b) => byCode(a.id, b.id));
}

/** This function gives the id of the package of a path from the workspace root: the deepest package folder that holds it, else the root. */
export function packageOf(path: string, ids: readonly string[]): string {
  let best = ".";
  for (const id of ids) if (id !== "." && path.startsWith(`${id}/`) && id.length > best.length) best = id;
  return best;
}

/**
 * This function gives the changed packages and each package that depends on one of them. For a dependent, `via` is the
 * first changed package, in the order of the code units, that it depends on.
 */
export function affectedPackages(changed: readonly string[], packages: readonly WorkspacePackage[]): AffectedPackage[] {
  const nodes = new Map(packages.map((pkg) => [pkg.id, { id: pkg.id, dependencies: [...pkg.deps] }]));
  const via = new Map<string, string>(changed.map((id) => [id, "changed"]));
  for (const id of [...changed].sort(byCode)) {
    for (const dependent of getDescendants(nodes, id)) if (!via.has(dependent)) via.set(dependent, id);
  }
  return [...via].map(([id, from]) => ({ id, via: from })).sort((a, b) => byCode(a.id, b.id));
}

/** The input of `select`. */
export interface SelectInput {
  readonly base: string;
  readonly head: string;
  readonly files: readonly ChangedFile[];
  /** The workspace root from the repository root, with `/`. The value `""` is the repository root. */
  readonly root: string;
  readonly packages: readonly WorkspacePackage[];
  readonly jobs?: readonly JobRule[];
  readonly global?: readonly GlobalRule[];
  readonly repositoryGlobal?: readonly GlobalRule[];
}

/** This function gives the selection of a change. It is a pure function: `selectFromGit` reads git and gives it the data. */
export function select(input: SelectInput): Selection {
  const { base, head, files, packages } = input;
  const root = input.root.replace(/\/+$/, "");
  const prefix = root === "" ? "" : `${root}/`;
  const global = (input.global ?? GLOBAL_FILES).map((rule) => ({ ...rule, re: globToRegExp(rule.glob) }));
  const repositoryGlobal = (input.repositoryGlobal ?? REPOSITORY_GLOBAL_FILES).map((rule) => ({ ...rule, re: globToRegExp(rule.glob) }));
  const ids = packages.map((pkg) => pkg.id);
  const placed: (ChangedFile & { package: string | null })[] = [];
  const globals: FileReason[] = [];
  const unplaced: FileReason[] = [];
  for (const file of files) {
    const repositoryRule = repositoryGlobal.find((rule) => rule.re.test(file.path));
    if (repositoryRule !== undefined) {
      globals.push({ path: file.path, reason: repositoryRule.reason });
      placed.push({ ...file, package: null });
      continue;
    }
    if (!file.path.startsWith(prefix)) {
      unplaced.push({ path: file.path, reason: `the file is outside the workspace root ${root}` });
      placed.push({ ...file, package: null });
      continue;
    }
    const local = file.path.slice(prefix.length);
    const rule = global.find((item) => item.re.test(local));
    if (rule !== undefined) globals.push({ path: file.path, reason: rule.reason });
    else if (local.endsWith("/package.json") && (file.status === "A" || file.status === "D")) {
      // The graph of the head does not show the dependents of a removed package
      globals.push({ path: file.path, reason: file.status === "A" ? "a package comes into the workspace" : "a package goes out of the workspace" });
    }
    placed.push({ ...file, package: packageOf(local, ids) });
  }
  const everything = globals.length > 0 || unplaced.length > 0;
  const changed = [...new Set(placed.flatMap((file) => (file.package === null ? [] : [file.package])))].sort(byCode);
  const affected = everything ? packages.map((pkg) => ({ id: pkg.id, via: "everything" })) : affectedPackages(changed, packages);
  const affectedIds = new Set(affected.map((pkg) => pkg.id));
  const published = new Set(packages.filter((pkg) => !pkg.private).map((pkg) => pkg.id));
  const jobs = (input.jobs ?? SHARED_JOBS).map((job): JobChoice => {
    const reads = (id: string): boolean => job.packages === "all" || (job.packages === "published" && published.has(id));
    const choice = { workflow: job.workflow, job: job.job, packages: ids.filter((id) => reads(id) && affectedIds.has(id)) };
    if (globals.length > 0) return { ...choice, run: true, because: { kind: "global", files: globals.map((item) => item.path) } };
    if (unplaced.length > 0) return { ...choice, run: true, because: { kind: "unplaced", files: unplaced.map((item) => item.path) } };
    if (choice.packages.length > 0) return { ...choice, run: true, because: { kind: "packages", packages: choice.packages } };
    const patterns = job.paths.map((glob) => globToRegExp(glob));
    const hits = files.filter((file) => patterns.some((re) => re.test(file.path))).map((file) => file.path);
    if (hits.length > 0) return { ...choice, run: true, because: { kind: "paths", files: hits } };
    return { ...choice, run: false, because: { kind: "none" } };
  });
  return { format: SELECTION_FORMAT, base, head, everything, global: globals, unplaced, files: placed, packages: { all: ids, changed, affected }, jobs };
}

const code = (text: string): string => `\`${text}\``;

/** This function gives the lines of the summary of a selection, in Markdown. */
export function selectionSummary(record: Selection | SelectionNoRead): string[] {
  const lines = ["### Selection (shadow mode: each job still runs)", ""];
  if ("noRead" in record) return [...lines, `No read: ${record.noRead}`];
  const files = `${String(record.files.length)} changed ${record.files.length === 1 ? "file" : "files"}`;
  if (record.global.length > 0) lines.push(`${files}. A global file selects everything: ${record.global.map((item) => `${code(item.path)} (${item.reason})`).join(", ")}.`);
  else if (record.unplaced.length > 0) lines.push(`${files}. A file that the selector cannot place selects everything: ${record.unplaced.map((item) => `${code(item.path)} (${item.reason})`).join(", ")}.`);
  else {
    const list = record.packages.affected.map((pkg) => `${code(pkg.id)}${pkg.via === "changed" ? "" : ` (by ${code(pkg.via)})`}`).join(", ");
    lines.push(`${files}. The change affects ${String(record.packages.affected.length)} of ${String(record.packages.all.length)} packages: ${list || "none"}.`);
  }
  lines.push("", "| Job | Choice | Cause |", "| --- | --- | --- |");
  for (const job of record.jobs) {
    const cause = job.because;
    const text =
      cause.kind === "global" ? "a global file"
      : cause.kind === "unplaced" ? "a file that it cannot place"
      : cause.kind === "packages" ? `the packages ${cause.packages.map(code).join(", ")}`
      : cause.kind === "paths" ? `the files ${cause.files.map(code).join(", ")}`
      : "no file that the job reads";
    lines.push(`| ${job.job} | ${job.run ? "runs" : "skips"} | ${text} |`);
  }
  return lines;
}

/** The git command in a folder, as text. */
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/** This function gives the text of each path at a commit, with one git process. A path that the commit does not have is not in the map. */
function readAt(cwd: string, commit: string, paths: readonly string[]): Map<string, string> {
  const texts = new Map<string, string>();
  if (paths.length === 0) return texts;
  const input = paths.map((path) => `${commit}:${path}\n`).join("");
  const data = execFileSync("git", ["cat-file", "--batch"], { cwd, input, maxBuffer: 256 * 1024 * 1024 });
  let at = 0;
  for (const path of paths) {
    const end = data.indexOf(0x0a, at);
    if (end < 0) break;
    const header = data.subarray(at, end).toString("utf8");
    at = end + 1;
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (match === null) continue;
    const size = Number(match[1]);
    texts.set(path, data.subarray(at, at + size).toString("utf8"));
    at += size + 1;
  }
  return texts;
}

/** The input of `selectFromGit`. */
export interface GitSelectInput {
  /** The folder of the git checkout. */
  readonly cwd: string;
  /** The base commit. The value `""` is the first parent of HEAD: the checkout of a pull request is a merge commit. */
  readonly base: string;
  /** The head commit. The value `""` is the second parent of HEAD when the base is `""`, else HEAD. */
  readonly head: string;
  /** The workspace root from the repository root. The values `""` and `.` are the repository root. */
  readonly root: string;
  /** More global globs, relative to the workspace root. */
  readonly global?: readonly string[];
}

/** This function gives the selection of a change from git. It throws when git cannot read the change. */
export function selectFromGit(input: GitSelectInput): Selection {
  const { cwd } = input;
  const commit = (spec: string): string => git(cwd, "rev-parse", "--verify", "--quiet", `${spec}^{commit}`).trim();
  const base = commit(input.base === "" ? "HEAD^1" : input.base);
  const head = commit(input.head !== "" ? input.head : input.base === "" ? "HEAD^2" : "HEAD");
  const trimmed = input.root.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  const root = trimmed === "." ? "" : trimmed;
  const prefix = root === "" ? "" : `${root}/`;
  const diff = git(cwd, "diff", "--name-status", "--no-renames", "-z", `${base}...${head}`)
    .split("\0")
    .filter((part) => part !== "");
  const files: ChangedFile[] = [];
  for (let index = 0; index + 1 < diff.length; index += 2) files.push({ status: (diff[index] ?? "").charAt(0), path: diff[index + 1] ?? "" });
  const tree = git(cwd, "ls-tree", "-r", "-z", "--name-only", "--full-tree", head, "--", root === "" ? "." : root)
    .split("\0")
    .filter((path) => path !== "");
  const manifests = tree.filter((path) => path.startsWith(prefix) && (path === `${prefix}package.json` || path.endsWith("/package.json")));
  const texts = readAt(cwd, head, [`${prefix}pnpm-workspace.yaml`, ...manifests]);
  const local = new Map<string, string>();
  for (const path of manifests) {
    const text = texts.get(path);
    if (text !== undefined) local.set(path.slice(prefix.length), text);
  }
  const extra = (input.global ?? []).map((glob) => ({ glob, reason: "a global file of the input global" }));
  return select({ base, head, files, root, packages: readWorkspace(texts.get(`${prefix}pnpm-workspace.yaml`), local), global: [...GLOBAL_FILES, ...extra] });
}

/**
 * This function is the entry of the action `select`. It reads its input from the environment, and writes the record and
 * the summary. It gives the exit code 0, also when it cannot read the change.
 */
export function runSelect(env: Readonly<Record<string, string | undefined>>, cwd: string, now: () => number): number {
  let result: Selection | SelectionNoRead;
  try {
    const global = (env["GLOBAL"] ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    result = selectFromGit({ cwd, base: env["BASE_SHA"] ?? "", head: env["HEAD_SHA"] ?? "", root: env["ROOT"] ?? "", global });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { format: SELECTION_FORMAT, noRead: message.split("\n")[0] ?? message };
  }
  const lines = selectionSummary(result);
  const record: SelectionRecord = { ...result, ref: env["SELECTOR_REF"] ?? "", durationMs: Math.round(now()) };
  const out = env["OUT"] ?? "";
  if (out !== "") {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  const summary = env["GITHUB_STEP_SUMMARY"] ?? "";
  if (summary !== "") appendFileSync(summary, `${lines.join("\n")}\n`);
  return 0;
}
