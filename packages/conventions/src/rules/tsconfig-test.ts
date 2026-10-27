/**
 * The rule `tsconfig-test`: each TypeScript package has a `tsconfig.test.json`, and its typecheck
 * examines it.
 */
import { codePackages, hasFile, inFolder, lineOf, type Break, type Rule } from "../rule.ts";

/** The path of a test file: `*.test.*` or `*.spec.*` of JavaScript or TypeScript, or a file in a folder `__tests__`. */
const TEST_FILE = /(?:^|\/)(?:[^/]+\.(?:test|spec)\.[cm]?[jt]sx?|__tests__\/.+)$/;

/** This function tells if git tracks a test file in the package folder `folder` (`""` is the root). */
export function hasTests(files: readonly string[], folder: string): boolean {
  const prefix = folder === "" ? "" : `${folder}/`;
  return files.some((path) => path.startsWith(prefix) && TEST_FILE.test(path.slice(prefix.length)));
}

export const tsconfigTest: Rule = {
  id: "tsconfig-test",
  title: "Each package with a `tsconfig.json` and test files has a `tsconfig.test.json`, and its `typecheck` script examines it.",
  reason: "The build config leaves out the tests. Without a second config, `pnpm typecheck` does not examine the tests, and a type error in a test hides until the test runs.",
  fix: "Add `tsconfig.test.json` (extends `./tsconfig.json`, includes the tests, `noEmit`), and set the script `typecheck` to `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json`. Keep `--noEmit` on the first call when the build config emits, so that a typecheck writes no build output.",
  sources: [
    { repo: "coeval", rule: "package-tsconfig-test", doc: "CLAUDE.md:18" },
    { repo: "coeval", rule: "tsconfig-test", doc: "CLAUDE.md:18" },
    { repo: "crawler", rule: "pkg-tsconfig-test", doc: "CLAUDE.md:18" },
    { repo: "crawler", rule: "tsconfig-test", doc: "CLAUDE.md:18" },
    { repo: "headroom", rule: "tsconfig-test", doc: "CLAUDE.md:32" },
    { repo: "headroom", rule: "tsconfig-test-per-package", doc: "CLAUDE.md:32" },
    { repo: "Vex", rule: "package-tsconfig-test", doc: "CLAUDE.md:23" },
    { repo: "Vex", rule: "tsconfig-test", doc: "CLAUDE.md:23" },
  ],
  options: {
    file: { type: "string", default: "tsconfig.test.json", description: "The name of the config of the tests." },
  },
  check(context, options) {
    const file = typeof options["file"] === "string" ? options["file"] : "tsconfig.test.json";
    const tracked = context.gitFiles();
    const breaks: Break[] = [];
    for (const info of codePackages(context)) {
      if (!hasFile(info.dir, "tsconfig.json")) continue;
      // A package with no test file has no test to examine. Outside git the rule cannot tell, so it examines the package
      if (tracked !== undefined && !hasTests(tracked, info.folder)) continue;
      if (!hasFile(info.dir, file)) {
        breaks.push({ file: inFolder(info.folder, file), message: `The package has a tsconfig.json and no ${file}.` });
        continue;
      }
      const scripts = info.manifest["scripts"];
      const typecheck = typeof scripts === "object" && scripts !== null ? (scripts as Record<string, unknown>)["typecheck"] : undefined;
      if (typeof typecheck === "string" && !typecheck.includes(file)) {
        const line = lineOf(info.text, '"typecheck"');
        breaks.push({
          file: info.file,
          ...(line === undefined ? {} : { line }),
          message: `The script typecheck ("${typecheck}") does not examine ${file}.`,
          fix: `Add \`tsc -p ${file}\` to the script typecheck.`,
        });
      }
    }
    return breaks;
  },
};
