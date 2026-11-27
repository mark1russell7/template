// Finds the Renovate lock-file-maintenance PRs that a stale renovate/stability-days check holds, and ticks their
// rebase/retry box. Then Renovate runs on each PR again and computes the check with the current preset.
//
//   node scripts/release/tick-lockmaint.ts [--before <ISO time>] [--owner <org>]... [--private] [--dry-run]
//
// The class: a minimum release age holds the stability check of a lock file refresh pending for ever, because a refresh
// has no release time. Pull request #505 (2026-11-26 23:20Z) set lockFileMaintenance.minimumReleaseAge to null in
// renovate/base.json. But a PR that Renovate did not run on after that keeps its old pending check. Such a PR does not
// merge. When it also changes a package version, bump-pins.ts refuses the repository. Thus a stuck pin move or a stuck
// version is a reason to run this script.
//
// The script ticks only a PR that is open, last updated before --before (default: the merge of #505), with the check
// pending and an unticked box. Each tick starts a CI run. CI minutes of a private repository are paid, so the script
// skips a private repository, unless you give --private.

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorText, type Gh } from "./dispatch.ts";

/** The merge time of #505: a lock-maintenance PR that Renovate last updated before it can keep a stale check. */
export const FIX_TIME = "2026-11-26T23:20:00Z";
/** The name of the check of the minimum release age. */
export const CHECK = "renovate/stability-days";
/** The unticked rebase/retry box of a Renovate PR body. */
export const BOX = "- [ ] <!-- rebase-check -->";
/** The ticked box. */
export const TICKED = "- [x] <!-- rebase-check -->";

/** One status or check of a PR, as gh pr view --json statusCheckRollup gives it. */
export interface RollupEntry {
  readonly context?: string;
  readonly name?: string;
  readonly state?: string;
  readonly conclusion?: string;
  readonly status?: string;
}

/** What the script does with one PR. */
export type Decision =
  | { readonly kind: "tick" }
  | { readonly kind: "skip"; readonly why: string };

/** The state of the stability check in a rollup, or "none" when the PR has no such check. */
export function stabilityState(rollup: readonly RollupEntry[]): string {
  const entry = rollup.find((c) => (c.context ?? c.name) === CHECK);
  if (entry === undefined) return "none";
  return entry.state ?? entry.conclusion ?? entry.status ?? "unknown";
}

/** The decision for one PR: tick only a pending check, an unticked box, and a public repository (or --private). */
export function decide(body: string, rollup: readonly RollupEntry[], visibility: string, withPrivate: boolean): Decision {
  const state = stabilityState(rollup);
  if (!/^PENDING$/i.test(state)) return { kind: "skip", why: `${CHECK} is ${state}` };
  if (!body.includes(BOX)) return { kind: "skip", why: "no unticked rebase/retry box" };
  if (visibility !== "public" && !withPrivate) return { kind: "skip", why: `${visibility} repository: paid CI; give --private` };
  return { kind: "tick" };
}

/** The options of a run. */
export interface Options {
  readonly before: string;
  readonly owners: readonly string[];
  readonly dryRun: boolean;
  readonly withPrivate: boolean;
}

/** Reads the options from the arguments. */
export function parseArgs(args: readonly string[]): Options {
  const values = (name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]!] : []));
  const owners = values("--owner");
  return {
    before: values("--before")[0] ?? FIX_TIME,
    owners: owners.length > 0 ? owners : ["mark1russell7", "metrograph-labs"],
    dryRun: args.includes("--dry-run"),
    withPrivate: args.includes("--private"),
  };
}

interface Found {
  readonly repository: { readonly nameWithOwner: string };
  readonly number: number;
  readonly updatedAt: string;
}

/** Runs the search and the ticks. Gives one line for each PR and a summary line. */
export function run(gh: Gh, options: Options): string[] {
  const search = ["search", "prs", ...options.owners.flatMap((o) => ["--owner", o]), "--state", "open", "--author", "app/renovate",
    "lock file maintenance", "--json", "repository,number,updatedAt", "--limit", "200"];
  const found = (JSON.parse(gh(search)) as Found[]).filter((p) => p.updatedAt < options.before);
  const visibility = new Map<string, string>();
  const counts: Record<string, number> = {};
  const lines: string[] = [];
  for (const p of found) {
    const repo = p.repository.nameWithOwner;
    let result: string;
    try {
      if (!visibility.has(repo)) visibility.set(repo, gh(["api", `repos/${repo}`, "--jq", ".visibility"]).trim());
      const pr = JSON.parse(gh(["pr", "view", String(p.number), "-R", repo, "--json", "body,statusCheckRollup"])) as {
        body: string;
        statusCheckRollup: RollupEntry[];
      };
      const decision = decide(pr.body, pr.statusCheckRollup, visibility.get(repo)!, options.withPrivate);
      if (decision.kind === "skip") result = `skip (${decision.why})`;
      else if (options.dryRun) result = "would tick";
      else {
        const folder = mkdtempSync(join(tmpdir(), "tick-lockmaint-"));
        try {
          const file = join(folder, "body.md");
          writeFileSync(file, pr.body.replace(BOX, TICKED));
          gh(["pr", "edit", String(p.number), "-R", repo, "--body-file", file]);
        } finally {
          rmSync(folder, { recursive: true, force: true });
        }
        result = "ticked";
      }
    } catch (error) {
      result = `error: ${errorText(error).split("\n")[0]!.slice(0, 120)}`;
    }
    const key = result.split(" ")[0]!;
    counts[key] = (counts[key] ?? 0) + 1;
    lines.push(`${repo}#${p.number} (updated ${p.updatedAt.slice(0, 16)}Z): ${result}`);
  }
  lines.push(JSON.stringify({ before: options.before, found: found.length, ...counts }));
  return lines;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const gh: Gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  for (const line of run(gh, parseArgs(process.argv.slice(2)))) process.stdout.write(`${line}\n`);
}
