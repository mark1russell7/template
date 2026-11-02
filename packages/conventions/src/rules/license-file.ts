/**
 * The rule `license-file`: each public package has a license field and a license file with the same license, in its
 * own folder, and a repository with a public package has a license file at its root.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codePackages, inFolder, lineOf, type Break, type PackageInfo, type Rule } from "../rule.ts";

/** The names of a license file, without case. */
const LICENSE_NAME = /^licen[cs]e(?:\.(?:md|txt))?$/i;

/** For each license that the rule knows, a pattern of its text. The text of another license is not checked. */
export const LICENSE_TEXTS: Readonly<Record<string, RegExp>> = {
  MIT: /\bMIT License\b|Permission is hereby granted, free of charge/,
  ISC: /\bISC License\b|Permission to use, copy, modify, and\/or distribute/,
  "Apache-2.0": /Apache License,?\s+Version 2\.0/,
  "BSD-3-Clause": /Redistribution and use in source and binary forms[\s\S]*Neither the name/,
};

/** This function gives the name of the license file in a folder, or undefined. */
export function licenseFileOf(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir, { withFileTypes: true }).find((entry) => entry.isFile() && LICENSE_NAME.test(entry.name))?.name;
}

/** This function gives the name of the author of a manifest: the string before `<` or `(`, or the field `name`. */
export function authorOf(author: unknown): string | undefined {
  const name = typeof author === "string" ? author.replace(/\s*[<(].*$/, "") : typeof author === "object" && author !== null && typeof (author as { name?: unknown }).name === "string" ? (author as { name: string }).name : undefined;
  return name === undefined || name.trim() === "" ? undefined : name.trim();
}

/** This function gives the text of the MIT license. */
export function mitText(year: number, holder: string): string {
  return `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

const isPublic = (pkg: PackageInfo): boolean => pkg.manifest["private"] !== true;

export const licenseFile: Rule = {
  id: "license-file",
  title: "Each public package has a license field and, in its own folder, a license file with the same license. A repository with a public package has a license file at its root.",
  reason:
    "npm packs the license file of the folder of the package only, and GitHub reads the license file of the root only. On 2026-11-02 five public repositories (packing, rigor, layout-contract, typeset, template) had no license file at the root, so GitHub showed them as without a license while their packages on npm said MIT.",
  fix: "Add a license field to package.json (MIT is the license of each package of the fleet). `conventions fix` writes each missing license file: a copy of a license file of the repository with the same license, or else the MIT text with the author of the manifest. Correct a license file whose text is not the license of the field.",
  sources: ["vex", "coeval", "client", "highways"].map((repo) => ({ repo, rule: "license-file", doc: "LICENSE (MIT, at the root, with license MIT in each package.json)" })),
  options: {},
  check(context) {
    const all = [context.rootPackage, ...codePackages(context)];
    const unique = all.filter((pkg, index) => all.findIndex((other) => other.file === pkg.file) === index);
    const published = unique.filter(isPublic);
    if (published.length === 0) return [];
    const breaks: Break[] = [];
    // The license files that exist, by license, as the source of a copy
    const texts = new Map<string, string>();
    const licenseOf = (pkg: PackageInfo): string | undefined => (typeof pkg.manifest["license"] === "string" ? (pkg.manifest["license"] as string) : undefined);
    for (const pkg of unique) {
      const name = licenseFileOf(pkg.dir);
      if (name === undefined) continue;
      const text = readFileSync(join(pkg.dir, name), "utf8");
      // The license of a file is the license whose text it has, or else the license field of its package
      const license = Object.keys(LICENSE_TEXTS).find((id) => LICENSE_TEXTS[id]?.test(text) === true) ?? licenseOf(pkg);
      if (license !== undefined && !texts.has(license)) texts.set(license, text);
    }
    const missing = (folder: string, license: string, author: unknown, why: string): void => {
      const file = inFolder(folder, "LICENSE");
      const holder = authorOf(author) ?? authorOf(context.rootPackage.manifest["author"]);
      const text = texts.get(license) ?? (license === "MIT" && holder !== undefined ? mitText(new Date().getFullYear(), holder) : undefined);
      breaks.push({ file, message: `${folder === "" ? "The root" : folder} has no license file: ${why}`, ...(text === undefined ? {} : { edits: [{ file, before: "", after: text }] }) });
    };
    for (const pkg of published) {
      const license = licenseOf(pkg);
      const name = String(pkg.manifest["name"] ?? pkg.folder);
      if (license === undefined) {
        breaks.push({ file: pkg.file, message: `The public package ${name} has no license field.` });
        continue;
      }
      const found = licenseFileOf(pkg.dir);
      if (found === undefined) {
        missing(pkg.folder, license, pkg.manifest["author"], `npm packs only the license file of the folder of ${name} (${license}).`);
        continue;
      }
      const text = readFileSync(join(pkg.dir, found), "utf8");
      if (LICENSE_TEXTS[license]?.test(text) === false) {
        const line = lineOf(pkg.text, '"license"');
        breaks.push({ file: inFolder(pkg.folder, found), message: `${inFolder(pkg.folder, found)} is not the text of ${license}, the license field of ${name}${line === undefined ? "" : ` (${pkg.file}:${line})`}.` });
      }
    }
    if (!published.includes(context.rootPackage) && licenseFileOf(context.root) === undefined) {
      const license = published.map(licenseOf).find((item) => item !== undefined);
      if (license !== undefined) missing("", license, published[0]?.manifest["author"], "GitHub reads only the license file of the root.");
    }
    return breaks;
  },
};
