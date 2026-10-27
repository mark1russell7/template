/**
 * The rule `source-main`: a workspace package is a source package, and a public package moves its
 * entries to the build when it is published.
 */
import { cleanPath, codePackages, lineOf, type Break, type Manifest, type Rule } from "../rule.ts";

/** The fields of `package.json` that name the entries of a package. */
const ENTRY_FIELDS = ["main", "module", "types", "typings", "exports", "bin"] as const;

/** This function gives each path in the value of an entry field (a string, or the strings in an object). */
export function pathsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(pathsOf);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(pathsOf);
  return [];
}

/** This function tells if a path is a source file: a file in `src/`, or a TypeScript file that is not a declaration file. */
export function isSourcePath(path: string): boolean {
  const clean = cleanPath(path);
  return clean.startsWith("src/") || (/\.(c|m)?tsx?$/.test(clean) && !/\.d\.(c|m)?ts$/.test(clean));
}

export const sourceMain: Rule = {
  id: "source-main",
  title: "Each workspace package is a source package (`main` is `src/index.ts`), and a public package moves its entries to the build in `publishConfig`.",
  reason:
    "Other packages of the workspace import the source, so a change is visible at once with no build. A public package that publishes its source entries gives TypeScript files to npm users.",
  fix: 'Set `"main": "./src/index.ts"`. In a public package, add `publishConfig` with main, types, exports and bin that point at the build, as `pnpm package add` does.',
  sources: [
    { repo: "coeval", rule: "package-main-source", doc: "CLAUDE.md:17" },
    { repo: "coeval", rule: "source-package-main", doc: "CLAUDE.md:17" },
    { repo: "crawler", rule: "pkg-source-main", doc: "CLAUDE.md:17" },
    { repo: "crawler", rule: "source-package-main", doc: "CLAUDE.md:17" },
    { repo: "crawler", rule: "publish-config-build", doc: "CLAUDE.md:41" },
    { repo: "Graph", rule: "new-package-main-index", doc: "CLAUDE.md:15" },
    { repo: "Graph", rule: "source-package-main", doc: "CLAUDE.md:15" },
    { repo: "headroom", rule: "source-package-main", doc: "CLAUDE.md:31" },
  ],
  options: {
    main: { type: "string", default: "src/index.ts", description: "The path of `main` in each package." },
    publishConfig: { type: "boolean", default: true, description: "When false, the rule does not examine `publishConfig`." },
  },
  check(context, options) {
    const main = cleanPath(typeof options["main"] === "string" ? options["main"] : "src/index.ts");
    const breaks: Break[] = [];
    for (const info of codePackages(context)) {
      // The root of a repository of one package has no workspace that imports its source, so only its publishConfig counts
      const single = info.folder === "";
      const manifest = info.manifest;
      const at = (field: string): { line?: number } => {
        const line = lineOf(info.text, `"${field}"`);
        return line === undefined ? {} : { line };
      };
      const value = manifest["main"];
      if (single) {
        // The root of a repository of one package can point main at its build
      } else if (typeof value === "string") {
        if (cleanPath(value) !== main) breaks.push({ file: info.file, ...at("main"), message: `"main" is "${value}", not "./${main}".` });
      } else if (ENTRY_FIELDS.some((field) => manifest[field] !== undefined) || manifest["private"] !== true) {
        // A package with only a bin (a CLI) has no entry to import, and a private package with no entry is an app (a site)
        if (manifest["bin"] === undefined) breaks.push({ file: info.file, ...at("name"), message: `The package has no "main". A source package has "main": "./${main}".` });
      }
      if (options["publishConfig"] === false || manifest["private"] === true) continue;
      const published = (typeof manifest["publishConfig"] === "object" && manifest["publishConfig"] !== null ? manifest["publishConfig"] : {}) as Manifest;
      for (const field of ENTRY_FIELDS) {
        const source = pathsOf(manifest[field]).filter(isSourcePath);
        if (source.length === 0) continue;
        if (published[field] === undefined) {
          breaks.push({
            file: info.file,
            ...at(field),
            message: `"${field}" points at the source (${source[0] ?? ""}), and publishConfig has no "${field}": npm users get the source.`,
            fix: `Add publishConfig.${field} that points at the build.`,
          });
          continue;
        }
        const still = pathsOf(published[field]).filter(isSourcePath);
        if (still.length > 0) {
          breaks.push({ file: info.file, ...at("publishConfig"), message: `publishConfig.${field} points at the source (${still[0] ?? ""}).`, fix: `Point publishConfig.${field} at the build.` });
        }
      }
    }
    return breaks;
  },
};
