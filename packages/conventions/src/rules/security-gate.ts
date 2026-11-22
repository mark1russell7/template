/**
 * The rule `security-gate`: a repository with the gate `ci.yml` also has the gate `security.yml`, with its one job
 * `Security OK` (CI.md, "The check of the ruleset"). The stamp gives the file to each new repository. This rule finds an
 * older repository with no security gate, and its fix writes the file of the template.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import { repositoryOfRemote, type Break, type Rule } from "../rule.ts";
import { WORKFLOW, keyValue } from "../workflow.ts";
import { repositoryIsPublic } from "./license-file.ts";
import { scheduleMinute } from "./runner-budget.ts";
import { SECURITY_SCAN_COMMIT } from "./security-one-job.ts";
import { startsOnPullRequest } from "./summary-job.ts";

/** The path of the security gate in a repository. */
export const SECURITY_FILE: string = ".github/workflows/security.yml";

/** The action security-scan of the template, in the template (`./`) and pinned in another repository. */
const SCAN_ACTIONS: readonly string[] = ["./.github/actions/security-scan", "mark1russell7/template/.github/actions/security-scan"];

/** The deprecated shared workflow of the scans. The rule `security-one-job` changes its caller to one job. */
const REUSABLE_SECURITY: readonly string[] = [".github/workflows/reusable-security.yml", ".github/workflows/reusable-security.yaml"];

/**
 * This function tells if a workflow is a security gate. A security gate has a job `Security OK`, a step with the action
 * security-scan, or a job that uses the shared workflow of the scans. It reads each line with the reader of the workflows.
 */
export function isSecurityGate(text: string): boolean {
  return text.split("\n").some((line) => {
    if (keyValue(line, "name") === "Security OK") return true;
    const target = (keyValue(line, "uses") ?? "").split("@")[0] ?? "";
    return SCAN_ACTIONS.includes(target) || REUSABLE_SECURITY.some((file) => target === `./${file}` || target.endsWith(`/${file}`));
  });
}

/**
 * The lines of `.github/workflows/security.yml` of the template, as the stamp writes them into a new repository: the
 * action is pinned to a commit. A test of the template holds them equal to its file. `@COMMIT` is the pin of the
 * action, and `MINUTE` is the minute of the schedule.
 */
const STANDARD: readonly string[] = [
  "# The security scans of this repository (the action security-scan, CI.md): dependency review, osv-scanner and",
  "# CodeQL, in one job. A pull request fails only for a new finding at or above high.",
  "# Other repositories use mark1russell7/template/.github/actions/security-scan@<commit> # main",
  "name: Security",
  "",
  "on:",
  "  pull_request:",
  "  push:",
  "    branches: [main]",
  "  # A weekly scan finds the new advisories for the dependencies that do not change. The minute comes from the",
  "  # repository and the file (the rule runner-budget), so the scans of the repositories do not start together.",
  "  schedule:",
  '    - cron: "MINUTE 5 * * 1"',
  "  workflow_dispatch:",
  "",
  "permissions: {}",
  "",
  "concurrency:",
  "  group: security-${{ github.event_name == 'pull_request' && github.ref || github.sha }}",
  "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
  "",
  "defaults:",
  "  run:",
  "    shell: bash",
  "",
  "jobs:",
  "  # The one check of this file that the ruleset of main names, next to CI OK (CI.md, \"The check of the",
  "  # ruleset\"). The scans run in this job, so a run asks for one runner. The last step of the action fails when",
  "  # a scan fails, and names that scan. The scans stay out of ci.yml, because release.yml calls ci.yml with",
  "  # contents: read only.",
  "  security-ok:",
  "    name: Security OK",
  "    runs-on: ubuntu-latest",
  "    # The time limit of the three scans together",
  "    timeout-minutes: 30",
  "    # security-events: write uploads the results (not on a pull request). actions: read lets CodeQL and the",
  "    # upload read the run in a private repository.",
  "    permissions:",
  "      contents: read",
  "      security-events: write",
  "      actions: read",
  "    steps:",
  "      # The template runs the action of this commit, so it checks out the folder of the actions first. A",
  "      # repository that pins the action to a commit needs no such step: the action checks out the repository.",
  "      # The stamp copies this file, so the step runs only in the template. In a private repository, its partial",
  "      # clone makes the later checkout of the base fail: the fetch from the promisor remote has no credentials.",
  "      - if: github.repository == 'mark1russell7/template'",
  "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "        with:",
  "          sparse-checkout: .github/actions",
  "          persist-credentials: false",
  "      - uses: mark1russell7/template/.github/actions/security-scan@COMMIT # main",
];

/** This function gives the security gate of a repository. It is the file of the template, with the pin of the action and the minute of the repository. */
export function securityWorkflow(repository: string, commit: string = SECURITY_SCAN_COMMIT): string {
  const minute = String(scheduleMinute(repository, SECURITY_FILE));
  return `${STANDARD.join("\n").replace("@COMMIT", `@${commit}`).replace('"MINUTE ', `"${minute} `)}\n`;
}

export const securityGate: Rule = {
  id: "security-gate",
  failsFrom: "2026-12-07",
  title: "A repository with the gate ci.yml has the gate security.yml: the scans of the action security-scan in one job Security OK.",
  reason:
    'The ruleset of main names the summary checks "CI OK" and "Security OK" (CI.md, "The check of the ruleset"). With no security gate, a pull request can add a dependency with a known advisory, and no scan reads the code. On 2026-11-22, 16 of 61 public repositories of the account had "CI OK" and no "Security OK".',
  fix: 'Add .github/workflows/security.yml of the template: the fix writes it, with the action security-scan pinned and the minute of the repository. In a repository that uses the default setup of code scanning, give the input codeql: "false", because the two conflict. Then add "Security OK" to the ruleset of main (ruleset-ci-ok.ts --only-summary in the template).',
  sources: [{ repo: "private", rule: "security-gate", doc: "a decision of 2026-11-22 (the daily check of the rulesets of 61 public repositories)" }],
  options: {},
  check(context) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const workflows = files.filter((path) => WORKFLOW.test(path)).sort(byCode);
    const read = (file: string): string | undefined => {
      try {
        return readFileSync(join(context.root, file), "utf8");
      } catch {
        return undefined;
      }
    };
    const ci = workflows.find((path) => path.slice(path.lastIndexOf("/") + 1) === "ci.yml");
    const ciText = ci === undefined ? undefined : read(ci);
    if (ciText === undefined || !startsOnPullRequest(ciText)) return { skipped: "the repository has no gate ci.yml that starts on a pull request" };
    // The fix writes a file that git does not track yet, and the second pass of the fix reads it
    const onDisk = existsSync(join(context.root, SECURITY_FILE));
    const candidates = onDisk && !workflows.includes(SECURITY_FILE) ? [...workflows, SECURITY_FILE] : workflows;
    if (candidates.some((file) => isSecurityGate(read(file) ?? ""))) return [];
    // A private repository has no paid Actions minutes, and CodeQL and the dependency review run only in a public repository
    const visibility = repositoryIsPublic(context);
    if (visibility === false) return { skipped: "the repository is private" };
    // Outside a run of GitHub Actions, no event file gives the visibility. The rule writes no file for public repositories into
    // a repository that can be private. CI and the release train give the event file
    if (visibility === undefined) return { skipped: "no event file of GitHub Actions gives the visibility of the repository" };
    const message = "The repository has the gate ci.yml and no security gate (a job \"Security OK\" with the action security-scan).";
    if (onDisk) return [{ file: SECURITY_FILE, message, fix: `A person must change it, because ${SECURITY_FILE} is there and is not a security gate. ${securityGate.fix}` }];
    const remote = context.git(["remote", "get-url", "origin"]);
    const repository = context.env["GITHUB_REPOSITORY"] ?? (remote === undefined ? undefined : repositoryOfRemote(remote));
    const outcome: Break =
      repository === undefined
        ? { file: SECURITY_FILE, message, fix: `A person must add it, because the repository has no remote origin to give the minute of its schedule. ${securityGate.fix}` }
        : { file: SECURITY_FILE, message, edits: [{ file: SECURITY_FILE, before: "", after: securityWorkflow(repository) }] };
    return [outcome];
  },
};
