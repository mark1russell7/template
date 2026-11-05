/**
 * The rule `published-minor`: a consumer does not stay behind the newest published minor of a package that the option
 * `packages` names. A caret range of a `0.x` version cannot reach the next minor, so such a consumer stays behind with
 * no failure. The lockfile can also hold an old version that the range admits.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEPENDENCY_FIELDS, hasFile, keyLine, matchesAny, specifiersOf, type Break, type PackageInfo, type Rule } from "../rule.ts";
import { NPM_REGISTRY, npmLookup, type RegistryAnswer, type RegistryLookup } from "./unreleased-change.ts";

/** A major and a minor. The minor `Infinity` means each minor of the major. */
export type Minor = readonly [major: number, minor: number];

/** This function gives the major and the minor of a release version, or undefined for a pre-release and for other text. */
export function minorOf(version: string): Minor | undefined {
  // A cut at the first `(` and `+`, so that the pattern examines only the digits: this text comes from a file
  const release = version.trim().split("(", 1)[0]?.split("+", 1)[0] ?? "";
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(release);
  return match === null ? undefined : [Number(match[1]), Number(match[2])];
}

/**
 * This function gives the highest minor that a range can reach. It gives undefined for a form that the rule does not read.
 * These forms are a `workspace:` or `github:` specifier, a tag, a partial version and a compound range. Below `1.0.0`, a caret stays in
 * its minor. From `1.0.0`, a caret reaches each minor of its major.
 */
export function reachOf(specifier: string): Minor | undefined {
  const match = /^([\^~]?)(\d+)\.(\d+)\.\d+(?:[-+].*)?$/.exec(specifier.trim());
  if (match === null) return undefined;
  const major = Number(match[2]);
  return match[1] === "^" && major > 0 ? [major, Number.POSITIVE_INFINITY] : [major, Number(match[3])];
}

/** This function tells if the minor `have` is before the minor `other`. */
const behind = (have: Minor, other: Minor): boolean => have[0] < other[0] || (have[0] === other[0] && have[1] < other[1]);

/** This function gives the indent, the key and the value of one line of YAML. It cuts the line by position, with no pattern. */
function yamlEntry(line: string): { readonly indent: number; readonly key: string; readonly value: string } | undefined {
  const text = line.trimEnd();
  const body = text.trimStart();
  const colon = body.indexOf(": ");
  const key = colon >= 0 ? body.slice(0, colon) : body.endsWith(":") ? body.slice(0, -1) : "";
  return key === "" ? undefined : { indent: text.length - body.length, key, value: colon >= 0 ? body.slice(colon + 2) : "" };
}

/**
 * This function gives the locked version of each dependency of each importer of the text of a `pnpm-lock.yaml` file. The
 * key of the outer map is the folder of the importer, with `""` for the root.
 */
export function lockedVersions(text: string): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const importers = new Map<string, Map<string, string>>();
  let inside = false;
  let importer: Map<string, string> | undefined;
  let name: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) inside = line.trimEnd() === "importers:";
    if (!inside) continue;
    const entry = yamlEntry(line);
    if (entry === undefined) continue;
    const { indent, value } = entry;
    const key = entry.key.replace(/^['"]|['"]$/g, "");
    if (indent === 2) {
      importer = new Map();
      importers.set(key === "." ? "" : key, importer);
    } else if (indent === 6) {
      name = key;
    } else if (indent === 8 && key === "version" && name !== undefined) {
      importer?.set(name, value);
    }
  }
  return importers;
}

/** One dependency of one package, that the option `packages` names. */
interface Use {
  readonly pkg: PackageInfo;
  readonly field: string;
  readonly name: string;
  readonly reach: Minor;
}

/** This function gives the time in milliseconds of the first release that `have` is behind, or undefined when npm gives no time. */
function firstAhead(answer: Exclude<RegistryAnswer, { error: string }>, have: Minor): number | undefined {
  const times = Object.entries(answer.times ?? {}).flatMap(([version, time]) => {
    const minor = minorOf(version);
    return minor !== undefined && behind(have, minor) && !Number.isNaN(Date.parse(time)) ? [Date.parse(time)] : [];
  });
  return times.length === 0 ? undefined : Math.min(...times);
}

/** This function makes the rule with the registry lookup `lookup` and the clock `now`. The tests give fakes. */
export function publishedMinorRule(lookup: RegistryLookup = npmLookup, now: () => number = Date.now): Rule {
  return {
    id: "published-minor",
    title: "A consumer does not stay behind the newest published minor of a package that the option `packages` names.",
    reason:
      "A caret range of a 0.x version cannot reach the next minor, and a lockfile can hold an old version that a range admits. A test that holds the choices of today does not show it, so a consumer can stay behind for many releases with no failure.",
    fix: "Raise the range of the dependency to the newest published minor, and update the lockfile. Read the changes of the release first.",
    sources: [{ repo: "private", rule: "published-minor", doc: "docs/STRATEGY.md (2026-11-04, a consumer behind a published minor)" }],
    options: {
      packages: { type: "strings", default: [], description: "The patterns of the package names that the rule examines, for example `@scope/*`. With no pattern, the rule does not start." },
      graceDays: { type: "number", default: 0, description: "The days that a consumer has, from the first publish of a minor that it does not have." },
      registry: { type: "string", default: NPM_REGISTRY, description: "The URL of the registry that has the versions." },
    },
    check(context, options) {
      const patterns = Array.isArray(options["packages"]) ? (options["packages"] as readonly string[]) : [];
      if (patterns.length === 0) return { skipped: "the option `packages` names no package" };
      const all = [context.rootPackage, ...context.packages];
      const consumers = all.filter((pkg, index) => all.findIndex((other) => other.file === pkg.file) === index);
      const uses: Use[] = [];
      for (const pkg of consumers) {
        for (const field of DEPENDENCY_FIELDS) {
          for (const [name, specifier] of specifiersOf(pkg.manifest, field)) {
            const reach = reachOf(specifier);
            if (reach !== undefined && matchesAny(name, patterns)) uses.push({ pkg, field, name, reach });
          }
        }
      }
      if (uses.length === 0) return { skipped: "no dependency has a range and a name that the option `packages` names" };

      const answers = lookup([...new Set(uses.map((use) => use.name))], typeof options["registry"] === "string" ? options["registry"] : NPM_REGISTRY);
      const locked = hasFile(context.root, "pnpm-lock.yaml") ? lockedVersions(readFileSync(join(context.root, "pnpm-lock.yaml"), "utf8")) : new Map<string, ReadonlyMap<string, string>>();
      const grace = (typeof options["graceDays"] === "number" ? options["graceDays"] : 0) * 86_400_000;
      const breaks: Break[] = [];
      const notes = new Set<string>();
      for (const { pkg, field, name, reach } of uses) {
        const answer = answers.get(name) ?? { error: "no answer" };
        if ("error" in answer) {
          notes.add(`the registry did not answer for ${name}: ${answer.error}`);
          continue;
        }
        const latest = answer.latest === undefined ? undefined : minorOf(answer.latest);
        if (latest === undefined) continue;
        const version = locked.get(pkg.folder)?.get(name);
        const lockMinor = version === undefined ? undefined : minorOf(version);
        const have = behind(reach, latest) ? reach : lockMinor;
        if (have === undefined || !behind(have, latest)) continue;
        const since = firstAhead(answer, have);
        if (grace > 0 && since !== undefined && now() - since < grace) continue;
        const line = keyLine(pkg.text, field, name);
        const at = { file: pkg.file, ...(line === undefined ? {} : { line }) };
        const message =
          have === reach
            ? `${name}: the range in ${field} cannot reach ${String(answer.latest)}, the newest version on npm. Raise the range.`
            : `${name}: the lockfile holds ${String(version)}, and npm has ${String(answer.latest)}. Update the lockfile.`;
        breaks.push({ ...at, message });
      }
      if (breaks.length === 0 && notes.size > 0) return { skipped: [...notes].join("; ") };
      return breaks;
    },
  };
}

export const publishedMinor: Rule = publishedMinorRule();
