// The settings of a new repository that a person sets on GitHub, not in its files (CI.md, "The settings of a new
// repository"). The stamp makes the files. After `gh repo create` and the push of the first commit, this script sets
// four settings, in this order:
//   1. The dependency graph and its alerts. Without it, the dependency review fails on each pull request.
//   2. A ruleset of the default branch. It needs each summary check ("CI OK", "Security OK") of the workflows of the
//      folder that start on a pull request.
//   3. The Pages source (the build type workflow), when the folder has the workflow pages.yml.
//   4. Auto-merge. It comes last: before the ruleset, `gh pr merge --auto` merges with no check.
// The ruleset stops a push to the default branch without its checks, so the script refuses a repository with no
// default branch yet: push the first commit first.
//
//   node scripts/stamp/settings.ts <owner/name> [--from <folder>] [--apply]
//
// Without --apply, the script only prints what it would do. --from is the folder of the stamped repository. Its
// default is the folder <name> next to the template, where the stamp puts it. A setting that the repository has
// already stays. The daily check scripts/workflows/ruleset-ci-ok.ts --check finds a repository that misses one.
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { childKeys, indentOf, keyValue, workflowLines } from "../../packages/conventions/src/workflow.ts";
import { errorText, gh, type Exec } from "../lib/gh.ts";
import { httpStatusOf, missingChecks, PAGES_WORKFLOW, rulesetBody, SUMMARY } from "../workflows/ruleset-ci-ok.ts";

/** This function gives the summary checks of a workflow that starts on a pull request: each job name of the form "<Name> OK". */
export function summaryChecks(text: string): string[] {
  const lines = workflowLines(text);
  const top = (key: string): number => lines.findIndex((line) => indentOf(line) === 0 && keyValue(line, key) !== undefined);
  const on = top("on");
  const jobs = top("jobs");
  if (on < 0 || jobs < 0) return [];
  // `on: pull_request`, `on: [push, pull_request]`, or one key for each trigger
  const value = keyValue(lines[on] ?? "", "on") ?? "";
  const triggers =
    value !== ""
      ? value.replace(/[[\]]/g, "").split(",").map((name) => name.trim())
      : childKeys(lines, on).map((at) => /^\s*["']?([A-Za-z_]+)["']?\s*:/.exec(lines[at] ?? "")?.[1] ?? "");
  if (!triggers.includes("pull_request")) return [];
  const names: string[] = [];
  for (const job of childKeys(lines, jobs)) {
    for (const at of childKeys(lines, job)) {
      const name = keyValue(lines[at] ?? "", "name");
      if (name !== undefined && SUMMARY.test(name)) names.push(name);
    }
  }
  return names;
}

/** The state of the settings of a repository on GitHub. */
export interface RepoState {
  /** The default branch has a commit. */
  readonly branch: boolean;
  /** The required checks of the default branch, from each ruleset of any name. */
  readonly required: readonly string[];
  readonly alerts: boolean;
  readonly hasPages: boolean;
  readonly autoMerge: boolean;
}

/** One setting: "do" with the arguments of gh (and a JSON body), or "have" and "skip" with no request. */
export interface Step {
  readonly setting: string;
  readonly state: "do" | "have" | "skip";
  readonly why: string;
  readonly args?: readonly string[];
  readonly body?: Record<string, unknown>;
}

/** This function gives the four settings of a new repository, in the order that they go on. */
export function birthSteps(repo: string, workflows: readonly string[], pagesWorkflow: boolean, state: RepoState): Step[] {
  const { wanted, missing } = missingChecks(new Set(workflows.flatMap(summaryChecks)), state.required);
  const steps: Step[] = [];
  steps.push(
    state.alerts
      ? { setting: "the dependency graph", state: "have", why: "it is on" }
      : { setting: "the dependency graph", state: "do", why: "the dependency review fails on each pull request without it", args: ["api", "-X", "PUT", `repos/${repo}/vulnerability-alerts`] },
  );
  if (wanted.length === 0) steps.push({ setting: "the ruleset", state: "skip", why: "no workflow that starts on a pull request has a summary check" });
  else if (missing.length === 0) steps.push({ setting: "the ruleset", state: "have", why: `a ruleset names ${wanted.join(", ")}` });
  else steps.push({ setting: "the ruleset", state: "do", why: `a pull request must pass ${missing.join(", ")}`, args: ["api", "-X", "POST", `repos/${repo}/rulesets`], body: rulesetBody(missing) });
  if (!pagesWorkflow) steps.push({ setting: "the Pages source", state: "skip", why: `the folder has no ${PAGES_WORKFLOW}` });
  else if (state.hasPages) steps.push({ setting: "the Pages source", state: "have", why: "the site has a source" });
  else steps.push({ setting: "the Pages source", state: "do", why: "the Pages run deploys from the workflow", args: ["api", "-X", "POST", `repos/${repo}/pages`, "-f", "build_type=workflow"] });
  steps.push(
    state.autoMerge
      ? { setting: "auto-merge", state: "have", why: "it is on" }
      : { setting: "auto-merge", state: "do", why: "gh pr merge --auto fails without it", args: ["api", "-X", "PATCH", `repos/${repo}`, "-F", "allow_auto_merge=true"] },
  );
  return steps;
}

/** This function gives the HTTP status of a request with no output: 200, or the status of the error of gh. */
async function statusOf(args: readonly string[], exec: Exec | undefined): Promise<number> {
  try {
    await gh([...args, "--silent"], { exec });
    return 200;
  } catch (error) {
    const status = httpStatusOf(errorText(error));
    if (status === undefined) throw error;
    return status;
  }
}

/** This function reads the state of the settings of a repository. */
export async function readState(repo: string, exec?: Exec): Promise<RepoState> {
  const info = JSON.parse(await gh(["api", `repos/${repo}`], { exec })) as { default_branch: string; has_pages: boolean; allow_auto_merge?: boolean };
  const path = encodeURIComponent(info.default_branch);
  const branch = (await statusOf(["api", `repos/${repo}/branches/${path}`], exec)) === 200;
  const rules = branch ? (JSON.parse(await gh(["api", `repos/${repo}/rules/branches/${path}`], { exec })) as { type: string; parameters?: { required_status_checks?: { context: string }[] } }[]) : [];
  const required = rules.filter((r) => r.type === "required_status_checks").flatMap((r) => r.parameters?.required_status_checks ?? []).map((c) => c.context);
  // GitHub gives 204 when the alerts are on, and 404 when they are off. The field allow_auto_merge needs the admin role.
  const alerts = (await statusOf(["api", `repos/${repo}/vulnerability-alerts`], exec)) === 200;
  return { branch, required, alerts, hasPages: info.has_pages, autoMerge: info.allow_auto_merge === true };
}

/** The options of one start: the repository, the stamped folder, --apply, the start of gh and the output. */
export interface SettingsOptions {
  readonly repo: string;
  readonly folder: string;
  readonly apply: boolean;
  readonly exec?: Exec;
  readonly log: (line: string) => void;
}

/** This function sets the settings of a repository, or prints them without --apply. It gives the exit code. */
export async function setSettings({ repo, folder, apply, exec, log }: SettingsOptions): Promise<number> {
  const dir = join(folder, ".github", "workflows");
  if (!existsSync(dir)) {
    log(`The folder ${folder} has no .github/workflows. Give the folder of the stamped repository with --from.`);
    return 2;
  }
  const workflows = readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => readFileSync(join(dir, name), "utf8"));
  const state = await readState(repo, exec);
  if (!state.branch) {
    log(`${repo} has no commit on its default branch. Push the first commit first: the ruleset stops a push without its checks.`);
    return 2;
  }
  for (const step of birthSteps(repo, workflows, existsSync(join(folder, PAGES_WORKFLOW)), state)) {
    if (step.state !== "do" || step.args === undefined) {
      log(`${step.state.padEnd(6)} ${step.setting}: ${step.why}.`);
      continue;
    }
    if (!apply) {
      log(`would  ${step.setting}: ${step.why}.`);
      continue;
    }
    let args = step.args;
    let temp: string | undefined;
    if (step.body !== undefined) {
      temp = mkdtempSync(join(tmpdir(), "settings-"));
      writeFileSync(join(temp, "body.json"), JSON.stringify(step.body));
      args = [...args, "--input", join(temp, "body.json")];
    }
    try {
      await gh([...args, "--silent"], { exec });
    } finally {
      if (temp !== undefined) rmSync(temp, { recursive: true, force: true });
    }
    log(`done   ${step.setting}: ${step.why}.`);
  }
  if (!apply) log("Nothing changed. Start again with --apply to set the settings.");
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { from: { type: "string" }, apply: { type: "boolean", default: false } } });
  const [repo] = positionals;
  if (repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    process.stderr.write("Usage: node scripts/stamp/settings.ts <owner/name> [--from <folder>] [--apply]\n");
    process.exitCode = 2;
  } else {
    const template = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const folder = resolve(values.from ?? join(template, "..", repo.split("/")[1] ?? ""));
    process.exitCode = await setSettings({ repo, folder, apply: values.apply, log: (line) => console.log(line) });
  }
}
