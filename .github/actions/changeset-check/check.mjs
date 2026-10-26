// The changeset check of a pull request (action.yml). Each published package that the pull request
// changes must have a changeset, so that its next release has the right version and a CHANGELOG
// line. evaluate() has the rules and no I/O, so the tests call it directly
// (scripts/workflows/changeset-check.test.mjs). main() reads git and the event.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_IGNORE = [
  "**/*.md",
  "**/*.test.*",
  "**/*.spec.*",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/fixtures/**",
];

// package.json fields that do not go into the published package's behavior.
const DEV_ONLY_FIELDS = ["devDependencies", "scripts", "packageManager", "devEngines", "pnpm"];

const BUMPS = ["patch", "minor", "major"];

/** A glob with "**", "*" and "?" as a RegExp of the whole path. */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" matches zero or more folders
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** The packages of a changeset file: { name: bump }. An empty front matter is a changeset with no release. */
export function parseChangeset(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n?---/.exec(text);
  if (!match) throw new Error("it has no front matter (--- ... ---)");
  const releases = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const m = /^["']?([^"':]+)["']?\s*:\s*["']?(\w+)["']?$/.exec(line);
    if (!m) throw new Error(`the line "${line}" is not "<package>": <patch|minor|major>`);
    if (!BUMPS.includes(m[2])) throw new Error(`"${m[2]}" for ${m[1]} is not patch, minor or major`);
    releases[m[1]] = m[2];
  }
  return releases;
}

/** True when the change of a package.json touches more than the fields of the development. */
export function packageJsonChanged(before, after) {
  if (before === undefined || after === undefined) return true;
  const strip = (pkg) => {
    const copy = { ...pkg };
    for (const field of DEV_ONLY_FIELDS) delete copy[field];
    return JSON.stringify(copy);
  };
  return strip(before) !== strip(after);
}

/**
 * The rules. Input:
 * - packages: [{ name, dir, version, private }] (dir "." is the root)
 * - changedFiles: [path] (paths from the root, with "/")
 * - packageJsonChanges: { path: boolean } for the changed package.json files (packageJsonChanged)
 * - changesets: [{ file, releases }] or [{ file, error }] for the changeset files that the pull request adds or changes
 * - headRef, labels, ignore, fixed (the "fixed" groups of .changeset/config.json)
 * Output: { skipped?, errors: [string], rows: [{ name, changed, bump }], notes: [string] }
 */
export function evaluate({
  packages,
  changedFiles,
  packageJsonChanges = {},
  changesets,
  headRef = "",
  labels = [],
  ignore = DEFAULT_IGNORE,
  fixed = [],
}) {
  if (headRef.startsWith("changeset-release/")) return { skipped: "the version pull request of changesets", errors: [], rows: [], notes: [] };
  if (labels.includes("no-changeset")) return { skipped: 'the label "no-changeset"', errors: [], rows: [], notes: [] };

  const errors = [];
  const notes = [];
  const ignored = ignore.map(globToRegExp);
  const published = packages.filter((p) => !p.private && p.name);
  const byName = new Map(packages.map((p) => [p.name, p]));
  // The deepest package folder that holds the file. A file of a private package belongs to no published package.
  const owner = (file) => {
    let best;
    for (const p of packages) {
      const inside = p.dir === "." || file === p.dir || file.startsWith(`${p.dir}/`);
      if (inside && (!best || p.dir.length > best.dir.length)) best = p;
    }
    return best && !best.private ? best : undefined;
  };

  const changed = new Set();
  for (const file of changedFiles) {
    if (file.startsWith(".changeset/")) continue;
    const pkg = owner(file);
    if (!pkg) continue;
    const local = pkg.dir === "." ? file : file.slice(pkg.dir.length + 1);
    if (ignored.some((re) => re.test(file) || re.test(local))) continue;
    if (posix.basename(file) === "package.json" && local === "package.json" && packageJsonChanges[file] === false) continue;
    changed.add(pkg.name);
  }

  const bumps = new Map();
  let emptyChangeset = false;
  for (const cs of changesets) {
    if (cs.error) {
      errors.push(`${cs.file}: ${cs.error}.`);
      continue;
    }
    const names = Object.keys(cs.releases);
    if (names.length === 0) emptyChangeset = true;
    for (const name of names) {
      const bump = cs.releases[name];
      const pkg = byName.get(name);
      if (!pkg) {
        errors.push(`${cs.file}: the repository has no package "${name}".`);
        continue;
      }
      const prev = bumps.get(name);
      if (!prev || BUMPS.indexOf(bump) > BUMPS.indexOf(prev)) bumps.set(name, bump);
      // changesets makes 1.0.0 from a major of a 0.x version. Only a decided 1.0 release may do that.
      if (bump === "major" && /^0\./.test(pkg.version ?? "") && !labels.includes("release-1.0")) {
        errors.push(
          `${cs.file}: "${name}": major makes ${pkg.version} into 1.0.0. Before 1.0, a breaking change is a minor. For a decided 1.0 release, add the label "release-1.0".`,
        );
      }
    }
  }

  // In a fixed group, one changeset of a member sets the version of all members. The other changed
  // members get a note, not an error: their release is right, only their CHANGELOG line is missing.
  const groupOf = (name) => fixed.find((group) => group.includes(name));
  const coveredByGroup = [...changed].filter((name) => !bumps.has(name) && groupOf(name)?.some((m) => bumps.has(m))).sort();
  if (coveredByGroup.length > 0) {
    notes.push(`The changesets of the fixed group also release ${coveredByGroup.join(", ")}. Name them in a changeset for a CHANGELOG line of their own.`);
  }
  const missing = [...changed].filter((name) => !bumps.has(name) && !coveredByGroup.includes(name)).sort();
  if (missing.length > 0 && !emptyChangeset) {
    errors.push(
      `These published packages change and have no changeset: ${missing.join(", ")}. Add one with "pnpm changeset" (patch, minor or major). ` +
        'For a change with no release, add an empty changeset ("pnpm changeset --empty") or the label "no-changeset".',
    );
  }
  if (missing.length > 0 && emptyChangeset) notes.push(`An empty changeset says that ${missing.join(", ")} need no release.`);

  for (const group of fixed) {
    const members = group.filter((name) => byName.has(name));
    const groupBump = members.map((n) => bumps.get(n)).filter(Boolean).sort((a, b) => BUMPS.indexOf(b) - BUMPS.indexOf(a))[0];
    if (!groupBump) continue;
    const version = byName.get(members[0])?.version ?? "";
    const breaking = /^0\./.test(version) ? groupBump !== "patch" : groupBump === "major";
    notes.push(
      `The fixed group of ${members.length} packages (${members[0]} ...) gets a ${groupBump} release from ${version}` +
        (breaking ? ": a breaking change. The CHANGELOG needs a migration note." : "."),
    );
  }

  const rows = [...new Set([...changed, ...bumps.keys()])]
    .sort()
    .map((name) => ({ name, changed: changed.has(name), bump: bumps.get(name) ?? "" }));
  return { errors, rows, notes, publishedCount: published.length };
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function readJsonAt(ref, path) {
  try {
    return JSON.parse(git("show", `${ref}:${path}`));
  } catch {
    return undefined;
  }
}

export function main(env = process.env) {
  const base = env.BASE_SHA;
  const head = env.HEAD_SHA;
  if (!base || !head) throw new Error("BASE_SHA and HEAD_SHA are needed (the check runs on pull requests).");
  const dir = env.CHANGESET_DIR || ".changeset";
  // Everything is read at the head commit of the pull request, not from the working tree.
  const config = readJsonAt(head, `${dir}/config.json`);
  if (!config) {
    console.log(`${dir}/config.json does not exist: the repository does not use changesets. The check passes.`);
    return 0;
  }
  const range = `${base}...${head}`;
  const changedFiles = git("diff", "--name-only", "--no-renames", range).split("\n").filter(Boolean);
  const csFiles = git("diff", "--name-only", "--no-renames", "--diff-filter=AM", range, "--", `${dir}/*.md`)
    .split("\n")
    .filter((f) => f && posix.basename(f).toLowerCase() !== "readme.md");

  const packages = git("ls-tree", "-r", "--name-only", head)
    .split("\n")
    .filter((f) => posix.basename(f) === "package.json" && !f.split("/").includes("node_modules"))
    .map((file) => {
      const pkg = readJsonAt(head, file) ?? {};
      return { name: pkg.name, version: pkg.version, private: pkg.private === true, dir: dirname(file).replace(/\\/g, "/") };
    })
    .filter((p) => p.name);

  const packageJsonChanges = {};
  for (const file of changedFiles.filter((f) => posix.basename(f) === "package.json")) {
    packageJsonChanges[file] = packageJsonChanged(readJsonAt(base, file), readJsonAt(head, file));
  }
  const changesets = csFiles.map((file) => {
    try {
      return { file, releases: parseChangeset(git("show", `${head}:${file}`)) };
    } catch (error) {
      return { file, error: error.message };
    }
  });
  const extra = (env.IGNORE ?? "").split(/\s+/).filter(Boolean);
  const result = evaluate({
    packages,
    changedFiles,
    packageJsonChanges,
    changesets,
    headRef: env.HEAD_REF ?? "",
    labels: JSON.parse(env.LABELS || "[]"),
    ignore: [...DEFAULT_IGNORE, ...extra],
    fixed: config.fixed ?? [],
  });

  const summary = [];
  if (result.skipped) {
    summary.push(`### Changesets\n\nThe check skips ${result.skipped}.`);
    console.log(`The check skips ${result.skipped}.`);
  } else {
    summary.push("### Changesets", "", "| Package | Changed | Changeset |", "|---|---|---|");
    for (const row of result.rows) summary.push(`| \`${row.name}\` | ${row.changed ? "yes" : "no"} | ${row.bump || "none"} |`);
    if (result.rows.length === 0) summary.push("| (no published package changes) | | |");
    for (const note of result.notes) {
      summary.push("", note);
      console.log(note);
    }
    for (const error of result.errors) console.log(`::error::${error}`);
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
  return result.errors.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main();
