// Compares the map of homes with npm: npmDrift of conventions on the answers of the registry.
//
//   node scripts/homes/npm-drift.ts [--check] [--json]
//
// For each package name of the map (the packages and the pending names of each home), the script asks the registry
// of npm if the name has a version. It prints each difference: a package of a published home that is not on npm, a
// pending name that is on npm, a package of an unpublished home that is on npm, a name that npm did not answer, and
// a planned home that names no package. --check exits 1 for each difference except a planned home with no name: a
// name that npm did not answer fails too, because a no read is never a pass. A planned home with no name shows as a
// no read and does not fail: nothing can be read for it until the home names its package in `pending`.
// The workflow homes-npm.yml runs it each week and on each change of the map.
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HOMES, npmDrift, npmNames, type NpmDrift, type NpmPresence } from "../../packages/conventions/src/map.ts";

const REGISTRY = "https://registry.npmjs.org";

/** The number of requests to the registry at one time. */
const PARALLEL = 6;

/** This function asks the registry for one name. A 404 is "not on npm". Another error is a no read. */
export async function presenceOf(name: string, fetchFn: typeof fetch = fetch): Promise<NpmPresence> {
  try {
    const response = await fetchFn(`${REGISTRY}/${name.replace("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json" }, signal: AbortSignal.timeout(20_000) });
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

/** This function gives the report of the differences and the exit code of --check. */
export function report(found: readonly NpmDrift[], names: number): { readonly code: number; readonly text: string } {
  const failing = found.filter((drift) => drift.kind !== "unnamed");
  const unnamed = found.filter((drift) => drift.kind === "unnamed").map((drift) => drift.area);
  const lines = [`The map of homes against npm: ${names} names asked, ${failing.length} ${failing.length === 1 ? "difference" : "differences"}.`];
  for (const drift of failing) lines.push(`- ${drift.kind}: ${drift.text}`);
  if (unnamed.length > 0) lines.push(`No read: the planned homes ${unnamed.join(", ")} name no package in pending.`);
  return { code: failing.length > 0 ? 1 : 0, text: `${lines.join("\n")}\n` };
}

async function main(args: readonly string[]): Promise<number> {
  const names = npmNames(HOMES);
  const found = npmDrift(HOMES, await presences(names));
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
  } else {
    const { text } = report(found, names.length);
    process.stdout.write(text);
    const summary = process.env["GITHUB_STEP_SUMMARY"];
    if (summary !== undefined && summary !== "") appendFileSync(summary, text);
  }
  return args.includes("--check") ? report(found, names.length).code : 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
