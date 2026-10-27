/**
 * The rule `tsconfig-test`: each TypeScript package has a `tsconfig.test.json`, and its typecheck
 * examines it.
 */
import { hasFile, inFolder, lineOf, type Break, type Rule } from "../rule.ts";

export const tsconfigTest: Rule = {
  id: "tsconfig-test",
  title: "Each package with a `tsconfig.json` has a `tsconfig.test.json`, and its `typecheck` script examines it.",
  reason: "The build config leaves out the tests. Without a second config, `pnpm typecheck` does not examine the tests, and a type error in a test hides until the test runs.",
  fix: "Add `tsconfig.test.json` (extends `./tsconfig.json`, includes the tests, `noEmit`), and set the script `typecheck` to `tsc -p tsconfig.json && tsc -p tsconfig.test.json`.",
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
    if (context.packages.length === 0) return { skipped: "the repository has no workspace packages" };
    const file = typeof options["file"] === "string" ? options["file"] : "tsconfig.test.json";
    const breaks: Break[] = [];
    for (const info of context.packages) {
      if (!hasFile(info.dir, "tsconfig.json")) continue;
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
