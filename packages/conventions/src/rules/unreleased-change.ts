/**
 * The rule `unreleased-change`: a change of the files that a published package ships also raises its version, when npm
 * has that version already. Else the release workflow skips the version, and the change does not get to npm.
 */
import { spawnSync } from "node:child_process";
import { rangeOf } from "../change.ts";
import { cleanPath, codePackages, hasFile, lineOf, matchesAny, type Break, type Manifest, type PackageInfo, type Rule, type RuleContext } from "../rule.ts";

/** The answer of the registry for one package: each version that npm has or had (none for a new package), or an error. */
export type RegistryAnswer = { readonly versions: readonly string[] } | { readonly error: string };

/** This function gives the answer of the registry at the URL `registry` for each package name of `names`. */
export type RegistryLookup = (names: readonly string[], registry: string) => ReadonlyMap<string, RegistryAnswer>;

/** The registry of npm. */
export const NPM_REGISTRY = "https://registry.npmjs.org";

/** The globs of the files of a package, relative to its folder, that do not ship: tests, fixtures, docs and configs. */
export const UNSHIPPED_FILES: readonly string[] = [
  "**/*.md",
  "**/*.{test,spec}.*",
  "**/{test,tests,__tests__,fixtures,__fixtures__,__snapshots__,bench,benches,benchmarks,e2e}/**",
  "**/*.{bench,e2e}.*",
  "**/.*/**",
  "**/tsconfig*.json",
  "**/*.config.*",
  "docs/**",
  "examples/**",
  "scripts/**",
  "site/**",
  "LICENSE*",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
];

/** The fields of `package.json` that change what the package gives to a user. A change of the dependencies is not here. */
export const SHIPPED_FIELDS: readonly string[] = ["main", "module", "types", "typings", "exports", "imports", "bin", "files", "type", "publishConfig", "sideEffects", "browser"];

/** The script that `npmLookup` starts in a child process of Node, so that the rule stays synchronous. */
const LOOKUP_SCRIPT = `
const [registry, ...names] = process.argv.slice(1);
const base = registry.replace(/\\/+$/, "");
Promise.all(names.map(async (name) => {
  try {
    const response = await fetch(base + "/" + name.replace("/", "%2f"), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (response.status === 404) return [name, { versions: [] }];
    if (!response.ok) return [name, { error: "HTTP " + response.status }];
    const data = await response.json();
    const times = Object.keys(data.time ?? {}).filter((key) => key !== "created" && key !== "modified");
    return [name, { versions: [...new Set([...Object.keys(data.versions ?? {}), ...times])] }];
  } catch (error) {
    return [name, { error: String(error && error.message ? error.message : error) }];
  }
})).then((entries) => process.stdout.write(JSON.stringify(Object.fromEntries(entries))));
`;

/**
 * This function asks the registry for the versions of each package, in one child process of Node. A version that npm
 * removed stays in the answer, because npm does not accept it again.
 */
export const npmLookup: RegistryLookup = (names, registry) => {
  const fail = (error: string): ReadonlyMap<string, RegistryAnswer> => new Map(names.map((name) => [name, { error }]));
  if (names.length === 0) return new Map();
  const result = spawnSync(process.execPath, ["-e", LOOKUP_SCRIPT, registry, ...names], { encoding: "utf8", timeout: 60_000, windowsHide: true });
  if (result.error !== undefined || result.status !== 0) return fail(result.error?.message ?? `the lookup ended with exit code ${String(result.status)}`);
  try {
    const answers = JSON.parse(result.stdout) as Record<string, RegistryAnswer>;
    return new Map(names.map((name) => [name, answers[name] ?? { error: "no answer" }]));
  } catch {
    return fail("the lookup gave no JSON");
  }
};

/** A published package of the change: its name, its version at HEAD and at the start of the change, and its shipped changed files. */
interface Candidate {
  readonly pkg: PackageInfo;
  readonly name: string;
  readonly version: string;
  readonly before: string | undefined;
  readonly files: readonly string[];
}

/** This function gives the strings of a field of `package.json` that is a list of strings. */
const stringsOf = (manifest: Manifest, field: string): readonly string[] => {
  const value = manifest[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
};

/** This function tells if a path relative to the root is in the folder `folder`. The root is `""`. */
const inside = (folder: string, path: string): boolean => folder === "" || path.startsWith(`${folder}/`);

/** This function gives the globs of an entry of the field `files`: the entry, and each path under it. */
const entryGlobs = (entry: string): readonly string[] => {
  const glob = cleanPath(entry).replace(/\/+$/, "");
  return [glob, `${glob}/**`];
};

/** This function reads the manifest of the text of a `package.json` file, or gives undefined. */
function parseManifest(text: string | undefined): Manifest | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

/** This function tells if a version is a placeholder before the first release: `0.0.0` or `0.0.0-<stage>`. */
const isPlaceholder = (version: string): boolean => /^0\.0\.0(?:[-+].*)?$/.test(version);

/** The published packages of the repository: the root package and the code packages that are not private and have a name and a version. */
function publishedOf(context: RuleContext): readonly PackageInfo[] {
  const all = [context.rootPackage, ...codePackages(context)];
  return all
    .filter((pkg, index) => all.findIndex((other) => other.file === pkg.file) === index)
    .filter((pkg) => pkg.manifest["private"] !== true && typeof pkg.manifest["name"] === "string" && typeof pkg.manifest["version"] === "string");
}

/** This function makes the rule with the registry lookup `lookup`. The tests give a fake lookup. */
export function unreleasedChangeRule(lookup: RegistryLookup = npmLookup): Rule {
  return {
    id: "unreleased-change",
    title: "A change of the files that a published package ships raises its version, when npm has that version already.",
    reason:
      "The release workflow publishes each version that npm does not have, and it skips the others. When two pull requests set the same version, the second merge changes the code but no version: the release does not publish it, and nothing fails (rigor #18 and #20, 2026-11-02).",
    fix: "Raise the version of the package in a pull request, with the SemVer rules (RELEASING.md). Then the release workflow publishes the change.",
    sources: [
      { repo: "rigor", rule: "unreleased-change", doc: "pull requests #18 and #20 (2026-11-02): two pull requests set the same version" },
      ...["crawler", "coeval", "template"].map((repo) => ({ repo, rule: "unreleased-change", doc: ".github/workflows/release.yml (it starts on a change of a version, and it skips each version that npm has)" })),
    ],
    options: {
      unshipped: {
        type: "strings",
        default: UNSHIPPED_FILES,
        description: "The globs of the files of a package, relative to its folder, that do not ship. A change of only these files needs no release.",
      },
      fields: {
        type: "strings",
        default: SHIPPED_FIELDS,
        description: "The fields of `package.json` whose change ships. A change of only the other fields (for example the dependencies) needs no release.",
      },
      registry: { type: "string", default: NPM_REGISTRY, description: "The URL of the registry that has the versions." },
    },
    check(context, options) {
      if (hasFile(context.root, ".changeset/config.json")) return { skipped: "the repository uses Changesets: the changesets raise the versions, and the changeset check examines them" };
      const published = publishedOf(context).filter((pkg) => !isPlaceholder(String(pkg.manifest["version"])));
      if (published.length === 0) return { skipped: "the repository has no published package with a release version" };
      const range = rangeOf(context, { push: true });
      if ("skipped" in range) return range;
      const out = context.git(["diff", "--name-only", "--no-renames", ...range.diff]);
      if (out === undefined) return { skipped: "git cannot give the changed files of the change" };
      const changed = out.split(/\r?\n/).filter((file) => file !== "");
      const unshipped = Array.isArray(options["unshipped"]) ? (options["unshipped"] as readonly string[]) : UNSHIPPED_FILES;
      const fields = Array.isArray(options["fields"]) ? (options["fields"] as readonly string[]) : SHIPPED_FIELDS;
      const registry = typeof options["registry"] === "string" ? options["registry"] : NPM_REGISTRY;
      const tracked = context.gitFiles() ?? [];
      const folders = context.packages.map((pkg) => pkg.folder).filter((folder) => folder !== "");

      const candidates: Candidate[] = [];
      for (const pkg of published) {
        // The root package does not have the files of the packages of the workspace
        const own = (path: string): boolean => inside(pkg.folder, path) && (pkg.folder !== "" || !folders.some((folder) => inside(folder, path)));
        const relative = (path: string): string => (pkg.folder === "" ? path : path.slice(pkg.folder.length + 1));
        // An entry of `files` that git does not track is build output, which comes from each source file
        const entries = stringsOf(pkg.manifest, "files");
        const positive = entries.filter((entry) => !entry.startsWith("!"));
        const negative = entries.filter((entry) => entry.startsWith("!")).flatMap((entry) => entryGlobs(entry.slice(1)));
        const ownTracked = tracked.filter(own).map(relative);
        const whitelist = positive.length > 0 && positive.every((entry) => ownTracked.some((path) => matchesAny(path, entryGlobs(entry))));
        const ships = (path: string): boolean =>
          path !== "package.json" &&
          !matchesAny(path, unshipped) &&
          (!whitelist || (positive.some((entry) => matchesAny(path, entryGlobs(entry))) && !matchesAny(path, negative)));
        const files = changed.filter(own).map(relative).filter(ships);
        const beforeText = context.git(["show", `${range.ends[0]}:${pkg.file}`]);
        const beforeManifest = parseManifest(beforeText);
        if (changed.includes(pkg.file) && beforeManifest !== undefined && fields.some((field) => JSON.stringify(beforeManifest[field]) !== JSON.stringify(pkg.manifest[field]))) {
          files.push("package.json");
        }
        if (files.length === 0) continue;
        const before = typeof beforeManifest?.["version"] === "string" ? beforeManifest["version"] : undefined;
        candidates.push({ pkg, name: String(pkg.manifest["name"]), version: String(pkg.manifest["version"]), before, files });
      }
      if (candidates.length === 0) return [];

      const answers = lookup(
        candidates.map((candidate) => candidate.name),
        registry,
      );
      // On a push, a version that the push changes can be on npm already: the release of the same push published it
      const push = context.base === undefined && context.env["GITHUB_EVENT_NAME"] === "push";
      const breaks: Break[] = [];
      const errors: string[] = [];
      for (const candidate of candidates) {
        const answer = answers.get(candidate.name) ?? { error: "no answer" };
        if ("error" in answer) {
          errors.push(`${candidate.name}: ${answer.error}`);
          continue;
        }
        if (!answer.versions.includes(candidate.version)) continue;
        const raised = candidate.before !== candidate.version;
        if (raised && push) continue;
        const shown = candidate.files.slice(0, 3).map((file) => (candidate.pkg.folder === "" ? file : `${candidate.pkg.folder}/${file}`));
        const more = candidate.files.length > shown.length ? ` and ${String(candidate.files.length - shown.length)} more` : "";
        const line = lineOf(candidate.pkg.text, '"version"');
        breaks.push({
          file: candidate.pkg.file,
          ...(line === undefined ? {} : { line }),
          message: raised
            ? `${candidate.name}: the change sets the version ${candidate.version}, but ${candidate.version} is on npm already. Raise the version (SemVer) in a pull request. The change ships ${shown.join(", ")}${more}.`
            : `${candidate.name}: the change is not released, because ${candidate.version} is on npm already. Raise the version (SemVer) in a pull request. The change ships ${shown.join(", ")}${more}.`,
        });
      }
      if (breaks.length === 0 && errors.length > 0) return { skipped: `the registry did not answer, so the rule cannot tell if npm has the versions: ${errors.join("; ")}` };
      return breaks;
    },
  };
}

export const unreleasedChange: Rule = unreleasedChangeRule();
