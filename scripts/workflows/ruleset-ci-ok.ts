// The ruleset of main of each repository: a pull request must pass each summary check of the gate, the
// checks with a name "<Name> OK" such as "CI OK", "Security OK" and "Xplat OK" (CI.md, "The check of the
// ruleset"). The owner starts it, because a ruleset is a setting of the repository.
//
//   node scripts/workflows/ruleset-ci-ok.ts [<owner/repo> ...] [--apply]
//
// Without --apply, the script only prints what it would do. For each repository:
//   1. It reads the check runs of the head commits of the last 5 pull requests that merged into the default
//      branch. It uses the newest one where "CI OK" passed, and keeps each summary check that passed there.
//      (A pull request whose checks ran before "CI OK" came to main can merge later without it.) A ruleset applies to pull requests, so
//      this is the proof that each check starts on a pull request. A check that starts only on a push
//      to main never runs on a pull request, and a rule for it blocks each pull request. A repository
//      where "CI OK" did not pass there is skipped.
//   2. It reads the rules of the branch, from each ruleset of any name. A check that a ruleset names
//      already is not added again. The other checks that a ruleset names stay.
//   3. With --apply, it adds one ruleset for the missing checks: the default branch, the integration
//      GitHub Actions, and no bypass. Its name is the first missing check. The other rulesets do not change.
//
// With no repository, the script uses each public repository of mark1russell7 that is not archived.
import { execFileSync } from "node:child_process";

const CHECK = "CI OK";
// The name of a summary job: one word or more, the first with a capital letter, then " OK" ("Joint bench OK").
const SUMMARY = /^[A-Z][A-Za-z0-9]*( [A-Za-z0-9]+)* OK$/;
const OWNER = "mark1russell7";
// The app id of GitHub Actions, so that only a check of Actions passes the rule.
const ACTIONS_APP = 15368;

function gh(args: readonly string[], input?: string): string {
  return execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
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
}

interface BranchRule {
  readonly type: string;
  readonly parameters?: { readonly required_status_checks?: readonly { readonly context: string }[] };
}

function repositories(named: readonly string[]): string[] {
  if (named.length > 0) return [...named];
  const repos = json<Repo[]>(["repo", "list", OWNER, "--visibility", "public", "--no-archived", "--limit", "500", "--json", "nameWithOwner,defaultBranchRef"]);
  return repos.filter((r) => r.defaultBranchRef !== null).map((r) => r.nameWithOwner);
}

// The summary checks that passed on the head of the newest of the last 5 merged pull requests where "CI OK" passed.
function passedSummaries(repo: string, branch: string): Set<string> {
  const passed = new Set<string>();
  const pulls = json<{ merged_at: string | null; head: { sha: string } }[]>(["api", `repos/${repo}/pulls?state=closed&base=${encodeURIComponent(branch)}&sort=updated&direction=desc&per_page=30`]);
  const merged = pulls.filter((p) => p.merged_at !== null).sort((a, b) => (b.merged_at as string).localeCompare(a.merged_at as string)).slice(0, 5);
  for (const pull of merged) {
    const runs = json<{ check_runs: CheckRun[] }>(["api", `repos/${repo}/commits/${pull.head.sha}/check-runs?per_page=100`]);
    for (const r of runs.check_runs) if (SUMMARY.test(r.name) && r.conclusion === "success") passed.add(r.name);
    if (passed.has(CHECK)) return passed;
    passed.clear();
  }
  return passed;
}

function main(argv: readonly string[]): void {
  const apply = argv.includes("--apply");
  const named = argv.filter((a) => !a.startsWith("--"));
  let added = 0;
  for (const repo of repositories(named)) {
    const branch = json<{ default_branch: string }>(["api", `repos/${repo}`]).default_branch;
    const passed = passedSummaries(repo, branch);
    if (!passed.has(CHECK)) {
      console.log(`skip   ${repo}: no "${CHECK}" that passed on the last 5 pull requests into ${branch}. Add the job ci-ok of the template first.`);
      continue;
    }
    // The rules that apply to the branch, from each ruleset of any name.
    const rules = json<BranchRule[]>(["api", `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`]);
    const checks = rules.filter((r) => r.type === "required_status_checks").flatMap((r) => r.parameters?.required_status_checks ?? []).map((c) => c.context);
    const wanted = [...passed].sort((a, b) => (a === CHECK ? -1 : b === CHECK ? 1 : a.localeCompare(b)));
    const missing = wanted.filter((c) => !checks.includes(c));
    if (missing.length === 0) {
      console.log(`have   ${repo}: a ruleset names ${wanted.map((c) => `"${c}"`).join(" and ")} on ${branch}.`);
      continue;
    }
    if (!apply) {
      console.log(`would  ${repo}: add a ruleset for ${missing.map((c) => `"${c}"`).join(" and ")} on ${branch}.`);
      continue;
    }
    const body = {
      name: missing[0],
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: missing.map((context) => ({ context, integration_id: ACTIONS_APP })) } }],
    };
    gh(["api", "-X", "POST", `repos/${repo}/rulesets`, "--input", "-"], JSON.stringify(body));
    console.log(`added  ${repo}: a ruleset for ${missing.map((c) => `"${c}"`).join(" and ")} on ${branch}.`);
    added++;
  }
  console.log(apply ? `${added} rulesets added.` : "Nothing changed. Start again with --apply to add the rulesets.");
}

main(process.argv.slice(2));
