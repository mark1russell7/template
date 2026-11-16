// The reads of the GitHub API that the scripts of the template share: `gh api` with no shell, a retry after a transient
// error, a pool of reads with a width, and the rate limit of the token. The audit of the time limits (scripts/limit-audit)
// and the read of the CI minutes (scripts/ci-minutes) use them. Each workflow that starts one of those scripts installs
// the dependencies of the root, because the retry comes from its home, @mark1russell7/service.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Clock, type RetryOptions, retry } from "@mark1russell7/service";

const run = promisify(execFile);

/** The options of each start of `gh`: a large buffer, and no path conversion of Git Bash on Windows. */
const OPTIONS = {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, MSYS_NO_PATHCONV: "1" },
} as const;

/** A start of `gh` with its arguments, which gives its standard output. A test gives a fake one. */
export type Exec = (args: readonly string[]) => Promise<string>;

const exec: Exec = async (args) => (await run("gh", [...args], OPTIONS)).stdout;

/**
 * The retry of each start of `gh`: 4 tries, with a backoff of 2 s, 4 s and 8 s before the retries, each less a random part
 * of up to one half. On 2026-11-16 one read of 61 repositories lost two of them to one HTTP 502 each, and a second read of
 * the same page a few minutes later passed.
 */
export const RETRY: RetryOptions & { readonly base: number } = { tries: 4, base: 2_000, factor: 2, cap: 30_000, jitter: { kind: "subtract", fraction: 0.5 } };

/** This function gives the text of an error of `gh`: its message and its standard error. */
export function errorText(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return `${error instanceof Error ? error.message : String(error)}\n${typeof stderr === "string" ? stderr : ""}`;
}

/**
 * This function tells if an error of `gh` is transient: a server error (HTTP 500 to 599) or a broken connection. A later
 * try can then succeed. An error of the request, for example HTTP 404 or 422, is not transient.
 */
export function transient(error: unknown): boolean {
  return /\bHTTP 5\d\d\b|\bECONNRESET\b|\bETIMEDOUT\b|connection reset|i\/o timeout|TLS handshake timeout|unexpected EOF/i.test(errorText(error));
}

/** The parts of a start of `gh` that a test changes: the start itself, and the clock of the waits between the tries. */
export interface GhOptions {
  readonly exec?: Exec | undefined;
  readonly clock?: Clock | undefined;
}

/**
 * This function starts `gh` with these arguments and gives its standard output. It tries again after a transient error.
 * The default clock of `retry` keeps the process alive in each wait (since `@mark1russell7/algebra` 0.9.0).
 */
export async function gh(args: readonly string[], options: GhOptions = {}): Promise<string> {
  const start = options.exec ?? exec;
  return retry(() => start(args), { ...RETRY, retryable: transient, clock: options.clock });
}

/** This function gives one JSON value for each line that `gh api --paginate` writes with a `tojson` filter. */
export async function lines<T>(path: string, jq: string, options?: GhOptions): Promise<T[]> {
  return parseLines<T>(await gh(["api", "--paginate", path, "--jq", jq], options));
}

/** This function gives one JSON value for each line of one page of `gh api` (no `--paginate`) with a `tojson` filter. */
export async function page<T>(path: string, jq: string, options?: GhOptions): Promise<T[]> {
  return parseLines<T>(await gh(["api", path, "--jq", jq], options));
}

/** This function gives the body of one read of `gh api` as text, for example the log of a job. */
export async function text(path: string, options?: GhOptions): Promise<string> {
  return gh(["api", path], options);
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
export async function rateLimit(options?: GhOptions): Promise<RateLimit> {
  const [core] = parseLines<{ remaining: number; reset: number }>(
    await gh(["api", "rate_limit", "--jq", ".resources.core | {remaining, reset} | tojson"], options),
  );
  if (core === undefined) throw new Error("rate_limit gave no core limit");
  return { remaining: core.remaining, resetMs: core.reset * 1000 };
}
