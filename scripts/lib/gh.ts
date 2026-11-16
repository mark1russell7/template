// The reads of the GitHub API that the scripts of the template share: `gh api` with no shell, a pool of reads with a
// width, and the rate limit of the token. The audit of the time limits (scripts/limit-audit) and the read of the CI
// minutes (scripts/ci-minutes) use them. Each workflow that starts one of those scripts has this folder in its sparse
// checkout.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The options of each start of `gh`: a large buffer, and no path conversion of Git Bash on Windows. */
const OPTIONS = {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, MSYS_NO_PATHCONV: "1" },
} as const;

/** This function gives one JSON value for each line that `gh api --paginate` writes with a `tojson` filter. */
export async function lines<T>(path: string, jq: string): Promise<T[]> {
  const { stdout } = await run("gh", ["api", "--paginate", path, "--jq", jq], OPTIONS);
  return parseLines<T>(stdout);
}

/** This function gives one JSON value for each line of one page of `gh api` (no `--paginate`) with a `tojson` filter. */
export async function page<T>(path: string, jq: string): Promise<T[]> {
  const { stdout } = await run("gh", ["api", path, "--jq", jq], OPTIONS);
  return parseLines<T>(stdout);
}

/** This function gives one JSON value for each line of a text that is not empty. */
export function parseLines<T>(text: string): T[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/** This function starts `work` on each item, with at most `width` at the same time, and keeps the order. */
export async function pool<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
  return out;
}

/** The core rate limit of the token: the reads that are left, and the time of the reset in milliseconds since 1970. */
export interface RateLimit {
  readonly remaining: number;
  readonly resetMs: number;
}

/** This function reads the core rate limit of the token. The read of `rate_limit` does not count against the limit. */
export async function rateLimit(): Promise<RateLimit> {
  const { stdout } = await run("gh", ["api", "rate_limit", "--jq", ".resources.core | {remaining, reset} | tojson"], OPTIONS);
  const [core] = parseLines<{ remaining: number; reset: number }>(stdout);
  if (core === undefined) throw new Error("rate_limit gave no core limit");
  return { remaining: core.remaining, resetMs: core.reset * 1000 };
}
