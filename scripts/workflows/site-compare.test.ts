// Tests of the compare of the site check (scripts/workflows/site-compare.ts, CI.md "The compare of the site check").
// Start them with "pnpm test:workflows". The tests give reports and files as data, so they use no network and no browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type CheckReport, annotations, checkCalls, confirmed, fails, newProblems, outcome, shardOf, siteTarget, summaryLines } from "./site-compare.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** This function gives a report with one view for each entry: `[page, width, scheme, problems]`. */
const report = (...views: [string, number, string, string[]][]): CheckReport => ({ views: views.map(([page, width, scheme, problems]) => ({ page, width, scheme, problems })) });

describe("newProblems", () => {
  it("gives only the problems of a view that the base does not have", () => {
    const base = report(["/", 360, "light", ["a"]], ["/", 1280, "dark", []]);
    const next = report(["/", 360, "light", ["a", "b", "b"]], ["/", 1280, "dark", []]);
    assert.deepEqual([...newProblems(base, next)], [["/ 360 light", ["b"]]]);
  });

  it("gives nothing for a problem that only the base has", () => {
    assert.equal(newProblems(report(["/", 360, "light", ["a"]]), report(["/", 360, "light", []])).size, 0);
  });

  it("gives each problem of a view that the base does not have", () => {
    assert.deepEqual([...newProblems(report(), report(["/demo/", 400, "dark", ["c"]]))], [["/demo/ 400 dark", ["c"]]]);
  });

  it("compares each view with the same view only", () => {
    const base = report(["/", 360, "light", ["a"]]);
    assert.deepEqual([...newProblems(base, report(["/", 360, "dark", ["a"]]))], [["/ 360 dark", ["a"]]]);
  });
});

describe("confirmed", () => {
  it("keeps a problem only when the second pair gives it in the same view", () => {
    const first = new Map([["/ 360 light", ["a", "b"]], ["/ 400 dark", ["c"]]]);
    const second = new Map([["/ 360 light", ["b"]], ["/ 1280 dark", ["c"]]]);
    assert.deepEqual([...confirmed(first, second)], [["/ 360 light", ["b"]]]);
  });
});

describe("outcome", () => {
  const clean = report(["/", 360, "light", []]);
  const bad = report(["/", 360, "light", ["overflow 12 px"]]);

  it("is a no read when the check of the base gives no report", () => {
    assert.equal(outcome("x", { next: clean }).kind, "unread");
    assert.equal(outcome("x", {}).kind, "unread");
  });

  it("fails when only the check of the base gives a report", () => {
    const result = outcome("x", { base: clean });
    assert.equal(result.kind, "next-unread");
    assert.equal(fails(result), true);
  });

  it("passes when the check of the pull request finds no new problem", () => {
    assert.deepEqual(outcome("x", { base: bad, next: bad }), { repo: "x", kind: "same", views: 1 });
  });

  it("fails only when both pairs give the new problem", () => {
    const result = outcome("x", { base: clean, next: bad }, { base: clean, next: bad });
    assert.equal(result.kind, "new");
    assert.equal(fails(result), true);
  });

  it("warns for a new problem of one pair only", () => {
    for (const result of [outcome("x", { base: clean, next: bad }), outcome("x", { base: clean, next: bad }, { base: clean, next: clean }), outcome("x", { base: clean, next: bad }, { next: bad })]) {
      assert.equal(result.kind, "once");
      assert.equal(fails(result), false);
    }
  });
});

describe("checkCalls", () => {
  it("reads the inputs of a job that calls reusable-pages.yml", () => {
    const text = [
      "jobs:",
      "  pages:",
      "    # The site",
      "    uses: mark1russell7/template/.github/workflows/reusable-pages.yml@0123456789abcdef0123456789abcdef01234567 # v1",
      "    permissions:",
      "      contents: read",
      "    with:",
      "      build: pnpm build",
      '      out: "dist"',
      "      site-check: true # the check",
      "      site-check-pages: |",
      "        /,",
      "        /demo/",
      "      deploy: false",
      "  other:",
      "    runs-on: ubuntu-latest",
    ].join("\n");
    assert.deepEqual(checkCalls(text), [{ kind: "pages", inputs: { build: "pnpm build", out: "dist", "site-check": true, "site-check-pages": "/, /demo/", deploy: false } }]);
  });

  it("reads the inputs of a step that uses the action site-check", () => {
    const text = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v6",
      "      - name: The site check",
      "        uses: mark1russell7/template/.github/actions/site-check@0123456789abcdef0123456789abcdef01234567",
      "        with:",
      "          out: site",
      "          site-check-pages: /,/app/",
      "      - uses: ./.github/actions/site-check",
      "        with:",
      "          site-check-widths: '360,1280'",
    ].join("\n");
    assert.deepEqual(checkCalls(text), [
      { kind: "action", inputs: { out: "site", "site-check-pages": "/,/app/" } },
      { kind: "action", inputs: { "site-check-widths": "360,1280" } },
    ]);
  });

  it("gives nothing for a file with no call of the site check", () => {
    assert.deepEqual(checkCalls("jobs:\n  ci:\n    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@v1\n    with:\n      site-check: true\n"), []);
  });
});

describe("siteTarget", () => {
  const url = "https://example.github.io/site/";
  const config = (fields: Record<string, unknown>) => JSON.stringify({ build: "pnpm build", out: "dist", ...fields });
  const caller = (lines: string[]) => ["jobs:", "  pages:", "    uses: mark1russell7/template/.github/workflows/reusable-pages.yml@v1", ...(lines.length > 0 ? ["    with:", ...lines.map((line) => `      ${line}`)] : [])].join("\n");

  it("reads the pages and the widths of .github/site.json", () => {
    const files = { config: config({ "site-check": true, "site-check-pages": "/,/releases/", "site-check-widths": "360,1280" }), workflows: [caller([])] };
    assert.deepEqual(siteTarget("owner/site", url, files), { repo: "site", url, pages: "/,/releases/", widths: "360,1280" });
  });

  it("reads the inputs of the caller of reusable-pages.yml", () => {
    const files = { config: undefined, workflows: [caller(["build: pnpm build", "out: dist", "site-check: true"])] };
    assert.deepEqual(siteTarget("owner/site", url, files), { repo: "site", url, pages: "", widths: "" });
  });

  it("skips a test call with deploy: false, as the template has", () => {
    const test = caller(["build: pnpm build", "out: fixture", "site-check: true", "site-check-pages: /fixture/", "deploy: false"]);
    const files = { config: config({ "site-check": true, "site-check-pages": "/" }), workflows: [test, caller([])] };
    assert.deepEqual(siteTarget("owner/site", url, files), { repo: "site", url, pages: "/", widths: "" });
  });

  it("reads the inputs of the action site-check of a site with its own Pages workflow", () => {
    const own = "jobs:\n  build:\n    steps:\n      - uses: mark1russell7/template/.github/actions/site-check@v1\n        with:\n          out: site\n          site-check-pages: /,/app/\n";
    assert.deepEqual(siteTarget("owner/site", url, { config: undefined, workflows: [own] }), { repo: "site", url, pages: "/,/app/", widths: "" });
  });

  it("puts a site with no site check out of scope", () => {
    assert.ok("off" in siteTarget("owner/site", url, { config: config({ "site-check": false }), workflows: [caller([])] }));
    assert.ok("off" in siteTarget("owner/site", url, { config: undefined, workflows: ["jobs: {}\n"] }));
  });

  it("gives an error for a config that the compare cannot read", () => {
    const both = { config: config({ "site-check": true }), workflows: [caller(["site-check: true"])] };
    assert.match((siteTarget("owner/site", url, both) as { error: string }).error, /Give the site values only in/);
    const expression = { config: undefined, workflows: [caller(["build: pnpm build", "out: dist", "site-check: true", "site-check-pages: ${{ vars.PAGES }}"])] };
    assert.match((siteTarget("owner/site", url, expression) as { error: string }).error, /expression/);
  });
});

describe("the summary", () => {
  const outcomes = [
    { repo: "a", kind: "same", views: 6 },
    { repo: "b|c", kind: "new", problems: new Map([["/ 360 light", ["overflow *12* px"]]]) },
    { repo: "d", kind: "once", problems: new Map([["/ 400 dark", ["console.error: 50%"]]]) },
    { repo: "e", kind: "unread", reason: "the check of the base gave no report" },
    { repo: "f", kind: "off", reason: "its site config has no site check (site-check is false)" },
  ] as const;

  it("counts the sites that fail, and escapes each text of a site", () => {
    const lines = summaryLines("1 of 4", outcomes);
    assert.equal(lines[0], "## The compare of the site check, shard 1 of 4: 1 of 5 sites fail");
    assert.ok(lines.includes("| b\\|c | **new problems** | 1 |"));
    assert.ok(lines.includes("- \\/ 360 light: overflow \\*12\\* px"));
  });

  it("gives an error for a confirmed problem, and a warning for a problem of one pair and for a no read", () => {
    const lines = annotations(outcomes);
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? "", /^::error title=Site check compare::b\|c \/ 360 light: overflow \*12\* px/);
    assert.match(lines[1] ?? "", /^::warning title=Site check compare::d \/ 400 dark: console\.error: 50%25/);
    assert.match(lines[2] ?? "", /^::warning title=Site check compare::e: no read/);
  });
});

describe("the shards", () => {
  it("puts each site in exactly one shard", () => {
    const sites = ["e", "a", "d", "c", "b", "f", "g"];
    const shards = [0, 1, 2, 3].map((shard) => shardOf(sites, shard, 4));
    assert.deepEqual(shards.flat().sort(), [...sites].sort());
    assert.deepEqual(shards[0], ["a", "e"]);
  });

  it("has the same count of shards in the matrix and in the command of the job compare", () => {
    const text = readFileSync(join(root, ".github/workflows/site-audit.yml"), "utf8");
    const matrix = /\n {8}shard: \[([^\]]*)\]/.exec(text)?.[1]?.split(",").map((entry) => Number(entry.trim()));
    const count = Number(/--shards (\d+)/.exec(text)?.[1]);
    assert.ok(matrix !== undefined && matrix.length > 0);
    assert.deepEqual(matrix, [...Array(count).keys()]);
  });
});
