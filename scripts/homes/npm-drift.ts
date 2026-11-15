// Compares the map of homes with npm: npmDrift of conventions on the answers of the registry.
//
//   node scripts/homes/npm-drift.ts [--check] [--json] [--base <map.ts of the base branch>]
//
// For each package name of the map (the packages and the pending names of each home), the script asks the registry
// of npm if the name has a version. It prints each difference: a package of a published home that is not on npm, a
// pending name that is on npm, a package of an unpublished home that is on npm, a name that npm did not answer, and
// a planned home that names no package. --check exits 1 for each difference except a planned home with no name: a
// name that npm did not answer fails too, because a no read is never a pass. A planned home with no name shows as a
// no read and does not fail: nothing can be read for it until the home names its package in `pending`.
// With --base, the script also reads the map of the base branch of a pull request, and --check fails only on a
// difference that the base map does not have. A difference that the base has too (for example a pending package that
// went to npm after the base commit) is not a fault of the pull request: the script prints it, and the run on the
// default branch fails on it. A no read fails each time, because a no read is never a pass.
// The workflow homes-npm.yml runs it each day, on each change of the map on main, and on each pull request.
import { appendFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOMES, npmDrift, npmNames, type Home, type NpmDrift, type NpmPresence } from "../../packages/conventions/src/map.ts";

const REGISTRY = "https://registry.npmjs.org";

/** The number of requests to the registry at one time. */
const PARALLEL = 6;

/** This function asks the registry for one name. A 404 is "not on npm". Another error is a no read. */
export async function presenceOf(name: string, fetchFn: typeof fetch = fetch): Promise<NpmPresence> {
  try {
    const response = await fetchFn(`${REGISTRY}/${name.replaceAll("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json" }, signal: AbortSignal.timeout(20_000) });
    if (response.status === 404) return { onNpm: false };
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const data = (await response.json()) as { versions?: Record<string, unknown> };
    return { onNpm: Object.keys(data.versions ?? {}).length > 0 };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** This function asks the registry for each name, `PARALLEL` at a time. */
export async function presences(names: readonly string[], fetchFn: typeof fetch = fetch): Promise<ReadonlyMap<string, NpmPresence>> {
  const facts = new Map<string, NpmPresence>();
  for (let start = 0; start < names.length; start += PARALLEL) {
    const part = names.slice(start, start + PARALLEL);
    const answers = await Promise.all(part.map((name) => presenceOf(name, fetchFn)));
    part.forEach((name, index) => facts.set(name, answers[index] ?? { error: "no answer" }));
  }
  return facts;
}

/** This function gives the key of a difference: its kind, its area and its name. */
export function driftKey(drift: NpmDrift): string {
  return `${drift.kind} ${drift.area} ${drift.name ?? ""}`;
}

/**
 * This function splits the differences of the map of a pull request (`head`) into the differences that the change
 * adds and the differences that the map of the base branch has too. A no read is always added: a no read is never a
 * pass, also when the base has the same no read.
 */
export function splitByBase(head: readonly NpmDrift[], base: readonly NpmDrift[]): { readonly added: readonly NpmDrift[]; readonly inherited: readonly NpmDrift[] } {
  const keys = new Set(base.filter((drift) => drift.kind !== "no-read").map(driftKey));
  return { added: head.filter((drift) => !keys.has(driftKey(drift))), inherited: head.filter((drift) => keys.has(driftKey(drift))) };
}

/**
 * This function gives the report of the differences and the exit code of --check. `inherited` are the differences
 * that the base branch has too: the report names them, and they do not fail the check.
 */
export function report(found: readonly NpmDrift[], names: number, inherited: readonly NpmDrift[] = []): { readonly code: number; readonly text: string } {
  const failing = found.filter((drift) => drift.kind !== "unnamed");
  const unnamed = found.filter((drift) => drift.kind === "unnamed").map((drift) => drift.area);
  const fromBase = inherited.filter((drift) => drift.kind !== "unnamed");
  const lines = [`The map of homes against npm: ${names} names asked, ${failing.length} ${failing.length === 1 ? "difference" : "differences"}.`];
  for (const drift of failing) lines.push(`- ${drift.kind}: ${drift.text}`);
  if (fromBase.length > 0) {
    lines.push(`The base branch has ${fromBase.length} more ${fromBase.length === 1 ? "difference" : "differences"}. They do not fail this pull request, and the run on the default branch fails on them:`);
    for (const drift of fromBase) lines.push(`- ${drift.kind}: ${drift.text}`);
  }
  if (unnamed.length > 0) lines.push(`No read: the planned homes ${unnamed.join(", ")} name no package in pending.`);
  return { code: failing.length > 0 ? 1 : 0, text: `${lines.join("\n")}\n` };
}

/** This function reads the homes of a map file of another commit, for example the map of the base branch. */
export async function homesOf(file: string): Promise<readonly Home[]> {
  const module = (await import(pathToFileURL(resolve(file)).href)) as { HOMES?: unknown };
  if (!Array.isArray(module.HOMES)) throw new Error(`${file} exports no HOMES list`);
  return module.HOMES as readonly Home[];
}

async function main(args: readonly string[]): Promise<number> {
  const at = args.indexOf("--base");
  const baseFile = at === -1 ? undefined : args[at + 1];
  if (at !== -1 && (baseFile === undefined || baseFile.startsWith("--"))) {
    process.stderr.write("--base needs the path of a map file\n");
    return 2;
  }
  const base = baseFile === undefined ? undefined : await homesOf(baseFile);
  const names = [...new Set([...npmNames(HOMES), ...(base === undefined ? [] : npmNames(base))])];
  const facts = await presences(names);
  const head = npmDrift(HOMES, facts);
  const { added, inherited } = base === undefined ? { added: head, inherited: [] } : splitByBase(head, npmDrift(base, facts));
  const result = report(added, names.length, inherited);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(head, null, 2)}\n`);
  } else {
    process.stdout.write(result.text);
    const summary = process.env["GITHUB_STEP_SUMMARY"];
    if (summary !== undefined && summary !== "") appendFileSync(summary, result.text);
  }
  return args.includes("--check") ? result.code : 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
