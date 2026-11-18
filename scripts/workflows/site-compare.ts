// The compare of the site check of a pull request with the site check of its base, over the live public sites of the
// owners (CI.md, "The compare of the site check"). The job compare of site-audit.yml starts it:
//
//   node next/scripts/workflows/site-compare.ts --sites <JSON list> --shard <n> --shards <count> --base <dir> --next <dir> --out <dir>
//
// A change of the site check can fail a page that passed before. The pin of each site moves later, in a pull request of
// the train, and that pull request is red. So this script finds such pages before the change merges:
//   1. siteTarget() reads the site config of each site of its shard: .github/site.json, the inputs of the job that calls
//      reusable-pages.yml, or the inputs of a step that uses the action site-check. The pages and the widths are those
//      of the site check of that site. A site with no site check is out of scope: no change of the check fails it.
//      compareSites() reads the config of each site before the first check. A check blocks the script for minutes,
//      and a fetch after it can use a connection that the server closed in that time.
//   2. It starts the check of the base and the check of the pull request on the live pages, one after the other.
//   3. newProblems() gives each problem of a view that only the check of the pull request finds. One pair of runs can
//      differ by chance (a slow request, a console error of the page). So a site with a new problem gets a second pair,
//      and confirmed() keeps only the new problems that both pairs give.
//   4. A confirmed new problem fails the job, with its site, page, width and scheme. A problem of one pair only is a
//      warning. A site that the compare cannot read fails the job, with its error, because a no read is not a pass:
//      its site config gave an error, or the check of the base gave no report. A site with a report of the base and no
//      report of the pull request fails, because the new check cannot read a page that the old one reads.
// The probes of the sites (site-check-probe) are not part of the compare. The script reads only public data, with
// GITHUB_TOKEN. The two checks import only Node.js modules and the files of their checkout, so neither needs an install.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { errorMessage, escapeMarkdown, escapeWorkflowData } from "@mark1russell7/text";
import { blockEnd, childKeys, indentOf, keyValue, workflowLines } from "../../packages/conventions/src/workflow.ts";
import { resolveSiteConfig, SITE_CONFIG_PATH } from "../../packages/site-pages/src/config/site-config.ts";

/** One view of a report of the site check: a page at one width in one color scheme. */
export interface CheckView {
  readonly page: string;
  readonly width: number;
  readonly scheme: string;
  readonly problems: readonly string[];
}

/** The part of `report.json` of the site check that the compare reads. */
export interface CheckReport {
  readonly views: readonly CheckView[];
}

/** The new problems of a site, by view: the key is `<page> <width> <scheme>`. */
export type ViewProblems = ReadonlyMap<string, readonly string[]>;

/** The pages and widths of the site check of one site. An empty value gives the default of the check. */
export interface SiteTarget {
  readonly repo: string;
  readonly url: string;
  readonly pages: string;
  readonly widths: string;
}

/** The result of the compare of one site. */
export type SiteOutcome =
  | { readonly repo: string; readonly kind: "same"; readonly views: number }
  | { readonly repo: string; readonly kind: "new"; readonly problems: ViewProblems }
  | { readonly repo: string; readonly kind: "once"; readonly problems: ViewProblems }
  | { readonly repo: string; readonly kind: "next-unread"; readonly reason: string }
  | { readonly repo: string; readonly kind: "unread"; readonly reason: string }
  | { readonly repo: string; readonly kind: "off"; readonly reason: string };

/** This function gives the key of a view: its page, its width and its scheme. */
export const viewKey = (view: Pick<CheckView, "page" | "width" | "scheme">): string => `${view.page} ${String(view.width)} ${view.scheme}`;

/** This function gives each problem of a view of `next` that the same view of `base` does not have. */
export function newProblems(base: CheckReport, next: CheckReport): ViewProblems {
  const known = new Map(base.views.map((view) => [viewKey(view), new Set(view.problems)]));
  const found = new Map<string, string[]>();
  for (const view of next.views) {
    const before = known.get(viewKey(view)) ?? new Set<string>();
    const fresh = [...new Set(view.problems)].filter((problem) => !before.has(problem));
    if (fresh.length > 0) found.set(viewKey(view), fresh);
  }
  return found;
}

/** This function keeps the new problems of the first pair that the second pair also gives, in the same view. */
export function confirmed(first: ViewProblems, second: ViewProblems): ViewProblems {
  const kept = new Map<string, string[]>();
  for (const [key, problems] of first) {
    const again = new Set(second.get(key) ?? []);
    const both = problems.filter((problem) => again.has(problem));
    if (both.length > 0) kept.set(key, both);
  }
  return kept;
}

/** One call of the site check in a workflow file: a job that calls `reusable-pages.yml`, or a step that uses the action `site-check`. */
export interface CheckCall {
  readonly kind: "pages" | "action";
  /** The inputs of the call. The value `true` or `false` gives a boolean. Each other value is a string, with no quotes. */
  readonly inputs: Readonly<Record<string, string | boolean>>;
}

/** This function gives the kind of the call that a value of `uses` makes, or undefined for another workflow or action. */
function callKind(uses: string): CheckCall["kind"] | undefined {
  if (/^(mark1russell7\/template\/|\.\/)\.github\/workflows\/reusable-pages\.ya?ml(@|$)/i.test(uses)) return "pages";
  if (/^(mark1russell7\/template\/|\.\/)\.github\/actions\/site-check(@|$)/i.test(uses)) return "action";
  return undefined;
}

/** This function gives the column of the key of a line. A list item (`- key:`) has its key two columns after the dash. */
const keyColumn = (line: string): number => indentOf(line) + (line.trimStart().startsWith("- ") ? 2 : 0);

/** This function gives the value of an input, and joins the lines of a block scalar (`|` or `>`) with spaces. */
function inputValue(lines: readonly string[], at: number, raw: string): string {
  if (!/^[|>][+-]?\d*$/.test(raw)) return raw;
  return lines
    .slice(at + 1, blockEnd(lines, at))
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

/** This function gives each call of the site check in a workflow file, in the order of the file. */
export function checkCalls(text: string): CheckCall[] {
  const lines = workflowLines(text);
  const calls: CheckCall[] = [];
  for (const [index, line] of lines.entries()) {
    const uses = keyValue(line, "uses");
    const kind = uses === undefined ? undefined : callKind(uses);
    if (kind === undefined) continue;
    // The keys of the mapping of the call (a job or a step) are at the column of `uses`
    const column = keyColumn(line);
    let start = index;
    while (!(lines[start] ?? "").trimStart().startsWith("- ") && start > 0) {
      const above = lines[start - 1] ?? "";
      if (above.trim() !== "" && keyColumn(above) < column) break;
      start -= 1;
    }
    let end = index + 1;
    while (end < lines.length && ((lines[end] ?? "").trim() === "" || indentOf(lines[end] ?? "") >= column)) end += 1;
    const withAt = [...Array(end - start).keys()].map((offset) => start + offset).find((at) => keyColumn(lines[at] ?? "") === column && keyValue(lines[at] ?? "", "with") !== undefined);
    const inputs: Record<string, string | boolean> = {};
    for (const at of withAt === undefined ? [] : childKeys(lines, withAt)) {
      const entry = (lines[at] ?? "").trim();
      const key = entry.slice(0, Math.max(0, entry.indexOf(":"))).replace(/^["']|["']$/g, "");
      if (key === "") continue;
      const value = inputValue(lines, at, keyValue(entry, key) ?? "");
      inputs[key] = value === "true" ? true : value === "false" ? false : value;
    }
    calls.push({ kind, inputs });
  }
  return calls;
}

/** The files of a site that give its site config: the text of `.github/site.json`, and the texts of its workflow files. */
export interface SiteFiles {
  readonly config: string | undefined;
  readonly workflows: readonly string[];
}

/** The site check of a site, the reason that the site has none, or the reason that its config cannot be read. */
export type SiteTargetResult = SiteTarget | { readonly off: string } | { readonly error: string };

/**
 * This function gives the pages and the widths of the site check of a site, from its site config. A value that GitHub
 * fills in at run time (`${{ ... }}`) gives an error, because the compare cannot know it.
 */
export function siteTarget(repository: string, url: string, files: SiteFiles): SiteTargetResult {
  const repo = repository.split("/")[1] ?? repository;
  const calls = files.workflows.flatMap(checkCalls);
  const target = (pages: unknown, widths: unknown): SiteTargetResult => {
    const [p, w] = [String(pages ?? "").trim(), String(widths ?? "").trim()];
    if (`${p}${w}`.includes("${{")) return { error: "the pages or the widths of the site check come from an expression of the workflow" };
    return { repo, url, pages: p, widths: w };
  };
  // A call with deploy: false builds a test site, not the live one
  const pages = calls.find((call) => call.kind === "pages" && call.inputs["deploy"] !== false);
  if (files.config !== undefined || pages !== undefined) {
    const result = resolveSiteConfig({ file: files.config, path: SITE_CONFIG_PATH, inputs: pages?.inputs, repository });
    if ("error" in result) return result;
    if (result.config["site-check"]) return target(result.config["site-check-pages"], result.config["site-check-widths"]);
  }
  // A site with its own Pages workflow uses the action site-check, with inputs of the same names
  const action = calls.find((call) => call.kind === "action");
  if (action !== undefined) return target(action.inputs["site-check-pages"], action.inputs["site-check-widths"]);
  return { off: pages === undefined && files.config === undefined ? "no workflow calls the site check" : "its site config has no site check (site-check is false)" };
}

/** The reports of one pair of runs: the check of the base and the check of the pull request. A missing report is `undefined`. */
export interface Pair {
  readonly base?: CheckReport | undefined;
  readonly next?: CheckReport | undefined;
}

/** This function gives the outcome of a site from the reports of its first pair, and of its second pair when it has one. */
export function outcome(repo: string, first: Pair, second?: Pair): SiteOutcome {
  if (first.base === undefined) return { repo, kind: "unread", reason: "the check of the base gave no report" };
  if (first.next === undefined) return { repo, kind: "next-unread", reason: "the check of the pull request gave no report, and the check of the base gave one" };
  const fresh = newProblems(first.base, first.next);
  if (fresh.size === 0) return { repo, kind: "same", views: first.next.views.length };
  if (second?.base === undefined || second.next === undefined) return { repo, kind: "once", problems: fresh };
  const both = confirmed(fresh, newProblems(second.base, second.next));
  return both.size > 0 ? { repo, kind: "new", problems: both } : { repo, kind: "once", problems: fresh };
}

/**
 * This function tells if an outcome fails the compare: a confirmed new problem, no report of the pull request only, or
 * a site that the compare cannot read. A no read is not a pass at any time. A site with no site check does not fail.
 */
export const fails = (each: SiteOutcome): boolean => each.kind === "new" || each.kind === "next-unread" || each.kind === "unread";

/** This function gives the lines of the summary of a shard: a table of the sites, then each site that it cannot read, then each new problem. */
export function summaryLines(shard: string, outcomes: readonly SiteOutcome[]): string[] {
  const count = (kind: SiteOutcome["kind"]): number => outcomes.filter((each) => each.kind === kind).length;
  const word: Record<SiteOutcome["kind"], string> = {
    same: "same problems",
    new: "**new problems**",
    once: "new in one pair only",
    "next-unread": "**no report of the pull request**",
    unread: "**no read**",
    off: "no site check",
  };
  const lines = [
    `## The compare of the site check, shard ${shard}: ${String(outcomes.filter(fails).length)} of ${String(outcomes.length)} sites fail`,
    "",
    `Same problems: ${String(count("same"))}. New in one pair only: ${String(count("once"))}. No read: ${String(count("unread"))}. No site check: ${String(count("off"))}.`,
    "",
    "| Site | Result | Views with a new problem |",
    "| --- | --- | ---: |",
    ...outcomes.map((each) => `| ${escapeMarkdown(each.repo)} | ${word[each.kind]} | ${"problems" in each ? String(each.problems.size) : "0"} |`),
  ];
  for (const each of outcomes) {
    if (each.kind !== "unread" && each.kind !== "next-unread") continue;
    lines.push("", `### ${escapeMarkdown(each.repo)}: ${word[each.kind]}`, "", `- ${escapeMarkdown(each.reason)}`);
  }
  for (const each of outcomes) {
    if (each.kind !== "new" && each.kind !== "once") continue;
    lines.push("", `### ${escapeMarkdown(each.repo)}: ${word[each.kind]}`, "");
    for (const [key, problems] of each.problems) for (const problem of problems) lines.push(`- ${escapeMarkdown(key)}: ${escapeMarkdown(problem)}`);
  }
  return lines;
}

/** This function gives the workflow commands of the outcomes: an error for each fault and each no read, and a warning for each doubt. */
export function annotations(outcomes: readonly SiteOutcome[]): string[] {
  const lines: string[] = [];
  const say = (level: "error" | "warning", text: string): number => lines.push(`::${level} title=Site check compare::${escapeWorkflowData(text)}`);
  for (const each of outcomes) {
    if (each.kind === "new" || each.kind === "once") {
      const why = each.kind === "new" ? "only the check of the pull request finds it, in two pairs of runs" : "only the check of the pull request finds it, in one pair of runs of two";
      for (const [key, problems] of each.problems) for (const problem of problems) say(each.kind === "new" ? "error" : "warning", `${each.repo} ${key}: ${problem} (${why})`);
    }
    if (each.kind === "next-unread") say("error", `${each.repo}: ${each.reason}`);
    if (each.kind === "unread") say("error", `${each.repo}: no read, because ${each.reason}`);
  }
  return lines;
}

/** This function gives the sites of one shard: the sites at the places `shard`, `shard + shards`, and on, of the sorted list. */
export const shardOf = (sites: readonly string[], shard: number, shards: number): string[] => [...sites].sort((a, b) => a.localeCompare(b)).filter((_, at) => at % shards === shard);

/** This function reads one response of the GitHub API, or gives undefined for a 404. */
async function api(path: string, token: string, accept = "application/vnd.github+json"): Promise<Response | undefined> {
  const response = await fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${token}`, accept, "user-agent": "site-compare", "x-github-api-version": "2022-11-28" } });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${String(response.status)}`);
  return response;
}

/** This function reads the home and the site config files of a site from its default branch. */
export async function readSite(owner: string, repo: string, token: string): Promise<{ url: string; files: SiteFiles }> {
  const meta = (await (await api(`/repos/${owner}/${repo}`, token))?.json()) as { default_branch?: string } | undefined;
  const ref = encodeURIComponent(meta?.default_branch ?? "main");
  const pages = (await (await api(`/repos/${owner}/${repo}/pages`, token))?.json()) as { html_url?: string } | undefined;
  const fallback = repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${owner.toLowerCase()}.github.io/` : `https://${owner.toLowerCase()}.github.io/${repo}/`;
  const url = pages?.html_url ?? fallback;
  const raw = async (path: string): Promise<string | undefined> => (await api(`/repos/${owner}/${repo}/contents/${path}?ref=${ref}`, token, "application/vnd.github.raw"))?.text();
  const config = await raw(SITE_CONFIG_PATH);
  const listing = ((await (await api(`/repos/${owner}/${repo}/contents/.github/workflows?ref=${ref}`, token))?.json()) as { name: string; type: string }[] | undefined) ?? [];
  const workflows: string[] = [];
  for (const file of listing.filter((entry) => entry.type === "file" && /\.ya?ml$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const text = await raw(`.github/workflows/${file.name}`);
    if (text !== undefined) workflows.push(text);
  }
  return { url: url.endsWith("/") ? url : `${url}/`, files: { config, workflows } };
}

/** This function starts one site check, and gives its report, or undefined when it gives none. */
function runCheck(checkout: string, target: SiteTarget, shots: string): CheckReport | undefined {
  mkdirSync(shots, { recursive: true });
  const args = [join(checkout, "packages/site-pages/src/check/main.ts"), "--url", target.url, "--shots", shots, "--timeout", "45000"];
  if (target.pages !== "") args.push("--pages", target.pages);
  if (target.widths !== "") args.push("--widths", target.widths);
  const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 1 << 26 });
  writeFileSync(join(shots, "check.log"), `${result.stdout ?? ""}${result.stderr ?? ""}\nexit ${String(result.status)}\n`);
  // Exit code 2 is a wrong command line: that check read no page
  const file = join(shots, "report.json");
  if (result.status === 2 || !existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as CheckReport;
}

/** The reads and the checks of a compare. A test gives fakes, so it uses no network and no browser. */
export interface CompareSteps {
  /** This function reads the home and the site config files of a site. */
  readonly read: (owner: string, repo: string) => Promise<{ url: string; files: SiteFiles }>;
  /** This function starts the check of the base or of the pull request on a site, and gives its report, or undefined when it gives none. */
  readonly check: (side: "base" | "next", target: SiteTarget, round: number) => CheckReport | undefined;
  /** This function receives the outcome of each site with a site check, after its checks. */
  readonly done?: (result: SiteOutcome, target: SiteTarget) => void;
}

/**
 * This function compares the check of the base and the check of the pull request on each site, in the order of the
 * list. It reads the site config of each site before the first check. A check blocks the script for minutes, and a
 * fetch after it can use a connection that the server closed in that time. Before this order, every second read failed.
 */
export async function compareSites(sites: readonly string[], owners: Readonly<Record<string, string>>, steps: CompareSteps): Promise<SiteOutcome[]> {
  const targets: { repo: string; target: SiteTargetResult }[] = [];
  for (const repo of sites) {
    const owner = owners[repo];
    if (owner === undefined) {
      targets.push({ repo, target: { error: "the job sites gave no owner for it" } });
      continue;
    }
    try {
      const site = await steps.read(owner, repo);
      targets.push({ repo, target: siteTarget(`${owner}/${repo}`, site.url, site.files) });
    } catch (error) {
      // fetch gives only "fetch failed". Its cause tells why: a closed connection, a DNS error or a time-out
      const cause = error instanceof Error && error.cause !== undefined ? ` (${errorMessage(error.cause)})` : "";
      targets.push({ repo, target: { error: `the read of its site config failed: ${errorMessage(error)}${cause}` } });
    }
  }
  const outcomes: SiteOutcome[] = [];
  for (const { repo, target } of targets) {
    if ("error" in target || "off" in target) {
      outcomes.push("error" in target ? { repo, kind: "unread", reason: target.error } : { repo, kind: "off", reason: target.off });
      continue;
    }
    const pair = (round: number): Pair => ({ base: steps.check("base", target, round), next: steps.check("next", target, round) });
    const first = pair(1);
    const once = outcome(repo, first);
    const result = once.kind === "once" ? outcome(repo, first, pair(2)) : once;
    outcomes.push(result);
    steps.done?.(result, target);
  }
  return outcomes;
}

/** This function removes the screenshots under a folder, and keeps the reports and the logs. */
function dropShots(dir: string): void {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" })) if (file.endsWith(".png")) rmSync(join(dir, file));
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { sites: { type: "string" }, shard: { type: "string" }, shards: { type: "string" }, base: { type: "string" }, next: { type: "string" }, out: { type: "string" } } });
  const token = process.env["GH_TOKEN"] ?? "";
  // The owner of each site, from the job sites of site-audit.yml
  const owners = JSON.parse(process.env["OWNERS"] ?? "{}") as Record<string, string>;
  const [shard, shards] = [Number(values.shard ?? "0"), Number(values.shards ?? "1")];
  const { base, next } = values;
  if (token === "" || base === undefined || next === undefined || values.out === undefined || !(Number.isInteger(shard) && shards >= 1 && shard >= 0 && shard < shards)) {
    process.stderr.write("site-compare: give GH_TOKEN, OWNERS, --base, --next, --out, and a --shard below --shards\n");
    return 2;
  }
  const out = resolve(values.out);
  const sites = shardOf(JSON.parse(values.sites ?? "[]") as string[], shard, shards);
  const outcomes = await compareSites(sites, owners, {
    read: (owner, repo) => readSite(owner, repo, token),
    check: (side, target, round) => runCheck(side === "base" ? base : next, target, join(out, target.repo, `${side}-${String(round)}`)),
    done: (result, target) => {
      // The screenshots stay only for a site with a new problem, so the artifact stays small
      if (result.kind === "same") dropShots(join(out, target.repo));
      process.stdout.write(`${target.repo}: ${result.kind} (pages ${target.pages || "/"})\n`);
    },
  });
  const serial = outcomes.map((each) => ("problems" in each ? { ...each, problems: Object.fromEntries(each.problems) } : each));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `compare-${String(shard)}.json`), `${JSON.stringify({ date: new Date().toISOString(), shard, shards, sites: serial }, null, 2)}\n`);
  const lines = summaryLines(`${String(shard + 1)} of ${String(shards)}`, outcomes);
  if (process.env["GITHUB_STEP_SUMMARY"]) appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `${lines.join("\n")}\n`);
  process.stdout.write(`${[...lines, ...annotations(outcomes)].join("\n")}\n`);
  return outcomes.some(fails) ? 1 : 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`site-compare: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
