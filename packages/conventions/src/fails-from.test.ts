/**
 * The day `failsFrom` of a rule: before it, a break of the rule is a warning and the check passes. A new rule reaches
 * each repository through an update pull request, so a new rule that fails at once blocks those pull requests.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { annotations, formatResult, RULE_WARN_DAYS, RULES, runChecks, summaryMarkdown, type Rule } from "./index.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-fails-from-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const root = join(temp, "repo");
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "root", private: true }, null, 2)}\n`);

/** A rule with one break in each repository. */
const always = (failsFrom?: string): Rule => ({
  id: "always",
  title: "A test rule.",
  reason: "A test.",
  fix: "Nothing.",
  sources: [],
  options: {},
  ...(failsFrom === undefined ? {} : { failsFrom }),
  check: () => [{ file: "package.json", line: 1, message: "A break." }],
});

/**
 * The rules of conventions 0.38.5, before the field `failsFrom` existed. Each other rule gives the field. Do not add
 * an id to this list: give the new rule its day `failsFrom` instead.
 */
const BEFORE_FAILS_FROM = new Set([
  "api-report-script", "changelog-version", "cue-preset", "gate-after-cancel", "gate-trigger", "home-package",
  "license-file", "main-check", "main-runs-finish", "no-build-output", "no-local-paths", "pages-after-release",
  "pages-site", "pinned-git-deps", "pipe-fails", "published-minor", "push-main-only", "release-files",
  "required-scripts", "roadmap-parses", "runner-budget", "security-one-job", "service-run-main", "setup-cue",
  "shared-ci", "shared-docs", "source-main", "tests-required", "trust-policy", "tsconfig-test", "typed-files",
  "typed-scripts", "unreleased-change", "version-title", "workflow-parses", "workspace-protocol",
]);

describe("failsFrom", () => {
  it("a break before the day is a warning, and the check passes", () => {
    const result = runChecks({ root, rules: [always("2026-11-23")], today: "2026-11-22" });
    expect(result.failed).toBe(false);
    expect(result.rules[0]?.status).toBe("warn");
    expect(result.rules[0]?.breaks).toHaveLength(1);
    expect(result.rules[0]?.note).toBe("The rule fails from 2026-11-23.");
    expect(formatResult(result)).toContain("warn   always: 1 break(s)");
    expect(formatResult(result)).toContain("0 with 0 break(s), 1 warn");
    expect(summaryMarkdown(result)).toContain("| `always` | warn: 1 break(s) |");
    expect(annotations(result)).toMatch(/^::warning file=package\.json,line=1,/u);
  });

  it("on the day and after it, a break fails the check", () => {
    for (const today of ["2026-11-23", "2027-01-01"]) {
      const result = runChecks({ root, rules: [always("2026-11-23")], today });
      expect(result.failed).toBe(true);
      expect(result.rules[0]?.status).toBe("break");
      expect(annotations(result)).toMatch(/^::error /u);
    }
  });

  it("a rule with no day fails at once, and a rule with no break passes", () => {
    expect(runChecks({ root, rules: [always()], today: "2026-11-22" }).rules[0]?.status).toBe("break");
    const none: Rule = { ...always("2026-11-23"), check: () => [] };
    expect(runChecks({ root, rules: [none], today: "2026-11-22" }).rules[0]?.status).toBe("pass");
  });

  it("each rule after 0.38.5 gives a real day, and each day is a valid date", () => {
    expect(RULE_WARN_DAYS).toBeGreaterThanOrEqual(14);
    for (const rule of RULES) {
      if (rule.failsFrom === undefined) {
        expect(BEFORE_FAILS_FROM.has(rule.id), `The new rule ${rule.id} needs the field failsFrom.`).toBe(true);
        continue;
      }
      expect(rule.failsFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(new Date(`${rule.failsFrom}T00:00:00Z`).toISOString().slice(0, 10)).toBe(rule.failsFrom);
    }
  });
});
