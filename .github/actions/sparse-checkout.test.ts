// Tests that each job with a sparse checkout has each file that it reads from that checkout. A sparse checkout in cone
// mode has the files of the root folder and of each folder that it names. The job pull of reusable-ci.yml checks out only
// .github/actions. Thus its action pull-of-run reads only its own folder and the root files of the template. The test reads
// the uses lines and the run lines of each job, and each path of a local action three folders up from its folder.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");

/** A checkout step of a job: its folder, and the folders of a sparse checkout (none for a full checkout). */
interface Checkout {
  readonly path: string;
  readonly folders: readonly string[];
}

/** One file that a job reads from the folder of a checkout, with the text that names it. */
interface Read {
  readonly job: string;
  readonly checkout: Checkout;
  readonly path: string;
  readonly source: string;
}

/** The text of an action of the template, or undefined when the template has no such action. */
type ActionText = (folder: string) => string | undefined;

const actionOfTemplate: ActionText = (folder) => {
  const file = resolve(root, folder, "action.yml");
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};

/** A path with no quotes, no "./" at the start and no "/" at the end. The path "." is the root, "". */
function clean(path: string): string {
  const bare = path.trim().replace(/^["']|["']$/gu, "").replace(/\/+$/u, "");
  return bare === "." ? "" : bare.replace(/^\.\//u, "");
}

/** The text of each job of a workflow, by the name of the job. */
function jobsOf(text: string): Map<string, string> {
  const jobs = new Map<string, string>();
  const start = /^jobs:\s*$/mu.exec(text);
  if (start === null) return jobs;
  const body = text.slice(start.index);
  const heads = [...body.matchAll(/^ {2}([\w-]+):\s*$/gmu)];
  heads.forEach((head, index) => jobs.set(head[1] ?? "", body.slice(head.index, heads[index + 1]?.index ?? body.length)));
  return jobs;
}

/** The text of each step of a job, with no comment lines. */
function stepsOf(job: string): string[] {
  const start = /^ {4}steps:\s*$/mu.exec(job);
  if (start === null) return [];
  const body = job.slice(start.index).replace(/^\s*#.*\n/gmu, "");
  const heads = [...body.matchAll(/^ {6}- /gmu)];
  return heads.map((head, index) => body.slice(head.index, heads[index + 1]?.index ?? body.length));
}

/** The checkout of a step, or undefined when the step is not a checkout. */
function checkoutOf(step: string): Checkout | undefined {
  if (!/^ {6}(?:- | {2})uses: actions\/checkout@/mu.test(step)) return undefined;
  const path = clean(/^ {10}path: (.+)$/mu.exec(step)?.[1] ?? "");
  const block = /^ {10}sparse-checkout: \|\s*\n((?: {12}.*(?:\n|$))+)/mu.exec(step)?.[1];
  const line = /^ {10}sparse-checkout: (?!\|)(.+)$/mu.exec(step)?.[1];
  const entries = block !== undefined ? block.split("\n") : line !== undefined ? [line] : [];
  return { path, folders: entries.map(clean).filter((entry) => entry !== "") };
}

/** True when a checkout has a path: a full checkout has each path, and a sparse one has the root files and its folders. */
function has(checkout: Checkout, path: string): boolean {
  if (checkout.folders.length === 0 || !path.includes("/")) return true;
  return checkout.folders.some((folder) => path === folder || path.startsWith(`${folder}/`));
}

/** The paths that each step of a job reads from the folder of a checkout that a step before it made. */
function readsOf(job: string, text: string, actionText: ActionText): Read[] {
  const checkouts = new Map<string, Checkout>();
  const reads: Read[] = [];
  for (const step of stepsOf(text)) {
    const checkout = checkoutOf(step);
    if (checkout !== undefined) {
      checkouts.set(checkout.path, checkout);
      continue;
    }
    // A local action: its folder, and each file three folders up, in the root of the tree that has the action
    const uses = /^ {6}(?:- | {2})uses: \.\/(?:(.+?)\/)?(\.github\/actions\/[\w-]+)\s*$/mu.exec(step);
    const from = uses === null ? undefined : checkouts.get(clean(uses[1] ?? ""));
    const action = uses?.[2];
    if (from !== undefined && action !== undefined) {
      reads.push({ job, checkout: from, path: action, source: `uses: ${uses?.[0].trim()}` });
      for (const match of actionText(action)?.matchAll(/\$GITHUB_ACTION_PATH\/\.\.\/\.\.\/\.\.\/([\w.@/-]+)/gu) ?? []) {
        reads.push({ job, checkout: from, path: (match[1] ?? "").replace(/[./]+$/u, ""), source: `${action}/action.yml: ${match[0]}` });
      }
    }
    // A path in the folder of a checkout that is not the root, in each line of the step
    for (const made of checkouts.values()) {
      if (made.path === "") continue;
      const folder = made.path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      for (const match of step.matchAll(new RegExp(`(?<![\\w.-])${folder}/([\\w.@/-]+)`, "gu"))) {
        reads.push({ job, checkout: made, path: (match[1] ?? "").replace(/[./]+$/u, ""), source: match[0] });
      }
    }
  }
  return reads;
}

/** Each read of each job of each workflow of the template. */
function readsOfTemplate(): Read[] {
  const folder = resolve(root, ".github/workflows");
  return readdirSync(folder)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .flatMap((name) =>
      [...jobsOf(readFileSync(resolve(folder, name), "utf8"))].flatMap(([job, text]) => readsOf(`${name} ${job}`, text, actionOfTemplate)),
    );
}

describe("sparse checkouts", () => {
  const reads = readsOfTemplate();

  it("finds the reads of the job pull of reusable-ci.yml and of the job queue of reusable-queue.yml", () => {
    const of = (job: string): string[] => reads.filter((one) => one.job === job).map((one) => `${one.checkout.folders.join(",")} ${one.path}`);
    assert.ok(of("reusable-ci.yml pull").includes(".github/actions .github/actions/pull-of-run"));
    assert.ok(of("reusable-ci.yml pull").includes(".github/actions pnpm-lock.yaml"));
    assert.ok(of("reusable-queue.yml queue").includes("scripts/workflows,.github/actions/pull-of-run .github/actions/pull-of-run/locked-version.ts"));
  });

  it("gives each job each file that it reads from a sparse checkout", () => {
    const missing = reads.filter((one) => !has(one.checkout, one.path)).map((one) => `${one.job}: ${one.source} (${one.checkout.folders.join(", ")})`);
    assert.deepEqual(missing, []);
  });

  it("reports a file of an action that is not in the sparse checkout of the job", () => {
    const workflow = [
      "jobs:",
      "  pull:",
      "    steps:",
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "        with:",
      "          path: .shared-actions",
      "          sparse-checkout: .github/actions",
      "      # A comment names .shared-actions/docs/a.md, and the test does not read it",
      "      - uses: ./.shared-actions/.github/actions/demo",
      "",
    ].join("\n");
    const action = 'run: node "$GITHUB_ACTION_PATH/../../../scripts/workflows/locked-version.ts" "$GITHUB_ACTION_PATH/../../../pnpm-lock.yaml"';
    const found = readsOf("demo.yml pull", jobsOf(workflow).get("pull") ?? "", (folder) => (folder === ".github/actions/demo" ? action : undefined));
    assert.deepEqual(
      found.map((one) => [one.path, has(one.checkout, one.path)]),
      [
        [".github/actions/demo", true],
        ["scripts/workflows/locked-version.ts", false],
        ["pnpm-lock.yaml", true],
        [".github/actions/demo", true],
      ],
    );
  });

  it("reads each line of a sparse checkout in a block, and a full checkout has each path", () => {
    const step = [
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "        with:",
      "          path: .queue-template",
      "          sparse-checkout: |",
      "            scripts/workflows",
      "            .github/actions/pull-of-run/",
      "          persist-credentials: false",
      "",
    ].join("\n");
    assert.deepEqual(checkoutOf(step), { path: ".queue-template", folders: ["scripts/workflows", ".github/actions/pull-of-run"] });
    assert.equal(has({ path: "", folders: [] }, "packages/site-pages/src/check/main.ts"), true);
    assert.equal(has({ path: ".x", folders: ["scripts/workflows"] }, "scripts/workflows-old/a.ts"), false);
  });
});
