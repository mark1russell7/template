/**
 * The npm source: the publication time of each version of some packages. The release data uses
 * these times when git and GitHub give no date for a version.
 */

import type { NpmPublishTimes, NpmVersionTime } from "./types.ts";

/** The public npm registry. */
export const NPM_REGISTRY = "https://registry.npmjs.org";

/** The options of `npmPublishTimes`. */
export interface NpmOptions {
  /** The npm names of the packages, or a scope (for example `@procedures`) for all the packages of the scope. */
  packages: readonly string[];
  /** The `fetch` function. The default is the global `fetch`. */
  fetch?: typeof fetch;
  registry?: string;
  /** The time limit of each request, in milliseconds. The default is 15000. */
  timeoutMs?: number;
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json => (value !== null && typeof value === "object" ? (value as Json) : {});

function message(error: unknown): string {
  if (object(error)["name"] === "TimeoutError") return "npm did not answer in time";
  return error instanceof Error ? error.message : String(error);
}

/**
 * This function reads the publication time of each version of the packages from the npm registry.
 * A scope (`@name`) gives each package of the scope. It does not throw. Each failure gives a
 * message in `problems`.
 */
export async function npmPublishTimes(options: NpmOptions): Promise<NpmPublishTimes> {
  const { registry = NPM_REGISTRY, timeoutMs = 15_000 } = options;
  const fetcher = options.fetch ?? globalThis.fetch;
  const problems: string[] = [];
  const times: NpmVersionTime[] = [];
  if (typeof fetcher !== "function") return { times, problems: ["this Node has no fetch"] };
  const get = async (url: string): Promise<unknown> => {
    const response = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };

  const names = new Set<string>();
  for (const entry of options.packages.map((name) => name.trim()).filter(Boolean)) {
    if (!/^@[^/]+$/.test(entry)) {
      names.add(entry);
      continue;
    }
    try {
      const found = object(await get(`${registry}/-/v1/search?text=scope:${encodeURIComponent(entry.slice(1))}&size=250`));
      const objects = Array.isArray(found["objects"]) ? found["objects"] : [];
      const before = names.size;
      for (const item of objects) {
        const name = object(object(item)["package"])["name"];
        if (typeof name === "string" && name.startsWith(`${entry}/`)) names.add(name);
      }
      if (names.size === before) problems.push(`npm has no package in the scope ${entry}`);
    } catch (error) {
      problems.push(`npm did not give the packages of ${entry}: ${message(error)}`);
    }
  }

  // Four requests at a time
  const queue = [...names].sort();
  const worker = async (): Promise<void> => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      try {
        const packument = object(await get(`${registry}/${name.replace("/", "%2f")}`));
        const published = object(packument["versions"]);
        for (const [version, date] of Object.entries(object(packument["time"]))) {
          if (version === "created" || version === "modified" || typeof date !== "string") continue;
          if (!(version in published)) continue;
          times.push({ name, version, date });
        }
      } catch (error) {
        problems.push(`npm did not give the versions of ${name}: ${message(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  times.sort((a, b) => a.name.localeCompare(b.name) || a.date.localeCompare(b.date));
  return { times, problems };
}
