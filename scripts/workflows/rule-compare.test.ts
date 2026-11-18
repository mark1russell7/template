// Tests of the compare of the conventions rules (scripts/workflows/rule-compare.ts, CI.md "The compare of the conventions rules").
// Start them with "pnpm test:workflows". The tests give results as data, so they use no network and no clone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { escapeMarkdown } from "@mark1russell7/text";
import { OWNERS } from "../../packages/conventions/src/owners.ts";
import {
  type CheckResult,
  type CheckRule,
  type ReadRepos,
  annotations,
  BOUNDARIES,
  BOUNDARY_SCRIPT,
  boundaryResult,
  boundaryScope,
  checkEnv,
  confirmed,
  CONVENTIONS,
  dispatchEvent,
  failures,
  fails,
  GONE_LIST,
  newFailures,
  outcome,
  parseResult,
  repoList,
  scopeOf,
  shortPath,
  summaryLines,
  THREW,
  TOOLS,
  unreadRules,
} from "./rule-compare.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** This function gives a rule of a result: `[id, status, breaks]`, each break as `[file, line, message]`. */
const rule = (id: string, status: CheckRule["status"], breaks: [string, number | undefined, string][] = [], note?: string): CheckRule => ({
  id,
  status,
  breaks: breaks.map(([file, line, message]) => (line === undefined ? { file, message } : { file, line, message })),
  ...(note === undefined ? {} : { note }),
});

const result = (...rules: CheckRule[]): CheckResult => ({ rules });

describe("failures", () => {
  it("gives each break of a rule with the status break, with its place", () => {
    const got = failures(result(rule("a", "break", [["x.ts", 3, "one"], ["package.json", undefined, "two"]]), rule("b", "pass")));
    assert.deepEqual(got, [
      { rule: "a", place: "x.ts:3", message: "one" },
      { rule: "a", place: "package.json", message: "two" },
    ]);
  });

  it("gives no failure for a rule that warns, is off or skips", () => {
    assert.deepEqual(failures(result(rule("a", "warn", [["x.ts", 1, "soon"]]), rule("b", "off"), rule("c", "skipped"))), []);
  });

  it("gives one failure for a rule that threw, with its note", () => {
    assert.deepEqual(failures(result(rule("a", "error", [], "boom"))), [{ rule: "a", place: THREW, message: "boom" }]);
  });
});

describe("newFailures", () => {
  it("gives a failure at a place that the base does not fail", () => {
    const base = result(rule("a", "break", [["x.ts", 1, "old"]]));
    const next = result(rule("a", "break", [["x.ts", 1, "old"], ["y.ts", 2, "new"]]));
    assert.deepEqual(newFailures(base, next), { fresh: [{ rule: "a", place: "y.ts:2", message: "new" }], retold: [], gone: [] });
  });

  it("gives a changed text, not a new failure, for a place with the same count", () => {
    const base = result(rule("a", "break", [["x.ts", 1, "The old text."]]));
    const next = result(rule("a", "break", [["x.ts", 1, "The new text."]]));
    assert.deepEqual(newFailures(base, next), { fresh: [], retold: [{ rule: "a", place: "x.ts:1", message: "The new text." }], gone: [] });
  });

  it("gives a new failure for one more break of the same text at the same place", () => {
    const base = result(rule("a", "break", [["package.json", undefined, "same"]]));
    const next = result(rule("a", "break", [["package.json", undefined, "same"], ["package.json", undefined, "same"]]));
    assert.deepEqual(newFailures(base, next).fresh, [{ rule: "a", place: "package.json", message: "same" }]);
  });

  it("gives each break of a rule that warned in the base and fails in the pull request", () => {
    const base = result(rule("a", "warn", [["x.ts", 1, "late"]]));
    const next = result(rule("a", "break", [["x.ts", 1, "late"]]));
    assert.equal(newFailures(base, next).fresh.length, 1);
  });

  it("gives each break of a new rule, and a gone failure for a failure that only the base has", () => {
    assert.equal(newFailures(result(), result(rule("new-rule", "break", [["a", 1, "m"]]))).fresh.length, 1);
    assert.deepEqual(newFailures(result(rule("a", "break", [["x", 1, "m"]])), result(rule("a", "pass"))), { fresh: [], retold: [], gone: [{ rule: "a", place: "x:1", message: "m" }] });
  });

  it("gives a gone failure for one break less at a place, and none for a changed text", () => {
    const base = result(rule("a", "break", [["x.ts", 1, "same"], ["x.ts", 1, "same"], ["y.ts", 2, "The old text."]]));
    const next = result(rule("a", "break", [["x.ts", 1, "same"], ["y.ts", 2, "The new text."]]));
    assert.deepEqual(newFailures(base, next).gone, [{ rule: "a", place: "x.ts:1", message: "same" }]);
  });

  it("gives a gone failure for a rule that fails in the base and warns in the pull request", () => {
    assert.equal(newFailures(result(rule("a", "break", [["x.ts", 1, "m"]])), result(rule("a", "warn", [["x.ts", 1, "m"]]))).gone.length, 1);
  });

  it("gives a rule that throws only in the pull request", () => {
    assert.deepEqual(newFailures(result(rule("a", "pass")), result(rule("a", "error", [], "boom"))).fresh, [{ rule: "a", place: THREW, message: "boom" }]);
  });
});

describe("confirmed", () => {
  it("keeps a new failure only when the second pair gives the same rule, place and text", () => {
    const one = { rule: "a", place: "x:1", message: "m" };
    const two = { rule: "a", place: "x:2", message: "m" };
    assert.deepEqual(confirmed([one, two], [two, { rule: "a", place: "x:1", message: "other" }]), [two]);
  });
});

describe("outcome", () => {
  const base = result(rule("a", "pass"), rule("b", "skipped"));
  const next = result(rule("a", "break", [["x", 1, "m"]]), rule("b", "skipped"));

  it("is a no read with no result of the base, and fails with no result of the pull request only", () => {
    assert.equal(outcome("r", { next }).kind, "unread");
    const missing = outcome("r", { base });
    assert.equal(missing.kind, "next-unread");
    assert.equal(fails(missing), true);
  });

  it("is the same with no new failure, and names the rules that skip", () => {
    const same = outcome("r", { base, next: base });
    assert.equal(same.kind, "same");
    assert.deepEqual("skipped" in same ? same.skipped : [], ["b"]);
    assert.equal(fails(same), false);
  });

  it("is new only when the second pair gives the failure again", () => {
    assert.equal(outcome("r", { base, next }).kind, "once");
    assert.equal(outcome("r", { base, next }, { base, next: base }).kind, "once");
    const both = outcome("r", { base, next }, { base, next });
    assert.equal(both.kind, "new");
    assert.equal(fails(both), true);
    assert.equal(fails(outcome("r", { base, next }, { base, next: base })), false);
  });
});

describe("scopeOf", () => {
  it("keeps a repository with conventions in its dependencies or its dev dependencies", () => {
    assert.equal(scopeOf(JSON.stringify({ devDependencies: { "@mark1russell7/conventions": "^0.42.6" } })), undefined);
    assert.equal(scopeOf(JSON.stringify({ dependencies: { "@mark1russell7/conventions": "^0.42.6" } })), undefined);
  });

  it("puts out of scope a repository with no package.json or no dependency on conventions", () => {
    assert.match(scopeOf(undefined) ?? "", /no package\.json/);
    assert.match(scopeOf(JSON.stringify({ devDependencies: { vitest: "^4.0.0" } })) ?? "", /no dependency/);
  });

  it("keeps a package.json that does not parse, so the checks tell about it", () => {
    assert.equal(scopeOf("{"), undefined);
  });

  it("reads the dependency on the package that it gets", () => {
    const manifest = JSON.stringify({ devDependencies: { [BOUNDARIES]: "^0.3.0" } });
    assert.equal(scopeOf(manifest, BOUNDARIES), undefined);
    assert.match(scopeOf(manifest) ?? "", /no dependency on @mark1russell7\/conventions/);
  });
});

describe("boundaryScope", () => {
  const manifest = (script?: string, dependency = true): string =>
    JSON.stringify({ ...(script === undefined ? {} : { scripts: { [BOUNDARY_SCRIPT]: script } }), devDependencies: dependency ? { [BOUNDARIES]: "^0.3.0" } : {} });

  it("gives the words of the depcruise command, with the JSON output into the file last", () => {
    assert.deepEqual(boundaryScope(manifest("depcruise --config .dependency-cruiser.ts packages"), "/w/o.json"), {
      kind: "args",
      args: ["--config", ".dependency-cruiser.ts", "packages", "--output-type", "json", "--output-to", "/w/o.json"],
    });
    assert.deepEqual(boundaryScope(manifest("  depcruise   src  "), "f"), { kind: "args", args: ["src", "--output-type", "json", "--output-to", "f"] });
  });

  it("puts out of scope a repository with no dependency on the boundaries or no script check:boundaries", () => {
    assert.equal(boundaryScope(manifest("depcruise src", false), "f").kind, "off");
    assert.deepEqual(boundaryScope(manifest(), "f"), { kind: "off", reason: "its root package.json has no script check:boundaries" });
    assert.equal(boundaryScope(undefined, "f").kind, "off");
  });

  it("is a no read for a script that is not one depcruise command with plain words, or a file that does not parse", () => {
    for (const script of ["pnpm build && depcruise src", "depcruise src > out.txt", "depcruise $DIRS", "tsx scripts/boundaries.ts", "depcruise 'src'"]) {
      assert.equal(boundaryScope(manifest(script), "f").kind, "unread", script);
    }
    assert.equal(boundaryScope("{", "f").kind, "unread");
  });
});

describe("boundaryResult", () => {
  const store = "node_modules/.pnpm/vitest@5.1.0_@types+node@26.6.6_0098e66ea468f54e847c0e6f76520b03/node_modules/vitest/dist/index.js";
  const output = (violations: unknown[], forbidden: unknown[] = [{ name: "core-knows-no-renderer", severity: "error" }, { name: "not-a-declared-export", severity: "error" }]) =>
    JSON.stringify({ modules: [], summary: { violations, error: violations.length, ruleSetUsed: { forbidden } } });

  it("gives each rule of the rule set, and each violation of a rule with the severity error as a break at the file of the import", () => {
    const got = boundaryResult(output([{ type: "dependency", from: "packages/core/src/highways/fixtures.test-util.ts", to: store, rule: { name: "core-knows-no-renderer", severity: "error" } }]));
    assert.deepEqual(got, {
      rules: [
        { id: "core-knows-no-renderer", status: "break", breaks: [{ file: "packages/core/src/highways/fixtures.test-util.ts", message: "dependency to node_modules/vitest/dist/index.js" }] },
        { id: "not-a-declared-export", status: "pass", breaks: [] },
      ],
    });
  });

  it("gives a violation of the severity warn or info as a rule that warns, so it is no failure", () => {
    const got = boundaryResult(output([{ type: "dependency", from: "a.ts", to: "b.ts", rule: { name: "soft", severity: "warn" } }], []));
    assert.deepEqual(got?.rules, [{ id: "soft", status: "warn", breaks: [{ file: "a.ts", message: "dependency to b.ts" }] }]);
    assert.deepEqual(failures(got ?? result()), []);
  });

  it("tells a violation of a module by the module, and keeps a break of a rule that also warns", () => {
    const got = boundaryResult(
      output(
        [
          { type: "module", from: "src/orphan.ts", to: "src/orphan.ts", rule: { name: "no-orphans", severity: "warn" } },
          { type: "module", from: "src/b.ts", to: "src/b.ts", rule: { name: "no-orphans", severity: "error" } },
        ],
        [],
      ),
    );
    assert.deepEqual(got?.rules, [{ id: "no-orphans", status: "break", breaks: [{ file: "src/orphan.ts", message: "module src/orphan.ts" }, { file: "src/b.ts", message: "module src/b.ts" }] }]);
  });

  it("gives undefined for a text that is not an output of depcruise", () => {
    assert.equal(boundaryResult(""), undefined);
    assert.equal(boundaryResult('{"summary":{}}'), undefined);
    assert.equal(boundaryResult("error: no config"), undefined);
  });

  it("gives the new failure of a boundaries change, and the gone failure of its fix, through newFailures", () => {
    const before = boundaryResult(output([]));
    const after = boundaryResult(output([{ type: "dependency", from: "packages/core/src/x.test-util.ts", to: store, rule: { name: "core-knows-no-renderer", severity: "error" } }]));
    assert.ok(before !== undefined && after !== undefined);
    assert.equal(newFailures(before, after).fresh.length, 1);
    assert.equal(newFailures(after, before).gone.length, 1);
  });
});

describe("shortPath", () => {
  it("removes the folder of the pnpm store from a path of node_modules", () => {
    assert.equal(shortPath("node_modules/.pnpm/a@1.0.0_x/node_modules/a/index.js"), "node_modules/a/index.js");
    assert.equal(shortPath("node_modules/.pnpm/@s+b@2.0.0/node_modules/@s/b/i.js"), "node_modules/@s/b/i.js");
    assert.equal(shortPath("packages/core/src/a.ts"), "packages/core/src/a.ts");
  });
});

describe("TOOLS", () => {
  it("names each tool by its key, with its package", () => {
    for (const [key, tool] of Object.entries(TOOLS)) assert.equal(tool.name, key);
    assert.equal(TOOLS.conventions.package, CONVENTIONS);
    assert.equal(TOOLS.boundaries.package, BOUNDARIES);
  });
});

describe("checkEnv", () => {
  it("removes the event of the run and gives the event of a dispatched run of the repository", () => {
    const env = checkEnv({ PATH: "/bin", CI: "true", GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: "/e.json", GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main", CONVENTIONS_PULL_REQUEST: "/p.json", CONVENTIONS_BASE: "abc", GITHUB_STEP_SUMMARY: "/s", GITHUB_REPOSITORY: "o/template" }, "o/lag", "/out/lag/event.json");
    assert.deepEqual(env, { PATH: "/bin", CI: "true", GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "o/lag", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: "/out/lag/event.json" });
  });

  it("gives an event file of a public repository with no pull request", () => {
    const event = JSON.parse(dispatchEvent("o/lag")) as { repository: { full_name: string; name: string; owner: { login: string }; private: boolean }; pull_request?: unknown };
    assert.equal(event.repository.full_name, "o/lag");
    assert.equal(event.repository.name, "lag");
    assert.equal(event.repository.owner.login, "o");
    assert.equal(event.repository.private, false);
    assert.equal(event.pull_request, undefined);
  });
});

describe("parseResult", () => {
  it("gives a result only for a JSON object with a list of rules", () => {
    assert.deepEqual(parseResult('{"rules":[],"failed":false}'), { rules: [], failed: false });
    assert.equal(parseResult('{"failed":false}'), undefined);
    assert.equal(parseResult("conventions: error"), undefined);
  });
});

describe("unreadRules", () => {
  it("gives the rules that skip in each repository with a result", () => {
    const skip = (repo: string, skipped: string[]) => outcome(repo, { base: result(...skipped.map((id) => rule(id, "skipped"))), next: result(...skipped.map((id) => rule(id, "skipped"))) });
    assert.deepEqual(unreadRules([skip("a", ["x", "y"]), skip("b", ["y", "z"]), { repo: "c", kind: "off", reason: "-" }]), ["y"]);
    assert.deepEqual(unreadRules([{ repo: "c", kind: "off", reason: "-" }]), []);
  });
});

describe("repoList", () => {
  const read: ReadRepos = async (owners) =>
    owners.flatMap((owner, at) => [
      { owner, name: `z-${String(at)}`, default_branch: "main" },
      { owner, name: `a-${String(at)}`, default_branch: "main" },
    ]);

  it("reads each owner of OWNERS when no list is given, and gives the full names in order", async () => {
    const want = OWNERS.flatMap((owner, at) => [`${owner.login}/a-${String(at)}`, `${owner.login}/z-${String(at)}`]).sort((a, b) => a.localeCompare(b));
    assert.ok(OWNERS.length >= 2, "the test reads more than one owner");
    assert.deepEqual(await repoList(undefined, read), want);
  });

  it("gives the named repositories in order, with no read", async () => {
    const none: ReadRepos = async () => assert.fail("a named list reads no owner");
    assert.deepEqual(await repoList('["o/lag","n/vex"]', none), ["n/vex", "o/lag"]);
    assert.deepEqual(await repoList("[]", none), []);
  });
});

describe("summaryLines and annotations", () => {
  const base = result(rule("a", "pass"));
  const next = result(rule("a", "break", [["x.ts", 1, "a | b"]]));
  const outcomes = [outcome("o/lag", { base, next }, { base, next }), outcome("o/ste-lint", { base, next: base }), { repo: "o/notes", kind: "off" as const, reason: "-" }];

  it("counts the repositories that fail, and lists each new failure with escapes", () => {
    const lines = summaryLines(outcomes);
    assert.equal(lines[0], "## The compare of the conventions rules: 1 of 2 repositories fail");
    assert.ok(lines.includes(`| ${escapeMarkdown("o/lag")} | **new failures** | 1 | 0 | 0 |`));
    assert.ok(lines.includes(`- \`a\` ${escapeMarkdown("x.ts:1")}: ${escapeMarkdown("a | b")}`));
    assert.ok(lines.some((line) => line.endsWith("a \\| b")));
    assert.ok(!lines.some((line) => line.includes("notes")));
  });

  it("gives an error for a confirmed new failure and a warning for a no read", () => {
    const lines = annotations([...outcomes, { repo: "o/old", kind: "unread", reason: "the clone failed" }]);
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? "", /^::error title=Rule compare::o\/lag a x\.ts:1: /);
    assert.match(lines[1] ?? "", /^::warning title=Rule compare::o\/old: no read, because the clone failed$/);
  });

  it("gives the title and the label of the tool", () => {
    assert.equal(summaryLines(outcomes, TOOLS.boundaries)[0], "## The compare of the import boundaries: 1 of 2 repositories fail");
    assert.match(annotations(outcomes, TOOLS.boundaries)[0] ?? "", /^::error title=Boundary compare::o\/lag /);
  });

  it("counts and lists the gone failures of each repository, at most GONE_LIST", () => {
    const many = result(rule("a", "break", Array.from({ length: GONE_LIST + 2 }, (_, at): [string, number, string] => [`f${String(at)}.ts`, 1, "m"])));
    const lines = summaryLines([outcome("o/fixed", { base: many, next: result(rule("a", "pass")) })]);
    assert.ok(lines.includes(`| ${escapeMarkdown("o/fixed")} | same failures | 0 | 0 | ${String(GONE_LIST + 2)} |`));
    assert.ok(lines.includes(`### ${escapeMarkdown("o/fixed")}: gone failures`));
    assert.equal(lines.filter((line) => line.startsWith("- `a` ")).length, GONE_LIST);
    assert.ok(lines.includes("- 2 more, in the artifact"));
  });
});

describe("the job rules of ci.yml", () => {
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");

  it("starts the script, and CI OK needs the job and allows its skip", () => {
    assert.match(ci, /node next\/scripts\/workflows\/rule-compare\.ts /);
    assert.match(ci, /needs: \[ci, presets, renovate-presets, stamp, site, rules\]/);
    assert.match(ci, /ALLOW_SKIP: "presets renovate-presets stamp rules"/);
  });

  it("names the script in the paths of the job", () => {
    assert.match(ci, /^ {12}scripts\/workflows\/rule-compare\.ts$/m);
    assert.match(ci, /^ {12}packages\/conventions\/src\/\*\*$/m);
  });

  it("starts the compare of each tool, and the compare of the boundaries on a change of the boundaries", () => {
    for (const name of Object.keys(TOOLS)) assert.match(ci, new RegExp(`rule-compare\\.ts --tool ${name} `));
    assert.match(ci, /^ {12}packages\/boundaries\/src\/\*\*$/m);
    assert.match(ci, /if: \$\{\{ !cancelled\(\) && steps\.boundary-changes\.outputs\.match == 'true' \}\}/);
  });
});
