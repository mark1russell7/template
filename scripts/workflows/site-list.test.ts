// Tests of the sites of the audit of the live sites (site-list.ts): the sites of each owner, the named sites, the skip,
// the errors of a name that no owner has or that two owners have, and the shards of the job nav.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runBlock } from "./run-block.ts";
import { listOf, NAV_SHARD_SIZE, shardOf, shardsOf, siteList, siteUrl } from "./site-list.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const found = [
  { owner: "mark1russell7", name: "vex" },
  { owner: "metrograph-labs", name: "codeatlas" },
  { owner: "mark1russell7", name: "typeset" },
  { owner: "mark1russell7", name: "mark1russell7.github.io" },
];

test("listOf reads a list with commas", () => {
  assert.deepEqual(listOf(" a, b ,,c "), ["a", "b", "c"]);
  assert.deepEqual(listOf(undefined), []);
});

test("with no names, the list has each site of each owner in order, less the sites to skip", () => {
  const result = siteList(found, [], ["typeset"]);
  assert.deepEqual(result.list, ["codeatlas", "mark1russell7.github.io", "vex"]);
  assert.deepEqual(result.owners, { codeatlas: "metrograph-labs", "mark1russell7.github.io": "mark1russell7", vex: "mark1russell7" });
  assert.deepEqual(result.errors, []);
});

test("with names, the list has the named sites in their order, with the name of GitHub", () => {
  const result = siteList(found, ["Vex", "codeatlas", "vex"], []);
  assert.deepEqual(result.list, ["vex", "codeatlas"]);
  assert.deepEqual(result.owners, { vex: "mark1russell7", codeatlas: "metrograph-labs" });
});

test("a named site that no owner has, and a name that two owners have, are errors", () => {
  const result = siteList([...found, { owner: "mark1russell7", name: "CodeAtlas" }], ["nowhere"], []);
  assert.deepEqual(result.errors, ["More than one owner has a site with the name codeatlas.", "No owner has a public site with the name nowhere."]);
  assert.deepEqual(result.list, []);
});

test("shardOf puts each site in exactly one shard", () => {
  const sites = ["e", "a", "d", "c", "b", "f", "g"];
  const shards = [0, 1, 2, 3].map((shard) => shardOf(sites, shard, 4));
  assert.deepEqual(shards.flat().sort(), [...sites].sort());
  assert.deepEqual(shards[0], ["a", "e"]);
});

test("siteUrl gives the root for the site of the owner, and a folder for each other site", () => {
  assert.equal(siteUrl("Mark1Russell7", "mark1russell7.github.io"), "https://mark1russell7.github.io/");
  assert.equal(siteUrl("metrograph-labs", "codeatlas"), "https://metrograph-labs.github.io/codeatlas/");
  assert.equal(siteUrl("mark1russell7", "Logger"), "https://mark1russell7.github.io/Logger/");
});

test("shardsOf gives the fewest shards of at most the size, with counts that differ by one or less", () => {
  for (const count of [0, 1, 7, 8, 9, 16, 17, 55, 56, 57, 200]) {
    const sites = [...Array(count).keys()].map((at) => `site-${String(at).padStart(3, "0")}`);
    const shards = shardsOf(sites, Object.fromEntries(sites.map((name) => [name, "o"])), NAV_SHARD_SIZE);
    assert.equal(shards.length, Math.ceil(count / NAV_SHARD_SIZE), `${String(count)} sites`);
    assert.deepEqual(shards.flatMap((shard) => shard.sites).sort(), sites);
    const sizes = shards.map((shard) => shard.sites.length);
    assert.ok(sizes.every((size) => size >= 1 && size <= NAV_SHARD_SIZE), `${String(count)} sites: ${sizes.join(",")}`);
    if (sizes.length > 0) assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${String(count)} sites: ${sizes.join(",")}`);
    assert.deepEqual(shards.map((shard) => shard.index), [...shards.keys()]);
    for (const shard of shards) assert.deepEqual(shard.urls, shard.sites.map((name) => `https://o.github.io/${name}/`));
  }
  assert.deepEqual(shardsOf(["b", "o.github.io", "c"], { b: "o", c: "O", "o.github.io": "o" }, 2), [
    { name: "1 of 2", index: 0, sites: ["b", "o.github.io"], urls: ["https://o.github.io/b/", "https://o.github.io/"] },
    { name: "2 of 2", index: 1, sites: ["c"], urls: ["https://o.github.io/c/"] },
  ]);
});

test("shardsOf refuses a size that is not a positive integer, and a site with no owner", () => {
  for (const size of [0, -1, 1.5, Number.NaN]) assert.throws(() => shardsOf(["a"], { a: "o" }, size), RangeError);
  assert.throws(() => shardsOf(["a", "b"], { a: "o" }, 8), /The site b has no owner/);
});

const workflow = readFileSync(join(root, ".github/workflows/site-audit.yml"), "utf8");

test("the job nav of site-audit.yml runs one job for each shard of the job sites", () => {
  const has = (part: string, line: string): void => assert.ok(part.split("\n").includes(line), `no line ${JSON.stringify(line)}`);
  has(workflow, "      shards: ${{ steps.sites.outputs.shards }}");
  const nav = workflow.slice(workflow.indexOf("\n  nav:\n"), workflow.indexOf("\n  nav-report:\n"));
  has(nav, "    name: nav (${{ matrix.shard.name }})");
  has(nav, "        shard: ${{ fromJSON(needs.sites.outputs.shards) }}");
  has(nav, "          SITES: ${{ join(matrix.shard.sites, ' ') }}");
  has(nav, "          URLS: ${{ join(matrix.shard.urls, ' ') }}");
  has(nav, "          name: site-nav-shard-${{ matrix.shard.index }}");
  assert.ok(!nav.includes("matrix.repo"), "the job nav still reads matrix.repo");
});

// The step of the job nav, started as the runner starts it, with a fake crawl first on the PATH. The fake crawl writes a
// report and exits 0, exits 1 with a report for a site with problems, and exits 2 with no report for a broken site.
const STEP = runBlock(workflow, "      - name: The navigation of the sites of shard ${{ matrix.shard.name }}\n");
const folder = mkdtempSync(join(tmpdir(), "site-nav-step-"));
after(() => rmSync(folder, { recursive: true, force: true }));
const bin = join(folder, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "node"),
  [
    "#!/usr/bin/env bash",
    'url="" shots="" bar=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in --url) url="$2"; shift ;; --shots) shots="$2"; shift ;; --preview-bar) bar=" bar" ;; esac',
    "  shift",
    "done",
    'echo "$url$bar" >> "$CALLS"',
    'case "$url" in',
    "  */broken/) exit 2 ;;",
    "  */problems/) echo '{}' > \"$shots/report.json\"; exit 1 ;;",
    "  *) echo '{}' > \"$shots/report.json\" ;;",
    "esac",
    "",
  ].join("\n"),
);
chmodSync(join(bin, "node"), 0o755);

function navStep(name: string, sites: readonly string[], bar: string, urls?: string): { status: number | null; summary: string; calls: string[] } {
  const work = join(folder, name);
  mkdirSync(work);
  const summary = join(work, "summary.md");
  const calls = join(work, "calls.txt");
  writeFileSync(summary, "");
  writeFileSync(calls, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", STEP], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
      RUNNER_TEMP: work,
      GITHUB_STEP_SUMMARY: summary,
      CALLS: calls,
      SHARD: "1 of 2",
      SITES: sites.join(" "),
      URLS: urls ?? sites.map((site) => `https://o.github.io/${site}/`).join(" "),
      BAR: bar,
    },
  });
  return { status: result.status, summary: readFileSync(summary, "utf8"), calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) };
}

test("the nav step crawls each site after a failed one, names each failed site in the summary, and fails", () => {
  const { status, summary, calls } = navStep("fails", ["a", "broken", "problems", "c"], "true");
  assert.equal(status, 1);
  assert.equal(summary, "Shard 1 of 2: 1 of 4 sites gave no report: broken\n");
  // No crawl with the bar after a failed crawl. A site with problems is a report, not a failed audit.
  assert.deepEqual(
    calls.map((call) => call.replace("https://o.github.io/", "")),
    ["a/", "a/ bar", "broken/", "problems/", "problems/ bar", "c/", "c/ bar"],
  );
});

test("the nav step passes when each site gives a report, and crawls with the bar only when BAR is true", () => {
  const { status, summary, calls } = navStep("passes", ["a", "c"], "");
  assert.equal(status, 0);
  assert.equal(summary, "Shard 1 of 2: each of the 2 sites gave a report.\n");
  assert.deepEqual(calls, ["https://o.github.io/a/", "https://o.github.io/c/"]);
});

test("the nav step fails with no crawl when the counts of the sites and of the addresses differ, or for no site", () => {
  for (const [name, sites, urls] of [["counts", ["a", "c"], "https://o.github.io/a/"], ["empty", [], ""]] as const) {
    const { status, calls } = navStep(name, sites, "", urls);
    assert.equal(status, 1, name);
    assert.deepEqual(calls, [], name);
  }
});

