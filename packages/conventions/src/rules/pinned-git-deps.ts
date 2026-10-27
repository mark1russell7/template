/**
 * The rule `pinned-git-deps`: a dependency from git names a full commit.
 */
import { DEPENDENCY_FIELDS, keyLine, specifiersOf, type Break, type Manifest, type Rule } from "../rule.ts";

/** The fields of the root `package.json` that replace the specifiers of dependencies. */
const OVERRIDE_FIELDS = ["overrides", "resolutions"] as const;

/** This function tells if a specifier gets the package from git, not from a registry or the workspace. */
export function isGitSpecifier(spec: string): boolean {
  const value = spec.trim();
  if (/^(github|gitlab|bitbucket|gist):/i.test(value)) return true;
  if (/^git(\+[a-z]+)?:/i.test(value) || /^git@/i.test(value)) return true;
  if (/^https?:\/\/(www\.)?(github\.com|gitlab\.com|bitbucket\.org|codeload\.github\.com)\//i.test(value)) return true;
  // npm and pnpm read `owner/repo` and `owner/repo#ref` as a GitHub repository
  return /^[\w-][\w.-]*\/[\w.-]+(#.*)?$/.test(value) && !value.startsWith("@");
}

/**
 * This function tells if a git specifier names a commit. A specifier names a commit when its ref
 * (after `#`) is a commit SHA, or when a tarball URL has the SHA in its path.
 */
export function isPinned(spec: string, fullSha: boolean): boolean {
  const sha = fullSha ? /^[0-9a-f]{40}$/i : /^[0-9a-f]{7,40}$/i;
  const hash = spec.indexOf("#");
  if (hash >= 0) {
    // pnpm also knows `#commit=<sha>`, and `&` joins the parts of a ref
    const parts = spec.slice(hash + 1).split("&");
    return parts.some((part) => sha.test(part.replace(/^commit=/, "")));
  }
  const path = /^https?:\/\/[^/]+\/(.*)$/i.exec(spec.trim())?.[1];
  return path !== undefined && path.split(/[/.]/).some((part) => sha.test(part));
}

/** This function gives the specifiers of the fields of overrides, also the field `overrides` of `pnpm`. */
function overridesOf(manifest: Manifest): [string, string, string][] {
  const out: [string, string, string][] = [];
  for (const field of OVERRIDE_FIELDS) for (const [name, spec] of specifiersOf(manifest, field)) out.push([field, name, spec]);
  const pnpm = manifest["pnpm"];
  if (typeof pnpm === "object" && pnpm !== null) for (const [name, spec] of specifiersOf(pnpm as Manifest, "overrides")) out.push(["pnpm", name, spec]);
  return out;
}

export const pinnedGitDeps: Rule = {
  id: "pinned-git-deps",
  title: "A dependency from git (github:, git+https: or owner/repo) names a full commit SHA.",
  reason:
    "A git ref without a commit moves with the branch. Then an install today and an install tomorrow get different code, and the lockfile hides the change.",
  fix: 'Use the npm version, `workspace:*` for a package of this repository, or `github:owner/repo#<full commit SHA>`.',
  sources: [
    { repo: "coeval", rule: "pinned-deps", doc: "CLAUDE.md:41" },
    { repo: "coeval", rule: "unpublished-dep-pinned", doc: "CLAUDE.md:41" },
    { repo: "headroom", rule: "non-npm-deps-pinned", doc: "CLAUDE.md:38" },
    { repo: "headroom", rule: "pinned-github-specifier", doc: "CLAUDE.md:38" },
    { repo: "Graph", rule: "github-dep-full-sha", doc: "docs/decisions.md:1384" },
    { repo: "Graph", rule: "github-dep-pinned", doc: "docs/decisions.md:1384" },
    { repo: "client", rule: "general-npm-version", doc: "CLAUDE.md:54" },
  ],
  options: {
    fullSha: { type: "boolean", default: true, description: "When false, a short SHA of 7 or more characters is also a commit." },
  },
  check(context, options) {
    const fullSha = options["fullSha"] !== false;
    const breaks: Break[] = [];
    for (const info of [context.rootPackage, ...context.packages]) {
      const found: [string, string, string][] = [];
      for (const field of DEPENDENCY_FIELDS) for (const [name, spec] of specifiersOf(info.manifest, field)) found.push([field, name, spec]);
      found.push(...overridesOf(info.manifest));
      for (const [field, name, spec] of found) {
        if (!isGitSpecifier(spec) || isPinned(spec, fullSha)) continue;
        const line = keyLine(info.text, field, name);
        breaks.push({
          file: info.file,
          ...(line === undefined ? {} : { line }),
          message: `${field} "${name}" is "${spec}": a git dependency without a ${fullSha ? "full " : ""}commit SHA.`,
        });
      }
    }
    return breaks;
  },
};
