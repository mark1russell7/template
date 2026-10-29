// The tests of bump-pins.ts: node --test scripts/release/

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  branchName,
  bumpRepo,
  changesVersion,
  commitSubject,
  findPins,
  parseArgs,
  prTitle,
  releaseBlockers,
  replacePins,
  resolveTarget,
  workflowPath,
  type Commit,
  type Pull,
  type PullFile,
  type ReleaseRun,
} from "./bump-pins.ts";

/** The state of the gh mock: the workflow path and text, the open pull requests, their files, the runs and the compare. */
interface GhState {
  readonly path?: string;
  readonly text?: string;
  readonly pulls?: readonly Pull[];
  readonly files?: Readonly<Record<string, readonly PullFile[]>>;
  readonly runs?: readonly ReleaseRun[];
  readonly compare?: string;
  readonly commits?: readonly Commit[];
  readonly fail?: Readonly<Record<string, string>>;
}

/** The JSON input of a write call of gh: a branch, a commit of the file or a pull request. */
interface GhInput {
  readonly ref?: string;
  readonly sha?: string;
  readonly branch?: string;
  readonly content?: string;
  readonly message?: string;
  readonly title?: string;
  readonly head?: string;
  readonly base?: string;
  readonly body?: string;
}

/** One call of the gh mock. */
interface GhCall {
  readonly args: readonly string[];
  readonly input: GhInput | undefined;
}

const OLD = "1111111111111111111111111111111111111111";
const OLDER = "2222222222222222222222222222222222222222";
const TARGET = "40b0fbd09ca4c07c451a5f9ca72d40eb62128d99";
const HEAD = "3333333333333333333333333333333333333333";
const BLOB = "4444444444444444444444444444444444444444";
const CHECKOUT = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const REPO = "owner/repo";

const workflow = (build: string = OLD, publish: string = OLD, tag: string = OLD): string =>
  [
    "jobs:",
    "  build:",
    `    uses: mark1russell7/template/.github/workflows/reusable-release-build.yml@${build} # main`,
    "  publish:",
    "    steps:",
    `      - uses: actions/checkout@${CHECKOUT} # v7.0.1`,
    `      - uses: mark1russell7/template/.github/actions/npm-publish@${publish} # main`,
    "  tag:",
    `    uses: mark1russell7/template/.github/workflows/reusable-release-tag.yml@${tag} # main`,
    "",
  ].join("\n");

/**
 * This function gives a mock of gh for one repository on GitHub, and records each call. `state` sets the
 * workflow path and text, the open pull requests, their package.json files, the active runs and the compare status.
 */
function github(state: GhState = {}) {
  const {
    path: file = ".github/workflows/release.yml",
    text = workflow(),
    pulls = [],
    files = {},
    runs = [],
    compare = "ahead",
    commits = [{ sha: TARGET, message: 'release: an optional "latest" entry (s3) (#40)\n\nbody' }],
    fail = {},
  } = state;
  const calls: GhCall[] = [];
  const run = (args: readonly string[], input?: string): string => {
    const call: GhCall = { args, input: input === undefined ? undefined : (JSON.parse(input) as GhInput) };
    calls.push(call);
    const [, ...rest] = args;
    const method = rest[0] === "-X" ? rest[1] : "GET";
    const path = args.find((arg) => /^repos\//.test(arg));
    const key = `${method} ${path}`;
    for (const [pattern, error] of Object.entries(fail)) if (key.includes(pattern)) throw new Error(error);
    if (key === `GET repos/${REPO}/git/ref/heads/main`) return `${HEAD}\n`;
    if (key === `GET repos/${REPO}/contents/${file}?ref=${HEAD}`) {
      return JSON.stringify({ sha: BLOB, encoding: "base64", content: Buffer.from(text).toString("base64").replace(/(.{60})/g, "$1\n") });
    }
    if (key.startsWith("GET repos/mark1russell7/template/compare/")) return JSON.stringify({ status: compare, commits });
    if (key === `GET repos/${REPO}/actions/workflows/release.yml/runs?per_page=30`) return runs.map((r) => JSON.stringify(r)).join("\n");
    if (key === `GET repos/${REPO}/pulls?state=open&base=main&per_page=100`) return pulls.map((p) => JSON.stringify(p)).join("\n");
    const filesMatch = /^GET repos\/owner\/repo\/pulls\/(\d+)\/files/.exec(key);
    if (filesMatch) return (files[filesMatch[1] ?? ""] ?? []).map((f) => JSON.stringify(f)).join("\n");
    if (key === `POST repos/${REPO}/git/refs`) return `${call.input?.ref}\n`;
    if (key === `PUT repos/${REPO}/contents/${file}`) return "5555555\n";
    if (key === `POST repos/${REPO}/pulls`) return "https://github.com/owner/repo/pull/7\n";
    if (key.startsWith("DELETE ")) return "";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const writes = (): GhCall[] => calls.filter(({ args }) => args.includes("-X"));
  /** The JSON input of a write call, in the sequence of the writes. */
  const sent = (index: number): GhInput => {
    const written = writes()[index]?.input;
    assert.ok(written, `the write call ${index} has an input`);
    return written;
  };
  return { run, calls, writes, sent };
}

test("findPins() finds only the pins of the template that follow main", () => {
  const text = `${workflow()}    uses: mark1russell7/template/.github/actions/other@${OLD} # v1\n    uses: mark1russell7/template/.github/actions/short@1111111 # main\n`;
  assert.deepEqual(findPins(text), [
    { path: ".github/workflows/reusable-release-build.yml", sha: OLD },
    { path: ".github/actions/npm-publish", sha: OLD },
    { path: ".github/workflows/reusable-release-tag.yml", sha: OLD },
  ]);
  assert.deepEqual(findPins("jobs: {}\n"), []);
});

test("replacePins() changes only the commits of the template pins, and keeps the line ends", () => {
  const text = workflow(OLD, OLDER, OLD).replaceAll("\n", "\r\n");
  const out = replacePins(text, TARGET);
  assert.equal(out, workflow(TARGET, TARGET, TARGET).replaceAll("\n", "\r\n"));
  assert.ok(out.includes(`actions/checkout@${CHECKOUT} # v7.0.1`));
  assert.equal(replacePins(out, TARGET), out);
});

test("changesVersion() finds a changed version field, and a package.json without a patch", () => {
  assert.equal(changesVersion([{ filename: "packages/a/package.json", patch: '@@ -2,3 +2,3 @@\n-  "version": "1.0.0",\n+  "version": "1.1.0",' }]), true);
  assert.equal(changesVersion([{ filename: "package.json", patch: '@@ -9 +9 @@\n-    "vitest": "^4.1.0"\n+    "vitest": "^4.2.0"' }]), false);
  assert.equal(changesVersion([{ filename: "package.json", patch: '@@ -1 +1 @@\n   "version": "1.0.0",\n-  "private": true' }]), false);
  assert.equal(changesVersion([{ filename: "package.json" }]), true);
  assert.equal(changesVersion([]), false);
});

test("releaseBlockers() names each version pull request and each active release run", () => {
  const pulls = [
    { number: 1, head: "changeset-release/main", url: "u1" },
    { number: 2, head: "release/1.2.0", url: "u2" },
    { number: 3, head: "feature", url: "u3" },
    { number: 4, head: "renovate/npm-patch", url: "u4" },
    { number: 5, head: branchName(TARGET), url: "u5" },
  ];
  const files: Readonly<Record<number, readonly PullFile[]>> = { 3: [{ filename: "package.json", patch: '+  "version": "2.0.0",' }], 4: [{ filename: "package.json", patch: '+    "tsx": "^4.23.16"' }] };
  const asked: number[] = [];
  const reasons = releaseBlockers({
    pulls,
    filesOf: (number) => {
      asked.push(number);
      return files[number] ?? [];
    },
    runs: [{ status: "in_progress", url: "r1" }],
    ownBranch: branchName(TARGET),
  });
  assert.deepEqual(reasons, [
    "a run of release.yml is in progress: r1",
    "the open pull request #1 is on the version branch changeset-release/main: u1",
    "the open pull request #2 is on the version branch release/1.2.0: u2",
    "the open pull request #3 changes the version of a package.json: u3",
  ]);
  // A version branch needs no files. The pull request of this script does not count.
  assert.deepEqual(asked, [3, 4]);
  assert.deepEqual(releaseBlockers({ pulls: [], filesOf: () => [], runs: [] }), []);
});

test("bumpRepo() makes a branch, commits the new release.yml and opens the pull request", () => {
  const gh = github();
  const result = bumpRepo(REPO, { target: TARGET, notes: "The tag plan gets a `latest` field.", coAuthor: "A <a@b.c>", footer: "FOOTER" }, gh.run);
  assert.equal(result.result, "opened");
  assert.equal(result.url, "https://github.com/owner/repo/pull/7");
  const [ref, put, pull] = [gh.sent(0), gh.sent(1), gh.sent(2)];
  assert.deepEqual(ref, { ref: `refs/heads/${branchName(TARGET)}`, sha: HEAD });
  assert.equal(put.branch, branchName(TARGET));
  assert.equal(put.sha, BLOB);
  assert.equal(Buffer.from(put.content ?? "", "base64").toString("utf8"), workflow(TARGET, TARGET, TARGET));
  assert.match(put.message ?? "", /^ci: move the template release pins to 40b0fbd\n/);
  assert.ok((put.message ?? "").endsWith("\n\nCo-Authored-By: A <a@b.c>"));
  assert.equal(pull.title, prTitle(TARGET));
  assert.equal(pull.head, branchName(TARGET));
  assert.equal(pull.base, "main");
  assert.match(pull.body ?? "", /The tag plan gets a `latest` field\./);
  assert.match(pull.body ?? "", /\(mark1russell7\/template#40\)/);
  assert.match(pull.body ?? "", /bump-pins\.ts --check owner\/repo/);
  assert.ok((pull.body ?? "").endsWith("FOOTER\n"));
});

test("bumpRepo() with dryRun does the checks and changes nothing", () => {
  const gh = github();
  const result = bumpRepo(REPO, { target: TARGET, dryRun: true }, gh.run);
  assert.equal(result.result, "planned");
  assert.match(result.text, /3 of 3 pins from 1111111 to 40b0fbd/);
  assert.deepEqual(gh.writes(), []);
});

test("bumpRepo() skips a repository with no pin, or with each pin at the target", () => {
  for (const text of ["jobs: {}\n", workflow(TARGET, TARGET, TARGET)]) {
    const gh = github({ text });
    assert.equal(bumpRepo(REPO, { target: TARGET }, gh.run).result, "skipped");
    assert.deepEqual(gh.writes(), []);
  }
  const missing = github({ fail: { "contents/": "gh: Not Found (HTTP 404)" } });
  assert.deepEqual(bumpRepo(REPO, { target: TARGET }, missing.run).result, "skipped");
});

test("bumpRepo() moves only the old pins", () => {
  const gh = github({ text: workflow(TARGET, OLD, TARGET) });
  const result = bumpRepo(REPO, { target: TARGET }, gh.run);
  assert.match(result.text, /^1 of 3 pins/);
  const put = gh.sent(1);
  assert.equal(Buffer.from(put.content ?? "", "base64").toString("utf8"), workflow(TARGET, TARGET, TARGET));
});

test("bumpRepo() refuses a repository where a release can start, and changes nothing", () => {
  const cases = [
    { runs: [{ status: "queued", url: "run-url" }] },
    { pulls: [{ number: 9, head: "changeset-release/main", url: "pr-url" }] },
    { pulls: [{ number: 9, head: "bump", url: "pr-url" }], files: { 9: [{ filename: "packages/x/package.json", patch: '-  "version": "0.1.0",\n+  "version": "0.2.0",' }] } },
  ];
  for (const state of cases) {
    const gh = github(state);
    const result = bumpRepo(REPO, { target: TARGET }, gh.run);
    assert.equal(result.result, "refused");
    assert.match(result.text, /a release can start/);
    assert.deepEqual(gh.writes(), []);
  }
});

test("bumpRepo() continues past a pull request that changes only dependencies", () => {
  const gh = github({ pulls: [{ number: 9, head: "renovate/npm-patch", url: "pr-url" }], files: { 9: [{ filename: "package.json", patch: '-    "tsx": "^4.0.0"\n+    "tsx": "^4.1.0"' }] } });
  assert.equal(bumpRepo(REPO, { target: TARGET }, gh.run).result, "opened");
});

test("bumpRepo() refuses when the release check fails, and when the target is older than a pin", () => {
  const broken = github({ fail: { "actions/workflows": "gh: Server Error (HTTP 500)" } });
  const failed = bumpRepo(REPO, { target: TARGET }, broken.run);
  assert.equal(failed.result, "refused");
  assert.match(failed.text, /release check failed.*HTTP 500/);
  assert.deepEqual(broken.writes(), []);

  const older = github({ compare: "behind", commits: [] });
  const result = bumpRepo(REPO, { target: TARGET }, older.run);
  assert.equal(result.result, "refused");
  assert.match(result.text, /older than the pin 1111111/);
  assert.deepEqual(older.writes(), []);
});

test("bumpRepo() skips a repository that has the pull request of the target", () => {
  const gh = github({ pulls: [{ number: 7, head: branchName(TARGET), url: "own-url" }] });
  const result = bumpRepo(REPO, { target: TARGET }, gh.run);
  assert.deepEqual([result.result, result.url], ["skipped", "own-url"]);
  assert.deepEqual(gh.writes(), []);
});

test("bumpRepo() removes the new branch when GitHub refuses the commit", () => {
  const gh = github({ fail: { "PUT repos/owner/repo/contents": "gh: Resource not accessible (HTTP 403)" } });
  const result = bumpRepo(REPO, { target: TARGET }, gh.run);
  assert.equal(result.result, "error");
  assert.deepEqual(
    gh.writes().map(({ args }) => args.slice(1, 4).join(" ")),
    [`-X POST repos/${REPO}/git/refs`, `-X PUT repos/${REPO}/contents/.github/workflows/release.yml`, `-X DELETE repos/${REPO}/git/refs/heads/${branchName(TARGET)}`],
  );
});

test("bumpRepo() compares each old pin one time for all the repositories", () => {
  const compareCache = new Map();
  const first = github();
  bumpRepo(REPO, { target: TARGET, dryRun: true, compareCache }, first.run);
  const second = github();
  bumpRepo(REPO, { target: TARGET, dryRun: true, compareCache }, second.run);
  const compares = (gh: { readonly calls: readonly GhCall[] }): number => gh.calls.filter(({ args }) => args.some((arg) => arg.includes("/compare/"))).length;
  assert.deepEqual([compares(first), compares(second)], [1, 0]);
});

test("resolveTarget() gives the head of main, and refuses a commit that is not on main", () => {
  const calls: (readonly string[])[] = [];
  const run = (status: string) => (args: readonly string[]): string => {
    calls.push(args);
    return (args[1] ?? "").includes("/compare/") ? `${status}\n` : `${TARGET}\n`;
  };
  assert.equal(resolveTarget(undefined, run("identical")), TARGET);
  assert.deepEqual(calls, [["api", "repos/mark1russell7/template/commits/main", "--jq", ".sha"]]);
  assert.equal(resolveTarget("40b0fbd", run("behind")), TARGET);
  assert.throws(() => resolveTarget("40b0fbd", run("ahead")), /not on main/);
});

test("commitSubject() names the template in an issue link, and puts each @ name in code font", () => {
  assert.equal(commitSubject("fix: the hints (#40)\n\nbody #3"), "fix: the hints (mark1russell7/template#40)");
  assert.equal(commitSubject("the @mark1russell7/vex package"), "the `@mark1russell7/vex` package");
  assert.equal(commitSubject("see owner/x#12 and &#38;"), "see owner/x#12 and &#38;");
});

test("parseArgs() reads the options, and gives the owner of the template to a bare name", () => {
  assert.deepEqual(parseArgs(["--sha", "abc1234", "--dry-run", "--co-author", "A <a@b.c>", "vex", "owner/x"]), {
    repositories: ["mark1russell7/vex", "owner/x"],
    options: { dryRun: true, check: false, sha: "abc1234", coAuthor: "A <a@b.c>" },
  });
  assert.deepEqual(parseArgs(["--check", "vex"]).options, { dryRun: false, check: true });
  assert.match(parseArgs([]).error ?? "", /no repository/);
  assert.match(parseArgs(["--sha"]).error ?? "", /needs a value/);
  assert.match(parseArgs(["--force", "vex"]).error ?? "", /unknown option/);
});

test("workflowPath() gives the path of a workflow file for --file, and refuses other values", () => {
  assert.equal(workflowPath("ai-review.yml"), ".github/workflows/ai-review.yml");
  assert.equal(workflowPath(".github/workflows/ci.yaml"), ".github/workflows/ci.yaml");
  for (const bad of ["../release.yml", "a/b.yml", "ai-review", ".hidden.yml", ".github/workflows/x/y.yml", ""]) assert.equal(workflowPath(bad), undefined, bad);
});

test("branchName() and prTitle() keep the names of release.yml, and name a different workflow", () => {
  assert.equal(branchName(TARGET), "ci/template-release-pins-40b0fbd");
  assert.equal(prTitle(TARGET), "ci: move the template release pins to 40b0fbd");
  assert.equal(branchName(TARGET, ".github/workflows/ai-review.yml"), "ci/template-ai-review-pins-40b0fbd");
  assert.equal(prTitle(TARGET, ".github/workflows/ai-review.yml"), "ci: move the template ai-review pins to 40b0fbd");
});

test("bumpRepo() with a workflow moves the pins of that file, and does the release check", () => {
  const path = ".github/workflows/ai-review.yml";
  const text = `jobs:\n  review:\n    uses: mark1russell7/template/.github/workflows/reusable-ai-review.yml@${OLD} # main\n`;
  const gh = github({ path, text });
  const result = bumpRepo(REPO, { target: TARGET, workflow: path, coAuthor: "A <a@b.c>" }, gh.run);
  assert.equal(result.result, "opened");
  assert.match(result.text, /^1 of 1 pins from 1111111 to 40b0fbd/);
  assert.ok(gh.calls.some(({ args }) => args.includes(`repos/${REPO}/actions/workflows/release.yml/runs?per_page=30`)));
  const [ref, put, pull] = [gh.sent(0), gh.sent(1), gh.sent(2)];
  assert.equal(ref.ref, `refs/heads/ci/template-ai-review-pins-40b0fbd`);
  assert.equal(gh.writes()[1]?.args[3], `repos/${REPO}/contents/${path}`);
  assert.equal(put.branch, "ci/template-ai-review-pins-40b0fbd");
  assert.equal(Buffer.from(put.content ?? "", "base64").toString("utf8"), text.replace(OLD, TARGET));
  assert.match(put.message ?? "", /^ci: move the template ai-review pins to 40b0fbd\n\nThe pins of mark1russell7\/template in ai-review\.yml go from 1111111/);
  assert.equal(pull.title, "ci: move the template ai-review pins to 40b0fbd");
  assert.equal(pull.head, "ci/template-ai-review-pins-40b0fbd");
  assert.match(pull.body ?? "", /in `\.github\/workflows\/ai-review\.yml`/);
  assert.match(pull.body ?? "", /Renovate also moves these pins/);
  assert.doesNotMatch(pull.body ?? "", /Renovate does not change/);

  const missing = github({ path, fail: { "contents/": "gh: Not Found (HTTP 404)" } });
  const skipped = bumpRepo(REPO, { target: TARGET, workflow: path }, missing.run);
  assert.deepEqual([skipped.result, skipped.text], ["skipped", `no ${path} on main`]);
});

test("parseArgs() reads --file as the path of a workflow, and refuses a value that is not a workflow file", () => {
  assert.deepEqual(parseArgs(["--file", "ai-review.yml", "--dry-run", "vex"]), {
    repositories: ["mark1russell7/vex"],
    options: { dryRun: true, check: false, workflow: ".github/workflows/ai-review.yml" },
  });
  assert.match(parseArgs(["--file", "../x.yml", "vex"]).error ?? "", /not a workflow file/);
  assert.match(parseArgs(["--file"]).error ?? "", /needs a value/);
});

test("bumpRepo() counts no release run in a repository without release.yml, and still refuses a version pull request", () => {
  const path = ".github/workflows/ai-review.yml";
  const text = `jobs:\n  review:\n    uses: mark1russell7/template/.github/workflows/reusable-ai-review.yml@${OLD} # main\n`;
  const noRelease = { "actions/workflows/release.yml": "gh: Not Found (HTTP 404)" };
  assert.equal(bumpRepo(REPO, { target: TARGET, workflow: path }, github({ path, text, fail: noRelease }).run).result, "opened");
  const gh = github({ path, text, fail: noRelease, pulls: [{ number: 9, head: "changeset-release/main", url: "pr-url" }] });
  const result = bumpRepo(REPO, { target: TARGET, workflow: path }, gh.run);
  assert.equal(result.result, "refused");
  assert.match(result.text, /version branch changeset-release\/main/);
  assert.deepEqual(gh.writes(), []);
});
