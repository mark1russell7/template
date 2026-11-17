// Tests of the compare of the conventions rules (scripts/workflows/rule-compare.ts, CI.md "The compare of the conventions rules").
// Start them with "pnpm test:workflows". The tests give results as data, so they use no network and no clone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { escapeMarkdown } from "@mark1russell7/text";
import { OWNERS } from "../../packages/conventions/src/owners.ts";
import { type CheckResult, type CheckRule, type ReadRepos, annotations, checkEnv, confirmed, dispatchEvent, failures, fails, newFailures, outcome, parseResult, repoList, scopeOf, summaryLines, THREW, unreadRules } from "./rule-compare.ts";

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
    assert.deepEqual(newFailures(base, next), { fresh: [{ rule: "a", place: "y.ts:2", message: "new" }], retold: [] });
  });

  it("gives a changed text, not a new failure, for a place with the same count", () => {
    const base = result(rule("a", "break", [["x.ts", 1, "The old text."]]));
    const next = result(rule("a", "break", [["x.ts", 1, "The new text."]]));
    assert.deepEqual(newFailures(base, next), { fresh: [], retold: [{ rule: "a", place: "x.ts:1", message: "The new text." }] });
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

  it("gives each break of a new rule, and nothing for a failure that only the base has", () => {
    assert.equal(newFailures(result(), result(rule("new-rule", "break", [["a", 1, "m"]]))).fresh.length, 1);
    assert.deepEqual(newFailures(result(rule("a", "break", [["x", 1, "m"]])), result(rule("a", "pass"))), { fresh: [], retold: [] });
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
    assert.ok(lines.includes(`| ${escapeMarkdown("o/lag")} | **new failures** | 1 | 0 |`));
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
});
