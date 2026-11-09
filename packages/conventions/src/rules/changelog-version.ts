/**
 * The rule `changelog-version`: the top release section of the changelog of a package is not above the version of
 * its `package.json`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, parseChangelog } from "@mark1russell7/site-pages";
import { versionedPackages, type Break, type Rule } from "../rule.ts";

/** This function gives the version and the line (from 1) of the first version section of a changelog, or undefined. */
function topSection(text: string): { readonly version: string; readonly line: number } | undefined {
  const top = parseChangelog(text)[0];
  if (top === undefined) return undefined;
  const index = text.split(/\r?\n/).findIndex((line) => /^##\s/.test(line) && line.replace(/^##\s+/, "").trim() === top.heading);
  return { version: top.version, line: index + 1 };
}

export const changelogVersion: Rule = {
  id: "changelog-version",
  title: "The top release section of the changelog of a package is not above the version of its package.json. With the option `everyVersion`, it is the same version.",
  reason:
    "On 2026-11-03 a pull request added the section 0.5.0 with two breaking changes to a changelog, and left package.json at 0.4.1. The next change of a dependency range made the train plan a PATCH 0.4.2, so the breaking changes were about to ship under a PATCH number.",
  fix: "Set the version of package.json to the version of the top section in the same change, by the rules of Semantic Versioning. Or, if the release is not ready, name the section Unreleased.",
  sources: [
    { repo: "packing", rule: "changelog", doc: "packages/packing/CHANGELOG.md (#249 added 0.5.0, package.json stayed 0.4.1; #253 set 0.5.0)" },
    { repo: "release-train", rule: "cascade", doc: "the train plans a PATCH for a change of a dependency range" },
    { repo: "private", rule: "semver", doc: "the global CLAUDE.md, npm packages use Semantic Versioning" },
  ],
  options: {
    file: { type: "string", default: "CHANGELOG.md", description: "The name of the changelog in the folder of each package." },
    everyVersion: { type: "boolean", default: false, description: "When true, the top section also names the version of package.json: each version has its section." },
  },
  check(context, options) {
    const name = String(options["file"]);
    const breaks: Break[] = [];
    let found = 0;
    for (const pkg of versionedPackages(context)) {
      const file = pkg.folder === "" ? name : `${pkg.folder}/${name}`;
      if (!existsSync(join(context.root, file))) continue;
      found += 1;
      const version = String(pkg.manifest["version"]);
      const top = topSection(readFileSync(join(context.root, file), "utf8"));
      if (top === undefined) {
        if (options["everyVersion"] === true) breaks.push({ file, message: `${file} has no section for a version, and ${pkg.file} is at ${version}.` });
        continue;
      }
      const order = compareVersions(top.version, version);
      if (order > 0) {
        breaks.push({ file, line: top.line, message: `${file} has the section ${top.version}, and ${pkg.file} is still at ${version}. Set the version to ${top.version} in this change. Else a change of a dependency range releases a PATCH of ${version} under the notes of ${top.version}.` });
      } else if (order < 0 && options["everyVersion"] === true) {
        breaks.push({ file, line: top.line, message: `${pkg.file} is at ${version}, and the top section of ${file} is ${top.version}. Add the section ${version}.` });
      }
    }
    if (found === 0) return { skipped: `no package with a release version has a file ${name}` };
    return breaks;
  },
};
