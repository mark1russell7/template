// The ruleset of main of each repository: a pull request must pass each summary check of the gate, the
// checks with a name "<Name> OK" such as "CI OK", "Security OK" and "Xplat OK" (CI.md, "The check of the
// ruleset"). The owner starts it, because a ruleset is a setting of the repository.
//
//   node scripts/workflows/ruleset-ci-ok.ts [<owner/repo> ...] [--only-summary] [--apply]
//   node scripts/workflows/ruleset-ci-ok.ts [<owner/repo> ...] --check
//
// Without --apply, the script only prints what it would do. For each repository:
//   1. It reads the check runs of the head commits of the last 5 pull requests that merged into the default
//      branch. It uses the newest one where "CI OK" passed, and keeps each summary check that passed there.
//      A pull request with a summary check that has not ended yet is not used: a pull request can merge before
//      its checks end, and a check that has not ended is not proof.
//      (A pull request whose checks ran before "CI OK" came to main can merge later without it.) A ruleset applies to pull requests, so
//      this is the proof that each check starts on a pull request. A check that starts only on a push
//      to main never runs on a pull request, and a rule for it blocks each pull request. A repository
//      where "CI OK" did not pass there is skipped.
//   2. It reads the rules of the branch, from each ruleset of any name. A check that a ruleset names
//      already is not added again. The other checks that a ruleset names stay.
//   3. With --apply, it adds one ruleset for the missing checks: the default branch, the integration
//      GitHub Actions, and no bypass. Its name is the first missing check. The other rulesets do not change.
//   4. With --only-summary, the summary checks become the only required checks of the gate. A required check
//      that ran in the same workflow run as the "CI OK" that passed in step 1 comes out of each ruleset: "CI OK"
//      needs each job of its workflow and fails on a skip or a failure of one (CI.md), so it covers the check.
//      A rule with no check left goes out of its ruleset. A ruleset with no rule left is disabled, not deleted: it
//      keeps its rules, so its owner can read it and turn it on again. A disabled ruleset does not change. A check of
//      another workflow stays. A repository can then join or split the jobs of its CI and keep its ruleset.
//
// --check changes nothing and exits 1 when a repository has a summary check that passed in step 1 and that no ruleset
// names: then that repository has no ruleset yet (a new repository), or it lost one. A repository with no "CI OK"
// that passed is a no read, never a pass: a new repository has no merged pull request yet. The workflow rulesets.yml
// runs the check each day, so each new repository gets its ruleset after its first merged pull request. --check does
// not read the checks that --only-summary removes. With GITHUB_STEP_SUMMARY, it also writes a table there.
//
// A repository with no active workflow ci.yml and no "CI OK" that passed has no gate, so it has no check to require: a fork
// (GitHub turns off the workflows of a fork), the profile repository, or a repository whose workflow ci.yml GitHub turned
// off. --check lists it on one line as "no CI", out of the table. It is not a no read: the check reads it, and it has no gate.
//
// --check also reads the settings of each repository that is not a fork, as anyone can read them (settingsFaults):
// a ruleset when the repository has the workflow ci.yml, the dependency graph (the SBOM request gives 404 when it is
// off), and a Pages source when the repository has the workflow pages.yml. A fault of a setting fails the check also
// for a new repository with no merged pull request, so the window between the first push and the first merge is held.
// scripts/stamp/settings.ts sets the settings. Another answer of the SBOM request is a no read, never a pass.
//
// With no repository, the script uses each public repository that is not archived, of each owner of the package
// conventions (packages/conventions/src/owners.ts).
import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OWNERS } from "../../packages/conventions/src/owners.ts";

export const CHECK = "CI OK";
// The name of a summary job: one word or more, the first with a capital letter, then " OK" ("Joint bench OK").
export const SUMMARY: RegExp = /^[A-Z][A-Za-z0-9]*( [A-Za-z0-9]+)* OK$/;
// The app id of GitHub Actions, so that only a check of Actions passes the rule.
export const ACTIONS_APP = 15368;
// The workflows of the template that need a setting of the repository: CI needs a ruleset, Pages needs a Pages source.
export const CI_WORKFLOW = ".github/workflows/ci.yml";
export const PAGES_WORKFLOW = ".github/workflows/pages.yml";

function gh(args: readonly string[], input?: string): string {
  return execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

/** This function gives the HTTP status in the text of an error of gh ("gh: Not Found (HTTP 404)"), or undefined. */
export function httpStatusOf(text: string): number | undefined {
  const found = /\(HTTP (\d{3})\)/.exec(text);
  return found?.[1] === undefined ? undefined : Number(found[1]);
}

/** This function gives the HTTP status of a request with no output: 200, or the status of the error of gh. */
function statusOf(args: readonly string[]): number {
  try {
    gh([...args, "--silent"]);
    return 200;
  } catch (error) {
    const status = httpStatusOf(error instanceof Error && "stderr" in error ? String(error.stderr) : String(error));
    if (status === undefined) throw error;
    return status;
  }
}

/** This function gives the body of a ruleset of the default branch that needs each check in `checks`, with no bypass. */
export function rulesetBody(checks: readonly string[]): Record<string, unknown> {
  return {
    name: checks[0],
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: checks.map((context) => ({ context, integration_id: ACTIONS_APP })) } }],
  };
}

/** The settings of a repository that a person sets on GitHub, not in its files, as anyone can read them. */
export interface SettingsRead {
  /** A fork keeps the settings of its source, so the check reads none of them. */
  readonly fork: boolean;
  /** The required checks of the default branch, from each ruleset of any name. */
  readonly required: readonly string[];
  /** The paths of the active workflows. */
  readonly workflows: readonly string[];
  readonly hasPages: boolean;
  /** The HTTP status of the request for the SBOM of the dependency graph. */
  readonly sbom: number;
}

/**
 * This function gives the faults of the settings of a repository. A new repository has them until a person sets the
 * settings (`scripts/stamp/settings.ts`). A ruleset needs proof that its checks start on a pull request, so this function
 * asks for a ruleset only when the repository has the workflow `ci.yml` of the template.
 */
export function settingsFaults(read: SettingsRead): { faults: string[]; unread: string[] } {
  const faults: string[] = [];
  const unread: string[] = [];
  if (read.fork) return { faults, unread };
  if (read.required.length === 0 && read.workflows.includes(CI_WORKFLOW)) faults.push("no ruleset on the default branch");
  if (read.sbom === 404) faults.push("the dependency graph is off");
  else if (read.sbom !== 200) unread.push(`the dependency graph gave HTTP ${String(read.sbom)}`);
  if (!read.hasPages && read.workflows.includes(PAGES_WORKFLOW)) faults.push("no Pages source");
  return { faults, unread };
}

function json<T>(args: readonly string[]): T {
  return JSON.parse(gh(args)) as T;
}

interface Repo {
  readonly nameWithOwner: string;
  readonly defaultBranchRef: { readonly name: string } | null;
}

interface CheckRun {
  readonly name: string;
  readonly conclusion: string | null;
  readonly check_suite?: { readonly id: number };
}

interface BranchRule {
  readonly type: string;
  readonly parameters?: { readonly required_status_checks?: readonly { readonly context: string }[]; readonly [key: string]: unknown };
}

/** The summary checks that passed, and the other checks of the workflow run of the "CI OK" that passed. */
interface Proof {
  readonly passed: Set<string>;
  readonly covered: Set<string>;
}

interface Ruleset {
  readonly id: number;
  readonly name: string;
  readonly target: string;
  readonly enforcement: string;
  readonly conditions?: unknown;
  readonly bypass_actors?: unknown;
  readonly rules?: readonly BranchRule[];
}

function repositories(named: readonly string[]): string[] {
  if (named.length > 0) return [...named];
  return OWNERS.flatMap((owner) =>
    json<Repo[]>(["repo", "list", owner.login, "--visibility", "public", "--no-archived", "--limit", "500", "--json", "nameWithOwner,defaultBranchRef"])
      .filter((r) => r.defaultBranchRef !== null)
      .map((r) => r.nameWithOwner),
  );
}

// The summary checks that passed on the head of the newest of the last 5 merged pull requests where "CI OK" passed,
// and the other checks of the workflow run (the check suite) of that "CI OK".
function passedSummaries(repo: string, branch: string): Proof {
  const passed = new Set<string>();
  const pulls = json<{ merged_at: string | null; head: { sha: string } }[]>(["api", `repos/${repo}/pulls?state=closed&base=${encodeURIComponent(branch)}&sort=updated&direction=desc&per_page=30`]);
  const merged = pulls.filter((p) => p.merged_at !== null).sort((a, b) => (b.merged_at as string).localeCompare(a.merged_at as string)).slice(0, 5);
  for (const pull of merged) {
    const runs = json<{ check_runs: CheckRun[] }>(["api", `repos/${repo}/commits/${pull.head.sha}/check-runs?per_page=100`]);
    if (runs.check_runs.some((r) => SUMMARY.test(r.name) && r.conclusion === null)) continue;
    for (const r of runs.check_runs) if (SUMMARY.test(r.name) && r.conclusion === "success") passed.add(r.name);
    const ok = runs.check_runs.find((r) => r.name === CHECK && r.conclusion === "success");
    if (ok) {
      const suite = ok.check_suite?.id;
      const covered = new Set(runs.check_runs.filter((r) => suite !== undefined && r.check_suite?.id === suite && !SUMMARY.test(r.name)).map((r) => r.name));
      return { passed, covered };
    }
    passed.clear();
  }
  return { passed, covered: new Set() };
}

// Step 4: each ruleset loses the required checks that "CI OK" covers. It gives the count of the changed rulesets.
function dropCovered(repo: string, covered: ReadonlySet<string>, apply: boolean): number {
  let changed = 0;
  for (const listed of json<{ id: number }[]>(["api", `repos/${repo}/rulesets?includes_parents=false`])) {
    const set = json<Ruleset>(["api", `repos/${repo}/rulesets/${listed.id}`]);
    // A disabled ruleset requires no check, so it has nothing to drop.
    if (set.enforcement === "disabled") continue;
    const dropped: string[] = [];
    const rules: BranchRule[] = [];
    for (const rule of set.rules ?? []) {
      const list = rule.parameters?.required_status_checks;
      if (rule.type !== "required_status_checks" || list === undefined) {
        rules.push(rule);
        continue;
      }
      const keep = list.filter((c) => !covered.has(c.context));
      dropped.push(...list.filter((c) => covered.has(c.context)).map((c) => c.context));
      if (keep.length > 0) rules.push({ ...rule, parameters: { ...rule.parameters, required_status_checks: keep } });
    }
    if (dropped.length === 0) continue;
    const what = `${dropped.map((c) => `"${c}"`).join(", ")} from the ruleset "${set.name}"`;
    const end = rules.length === 0 ? ", and disable the ruleset (it keeps its rules), because no rule is left" : "";
    if (!apply) {
      console.log(`would  ${repo}: remove ${what}${end}. "${CHECK}" covers them.`);
    } else if (rules.length === 0) {
      gh(["api", "-X", "PUT", `repos/${repo}/rulesets/${set.id}`, "--input", "-"], JSON.stringify({ enforcement: "disabled" }));
      console.log(`removed ${repo}: ${what}${end}.`);
    } else {
      const body = { name: set.name, target: set.target, enforcement: set.enforcement, conditions: set.conditions, bypass_actors: set.bypass_actors ?? [], rules };
      gh(["api", "-X", "PUT", `repos/${repo}/rulesets/${set.id}`, "--input", "-"], JSON.stringify(body));
      console.log(`removed ${repo}: ${what}.`);
    }
    changed++;
  }
  return changed;
}

/** The summary checks that the ruleset must name ("CI OK" first), and the ones that no rule of the branch names. */
export function missingChecks(passed: ReadonlySet<string>, required: readonly string[]): { wanted: string[]; missing: string[] } {
  const wanted = [...passed].sort((a, b) => (a === CHECK ? -1 : b === CHECK ? 1 : a.localeCompare(b)));
  return { wanted, missing: wanted.filter((c) => !required.includes(c)) };
}

/** The result of the check of one repository. */
export type CheckState =
  | { readonly repo: string; readonly state: "have"; readonly checks: readonly string[] }
  | { readonly repo: string; readonly state: "missing"; readonly missing: readonly string[]; readonly faults?: readonly string[] }
  | { readonly repo: string; readonly state: "no read"; readonly reason: string }
  | { readonly repo: string; readonly state: "no CI" };

/** The text of the column Checks for a state. */
function detailOf(s: CheckState): string {
  if (s.state === "have") return s.checks.join(", ");
  if (s.state === "no read") return s.reason;
  if (s.state === "no CI") return "no active workflow ci.yml";
  return [...(s.missing.length > 0 ? [`no ruleset names ${s.missing.join(", ")}`] : []), ...(s.faults ?? [])].join("; ");
}

/** The report of --check: a Markdown table, and the exit code (1 when a repository misses a check). */
export function checkReport(states: readonly CheckState[]): { text: string; code: number } {
  const order = { missing: 0, "no read": 1, have: 2, "no CI": 3 } as const;
  const sorted = [...states].sort((a, b) => order[a.state] - order[b.state] || a.repo.localeCompare(b.repo));
  const count = (state: CheckState["state"]): number => states.filter((s) => s.state === state).length;
  const lines = [
    "## The ruleset and the settings of each public repository",
    "",
    `${count("missing")} miss a check or a setting, ${count("no read")} no read, ${count("have")} have each check.${count("no CI") > 0 ? ` ${count("no CI")} have no CI.` : ""}`,
    "",
    "| Repository | State | Checks |",
    "| --- | --- | --- |",
  ];
  for (const s of sorted) if (s.state !== "no CI") lines.push(`| ${s.repo} | ${s.state} | ${detailOf(s)} |`);
  const noCi = sorted.filter((s) => s.state === "no CI").map((s) => s.repo);
  if (noCi.length > 0) lines.push("", `No CI (no active workflow ci.yml, so no check to require): ${noCi.join(", ")}.`);
  const missing = sorted.filter((s) => s.state === "missing");
  const checks = missing.filter((s) => s.missing.length > 0);
  const settings = missing.filter((s) => (s.faults ?? []).length > 0);
  if (checks.length > 0) {
    lines.push("", "Add the rulesets: `node scripts/workflows/ruleset-ci-ok.ts " + checks.map((s) => s.repo).join(" ") + " --only-summary --apply`");
  }
  for (const s of settings) {
    lines.push("", `Set the settings of ${s.repo}, with its clone next to the clone of the template: \`node scripts/stamp/settings.ts ${s.repo} --apply\``);
  }
  return { text: `${lines.join("\n")}\n`, code: missing.length > 0 ? 1 : 0 };
}

function check(repos: readonly string[]): number {
  const states: CheckState[] = [];
  for (const repo of repos) {
    try {
      const info = json<{ default_branch: string; fork: boolean; has_pages: boolean }>(["api", `repos/${repo}`]);
      const branch = info.default_branch;
      const rules = json<BranchRule[]>(["api", `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`]);
      const required = rules.filter((r) => r.type === "required_status_checks").flatMap((r) => r.parameters?.required_status_checks ?? []).map((c) => c.context);
      // The active workflows: a repository with no active ci.yml has no gate. A fork reads no setting.
      const workflows = json<{ workflows: { path: string; state: string }[] }>(["api", `repos/${repo}/actions/workflows?per_page=100`])
        .workflows.filter((w) => w.state === "active")
        .map((w) => w.path);
      const sbom = info.fork ? 200 : statusOf(["api", `repos/${repo}/dependency-graph/sbom`]);
      const { faults, unread } = settingsFaults({ fork: info.fork, required, workflows, hasPages: info.has_pages, sbom });
      const { passed } = passedSummaries(repo, branch);
      if (!passed.has(CHECK)) {
        if (faults.length > 0) states.push({ repo, state: "missing", missing: [], faults });
        else if (!workflows.includes(CI_WORKFLOW) && unread.length === 0) states.push({ repo, state: "no CI" });
        else states.push({ repo, state: "no read", reason: [`no "${CHECK}" that passed on the last 5 pull requests into ${branch}`, ...unread].join("; ") });
        continue;
      }
      const { wanted, missing } = missingChecks(passed, required);
      if (missing.length > 0 || faults.length > 0) states.push({ repo, state: "missing", missing, faults });
      else if (unread.length > 0) states.push({ repo, state: "no read", reason: unread.join("; ") });
      else states.push({ repo, state: "have", checks: wanted });
    } catch (error) {
      // The details go to the log only: the table has fixed text.
      process.stderr.write(`${repo}: ${error instanceof Error ? error.message : String(error)}\n`);
      states.push({ repo, state: "no read", reason: "the GitHub API gave an error (see the log)" });
    }
  }
  const { text, code } = checkReport(states);
  process.stdout.write(text);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") appendFileSync(summary, text);
  return code;
}

function main(argv: readonly string[]): number {
  const named = argv.filter((a) => !a.startsWith("--"));
  if (argv.includes("--check")) {
    if (argv.includes("--apply")) {
      process.stderr.write("--check changes nothing, so it does not go with --apply.\n");
      return 2;
    }
    return check(repositories(named));
  }
  const apply = argv.includes("--apply");
  const onlySummary = argv.includes("--only-summary");
  let added = 0;
  let changed = 0;
  for (const repo of repositories(named)) {
    const branch = json<{ default_branch: string }>(["api", `repos/${repo}`]).default_branch;
    const { passed, covered } = passedSummaries(repo, branch);
    if (!passed.has(CHECK)) {
      console.log(`skip   ${repo}: no "${CHECK}" that passed on the last 5 pull requests into ${branch}. Add the job ci-ok of the template first.`);
      continue;
    }
    // The rules that apply to the branch, from each ruleset of any name.
    const rules = json<BranchRule[]>(["api", `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`]);
    const checks = rules.filter((r) => r.type === "required_status_checks").flatMap((r) => r.parameters?.required_status_checks ?? []).map((c) => c.context);
    const { wanted, missing } = missingChecks(passed, checks);
    if (missing.length === 0) {
      console.log(`have   ${repo}: a ruleset names ${wanted.map((c) => `"${c}"`).join(" and ")} on ${branch}.`);
      if (onlySummary) changed += dropCovered(repo, covered, apply);
      continue;
    }
    if (!apply) {
      console.log(`would  ${repo}: add a ruleset for ${missing.map((c) => `"${c}"`).join(" and ")} on ${branch}.`);
      if (onlySummary) changed += dropCovered(repo, covered, apply);
      continue;
    }
    gh(["api", "-X", "POST", `repos/${repo}/rulesets`, "--input", "-"], JSON.stringify(rulesetBody(missing)));
    console.log(`added  ${repo}: a ruleset for ${missing.map((c) => `"${c}"`).join(" and ")} on ${branch}.`);
    added++;
    // The new ruleset names only summary checks, so step 4 does not change it.
    if (onlySummary) changed += dropCovered(repo, covered, apply);
  }
  const counts = onlySummary ? `${added} rulesets added, ${changed} rulesets with fewer checks.` : `${added} rulesets added.`;
  console.log(apply ? counts : "Nothing changed. Start again with --apply to change the rulesets.");
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
