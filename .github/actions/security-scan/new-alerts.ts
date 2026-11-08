// The step "Fail on new alerts" of the action security-scan (action.yml). The step fails a pull request that adds a
// CodeQL alert at or above the severity limit on a line that it changes. An alert that is already open on the base
// branch is not new. The step groups the alerts by rule, file and message, and a group is new only when the pull request
// has more alerts of it than the base branch has open. The pure functions have no I/O, so the tests call them directly
// (scripts/workflows/security-scan.test.ts). main() reads the environment of the step.
import { appendFileSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The security-severity of each word of the input fail-on-severity. */
export const MIN_SCORES: Readonly<Record<string, number>> = { low: 0.1, moderate: 4, high: 7, critical: 9 };

/** A line range of a file, from the first line to the last line. */
export type Range = readonly [number, number];

/** A CodeQL result of the pull request, at or above the severity limit. */
export interface Result {
  readonly rule: string;
  readonly score: number;
  readonly file: string;
  readonly line: number;
  /** The message, with the links of SARIF removed (refer to `normalizeMessage`). */
  readonly message: string;
  /** True when the result or a step of its data flow is on a line that the pull request changes. */
  readonly touches: boolean;
}

/** An open alert of the base branch, from the code-scanning alerts API. */
export interface BaseAlert {
  readonly rule: string;
  readonly file: string;
  readonly message: string;
}

/** This function gives a message with no SARIF links (`[text](1)` becomes `text`) and with one space between words. */
export function normalizeMessage(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\(\d+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** This function gives the key of the group of an alert: its rule, its file and its message. */
export function groupKey(alert: { readonly rule: string; readonly file: string; readonly message: string }): string {
  return JSON.stringify([alert.rule, alert.file, alert.message]);
}

/** This function gives the line ranges that a pull request adds or changes, for each file, from a diff with `--unified=0`. */
export function changedLines(diff: string): Map<string, Range[]> {
  const changed = new Map<string, Range[]>();
  let file: string | null = null;
  let header = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      header = true;
      file = null;
      continue;
    }
    if (header && line.startsWith("+++ ")) {
      // git adds a tab after a path with a space
      file = line === "+++ /dev/null" ? null : line.slice("+++ b/".length).replace(/\t$/, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null) continue;
    header = false;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (file !== null && count > 0) {
      const ranges = changed.get(file) ?? [];
      ranges.push([start, start + count - 1]);
      changed.set(file, ranges);
    }
  }
  return changed;
}

function decode(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- SARIF is external JSON */
/**
 * This function gives the results of the SARIF files at or above the score `min`, with the results that a suppression
 * removes taken out. `total` is the number of results of each severity.
 */
export function sarifResults(sarifs: readonly unknown[], min: number, changed: ReadonlyMap<string, readonly Range[]>): { results: Result[]; total: number } {
  const touches = (loc: { file: string; start: number; end: number }) => (changed.get(loc.file) ?? []).some(([first, last]) => first <= loc.end && last >= loc.start);
  const results: Result[] = [];
  let total = 0;
  for (const sarif of sarifs as any[]) {
    for (const run of sarif?.runs ?? []) {
      // The security-severity of each rule
      const severity = new Map<string, number>();
      for (const component of [run.tool?.driver, ...(run.tool?.extensions ?? [])]) {
        for (const rule of component?.rules ?? []) {
          const score = Number.parseFloat(rule.properties?.["security-severity"]);
          if (!Number.isNaN(score)) severity.set(rule.id, score);
        }
      }
      for (const result of run.results ?? []) {
        total += 1;
        if ((result.suppressions ?? []).length > 0) continue;
        const rule = String(result.ruleId ?? result.rule?.id ?? "");
        const score = severity.get(rule);
        if (score === undefined || score < min) continue;
        // The alert location and each step of its data flow
        const locations = [
          ...(result.locations ?? []),
          ...(result.codeFlows ?? []).flatMap((flow: any) => (flow.threadFlows ?? []).flatMap((thread: any) => (thread.locations ?? []).map((step: any) => step.location))),
        ]
          .map((loc: any) => loc?.physicalLocation)
          .filter((loc: any) => loc?.artifactLocation?.uri)
          .map((loc: any) => ({ file: decode(loc.artifactLocation.uri), start: loc.region?.startLine ?? 1, end: loc.region?.endLine ?? loc.region?.startLine ?? 1 }));
        const first = locations[0];
        if (first === undefined) continue;
        results.push({ rule, score, file: first.file, line: first.start, message: normalizeMessage(String(result.message?.text ?? "")), touches: locations.some(touches) });
      }
    }
  }
  return { results, total };
}

/** This function gives the open alerts of a page of the code-scanning alerts API. */
export function baseAlertsOf(page: unknown): BaseAlert[] {
  if (!Array.isArray(page)) throw new Error("the code-scanning alerts API did not give a list");
  return page.map((alert: any) => ({
    rule: String(alert?.rule?.id ?? ""),
    file: String(alert?.most_recent_instance?.location?.path ?? ""),
    message: normalizeMessage(String(alert?.most_recent_instance?.message?.text ?? "")),
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * This function gives the new alerts. A new result is on a changed line. Its group has more results in the pull request
 * than open alerts on the base branch. A group with a surplus gives each of its results on a changed
 * line. The new result cannot be told from the others.
 */
export function newAlerts(results: readonly Result[], base: readonly BaseAlert[]): Result[] {
  const open = new Map<string, number>();
  for (const alert of base) open.set(groupKey(alert), (open.get(groupKey(alert)) ?? 0) + 1);
  const count = new Map<string, number>();
  for (const result of results) count.set(groupKey(result), (count.get(groupKey(result)) ?? 0) + 1);
  return results.filter((result) => result.touches && (count.get(groupKey(result)) ?? 0) > (open.get(groupKey(result)) ?? 0));
}

/** A function with the shape of `fetch`, for the tests. */
export type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * This function reads the open CodeQL alerts of a branch, page by page. A repository with no analysis of the branch has no
 * open alert: the API gives 404 "no analysis found". Each other failure throws, so the step fails.
 */
export async function readBaseAlerts(fetcher: Fetch, input: { api: string; repository: string; ref: string; token: string }): Promise<BaseAlert[]> {
  const alerts: BaseAlert[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const query = new URLSearchParams({ ref: input.ref, state: "open", tool_name: "CodeQL", per_page: "100", page: String(page) });
    const url = `${input.api}/repos/${input.repository}/code-scanning/alerts?${query.toString()}`;
    const response = await fetcher(url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${input.token}`, "x-github-api-version": "2022-11-28" } });
    const text = await response.text();
    if (response.status === 404 && /no analysis found/i.test(text)) return alerts;
    if (!response.ok) throw new Error(`the code-scanning alerts API gave HTTP ${String(response.status)} for ${input.ref}: ${text.slice(0, 300)}`);
    const items = baseAlertsOf(JSON.parse(text) as unknown);
    alerts.push(...items);
    if (items.length < 100) return alerts;
  }
  throw new Error("the code-scanning alerts API gave more than 100 pages");
}

function property(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function data(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** This function gives the text of the step summary. */
export function summaryText(found: readonly Result[], total: number, known: number, severity: string): string {
  const lines = ["### CodeQL: new alerts of this pull request", ""];
  if (found.length === 0) {
    lines.push(`CodeQL found ${String(total)} results in the repository. None is a new alert at or above ${severity} on a line that the pull request changes.`);
  } else {
    lines.push("| Rule | Security-severity | File | Line |", "|---|---|---|---|");
    for (const alert of found) lines.push(`| ${alert.rule} | ${alert.score.toFixed(1)} | \`${alert.file}\` | ${String(alert.line)} |`);
  }
  if (known > 0) lines.push("", `${String(known)} results on changed lines are alerts that are already open on the base branch. They are not new.`);
  return lines.join("\n") + "\n";
}

/** This function operates the step: it reads the environment, writes the annotations and the summary, and gives the exit code. */
export async function main(env: NodeJS.ProcessEnv = process.env, fetcher: Fetch = fetch): Promise<number> {
  const severity = env["SEVERITY"] ?? "";
  const min = MIN_SCORES[severity];
  if (min === undefined) {
    console.log(`::error::"${severity}" is not a severity. Use low, moderate, high or critical.`);
    return 1;
  }
  const folder = env["RESULTS"] ?? "";
  const sarifs = readdirSync(folder)
    .filter((entry) => entry.endsWith(".sarif"))
    .map((name) => JSON.parse(readFileSync(join(folder, name), "utf8")) as unknown);
  const changed = changedLines(readFileSync(env["DIFF"] ?? "", "utf8"));
  const { results, total } = sarifResults(sarifs, min, changed);
  let base: BaseAlert[];
  try {
    base = await readBaseAlerts(fetcher, { api: env["GITHUB_API_URL"] ?? "https://api.github.com", repository: env["GITHUB_REPOSITORY"] ?? "", ref: `refs/heads/${env["BASE_REF"] ?? ""}`, token: env["GH_TOKEN"] ?? "" });
  } catch (error) {
    console.log(`::error::The step cannot read the open alerts of the base branch, so it cannot tell the new alerts: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const found = newAlerts(results, base);
  const known = results.filter((result) => result.touches).length - found.length;
  for (const alert of found) {
    const title = `CodeQL: ${alert.rule} (security-severity ${alert.score.toFixed(1)})`;
    console.log(`::error file=${property(alert.file)},line=${String(alert.line)},title=${property(title)}::${data(alert.message)}`);
  }
  if (env["GITHUB_STEP_SUMMARY"]) appendFileSync(env["GITHUB_STEP_SUMMARY"], summaryText(found, total, known, severity));
  if (found.length > 0) {
    console.log(`::error::The pull request adds ${String(found.length)} CodeQL alerts at or above ${severity}.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
