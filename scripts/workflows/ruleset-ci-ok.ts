// The ruleset of main of each repository: a pull request must pass the check "CI OK" (CI.md, "The
// check of the ruleset"). The owner approves it once, and then Claude can start it.
//
//   node scripts/workflows/ruleset-ci-ok.ts [<owner/repo> ...] [--apply]
//
// Without --apply, the script only prints what it would do. For each repository:
//   1. It reads the check runs of the last 10 commits of the default branch. A repository where none
//      of them has a "CI OK" that passed is skipped. A rule for a check that never starts blocks
//      each pull request.
//   2. It reads the rules of the branch. When a ruleset of any name names "CI OK", nothing changes.
//      The other checks that a ruleset names stay (CI OK needs those jobs, so they are redundant).
//   3. With --apply, it adds the ruleset "CI OK": the default branch, the check "CI OK", the
//      integration GitHub Actions, and no bypass. The other rulesets do not change.
//
// With no repository, the script uses each public repository of mark1russell7 that is not archived.
import { execFileSync } from "node:child_process";

const CHECK = "CI OK";
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

// The last commit can still be in CI, so the script examines the last 10 commits of the branch.
function hasPassed(repo: string, branch: string): boolean {
  const commits = json<{ sha: string }[]>(["api", `repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=10`]);
  return commits.some((c) => {
    const runs = json<{ check_runs: CheckRun[] }>(["api", `repos/${repo}/commits/${c.sha}/check-runs?check_name=${encodeURIComponent(CHECK)}&per_page=10`]);
    return runs.check_runs.some((r) => r.conclusion === "success");
  });
}

function main(argv: readonly string[]): void {
  const apply = argv.includes("--apply");
  const named = argv.filter((a) => !a.startsWith("--"));
  let added = 0;
  for (const repo of repositories(named)) {
    const branch = json<{ default_branch: string }>(["api", `repos/${repo}`]).default_branch;
    if (!hasPassed(repo, branch)) {
      console.log(`skip   ${repo}: no "${CHECK}" that passed on ${branch}. Add the job ci-ok of the template first.`);
      continue;
    }
    // The rules that apply to the branch, from each ruleset of any name.
    const rules = json<BranchRule[]>(["api", `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`]);
    const checks = rules.filter((r) => r.type === "required_status_checks").flatMap((r) => r.parameters?.required_status_checks ?? []).map((c) => c.context);
    if (checks.includes(CHECK)) {
      console.log(`have   ${repo}: a ruleset names "${CHECK}" on ${branch}.`);
      continue;
    }
    if (!apply) {
      console.log(`would  ${repo}: add the ruleset "${CHECK}" on ${branch}.`);
      continue;
    }
    const body = {
      name: CHECK,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: CHECK, integration_id: ACTIONS_APP }] } }],
    };
    gh(["api", "-X", "POST", `repos/${repo}/rulesets`, "--input", "-"], JSON.stringify(body));
    console.log(`added  ${repo}: the ruleset "${CHECK}" on ${branch}.`);
    added++;
  }
  console.log(apply ? `${added} rulesets added.` : "Nothing changed. Start again with --apply to add the rulesets.");
}

main(process.argv.slice(2));
