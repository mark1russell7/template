// The rule playwright-install on fixture repositories: the forms of a hand-written install of the Playwright browsers,
// comments and messages, the site config, and the shared action itself.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, type RuleResult } from "./index.ts";
import { playwrightInstall, playwrightInstalls, siteConfigInstall } from "./rules/playwright-install.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-playwright-install-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

const ID = "playwright-install";

/** This function makes a git repository with the files, and gives its root. */
function repository(files: Record<string, string>): string {
  const root = join(temp, String(fixtures++));
  for (const [file, text] of Object.entries({ "package.json": '{ "name": "one" }\n', ...files })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "first"]]) {
    const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return root;
}

/** The check on the day that the rule fails from, so a break is a break and not a warning. */
function check(root: string, today = playwrightInstall.failsFrom ?? ""): RuleResult {
  const result = runChecks({ root, only: [ID], today }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

/** A job with these steps. */
const job = (...steps: string[]): string => ["on: push", "jobs:", "  e2e:", "    runs-on: ubuntu-latest", "    steps:", ...steps, ""].join("\n");

/** The step of the shared action. */
const SHARED_STEP = [
  "      - uses: mark1russell7/template/.github/actions/setup-playwright@0000000000000000000000000000000000000000 # main",
  "        with:",
  "          browsers: chromium",
  "          command: pnpm --filter @lag/site exec playwright",
];

describe("the rule playwright-install", () => {
  it("finds each form of the CLI that installs, with the command, and not a comment or a quoted name", () => {
    expect(playwrightInstalls("a\n      - run: pnpm exec playwright install --with-deps chromium\n")).toEqual([{ line: 2, command: "install" }]);
    expect(playwrightInstalls("run: npx playwright@1.64.1 install chromium")).toEqual([{ line: 1, command: "install" }]);
    expect(playwrightInstalls("run: pnpm --filter @typeset/widths exec playwright install-deps")).toEqual([{ line: 1, command: "install-deps" }]);
    expect(playwrightInstalls("run: ./node_modules/.bin/playwright install")).toEqual([{ line: 1, command: "install" }]);
    expect(playwrightInstalls("run: pnpm build && npx -y playwright install chromium")).toEqual([{ line: 1, command: "install" }]);
    expect(playwrightInstalls("        pnpm --filter ./packages/site exec playwright install --with-deps chromium")).toEqual([{ line: 1, command: "install" }]);
    expect(playwrightInstalls("  # before: npx playwright install --with-deps\n#playwright install\n")).toEqual([]);
    expect(playwrightInstalls('run: grep -q "playwright install-deps chromium" log.txt')).toEqual([]);
    expect(playwrightInstalls("run: npx playwright test\nrun: npx playwright --version\nrun: pnpm add -D @playwright/test\n")).toEqual([]);
    expect(playwrightInstalls("run: npx playwright installer")).toEqual([]);
  });

  it("finds the install in the build of a site config, with the line of the key", () => {
    const file = `{\n  "out": "dist",\n  "build": "pnpm --filter ./packages/site exec playwright install --with-deps chromium && pnpm build"\n}\n`;
    expect(siteConfigInstall(file)).toEqual({ line: 3, command: "install" });
    expect(siteConfigInstall(`{ "build": "pnpm build", "playwright-browsers": "chromium" }`)).toBeUndefined();
    expect(siteConfigInstall("not json")).toBeUndefined();
  });

  it("fails on an install in a run step and in the input build of a caller, with the line", () => {
    const root = repository({
      ".github/workflows/e2e.yml": job("      - run: pnpm install", "      - run: pnpm exec playwright install --with-deps chromium"),
      ".github/workflows/pages.yml": [
        "on: push",
        "jobs:",
        "  pages:",
        "    uses: mark1russell7/template/.github/workflows/reusable-pages.yml@0000000000000000000000000000000000000000 # main",
        "    with:",
        "      build: |",
        "        pnpm --filter ./packages/site exec playwright install --with-deps chromium",
        "        pnpm --filter ./packages/site build",
        "",
      ].join("\n"),
    });
    const result = check(root);
    expect(result.status).toBe("break");
    expect(result.breaks.map((each) => [each.file, each.line])).toEqual([
      [".github/workflows/e2e.yml", 7],
      [".github/workflows/pages.yml", 7],
    ]);
    expect(result.breaks[0]?.message).toContain('"playwright install"');
    expect(result.breaks[0]?.message).toContain("setup-playwright");
  });

  it("fails on an install in the build of .github/site.json, and reads a composite action but not the shared one", () => {
    const step = "    - run: npx playwright install chromium\n      shell: bash\n";
    const action = (name: string): string => `name: ${name}\nruns:\n  using: composite\n  steps:\n${step}`;
    const root = repository({
      ".github/site.json": `{\n  "build": "npx playwright install chromium && pnpm build",\n  "out": "dist"\n}\n`,
      ".github/actions/browsers/action.yml": action("browsers"),
      ".github/actions/setup-playwright/action.yml": action("setup-playwright"),
      "scripts/e2e.sh": "npx playwright install chromium\n",
      "docs/testing.md": "npx playwright install chromium\n",
    });
    const result = check(root);
    expect(result.breaks.map((each) => [each.file, each.line])).toEqual([
      [".github/actions/browsers/action.yml", 5],
      [".github/site.json", 2],
    ]);
    expect(result.breaks[1]?.message).toContain('"playwright-browsers"');
  });

  it("passes with the shared action, the key playwright-browsers, or no install at all", () => {
    const root = repository({
      ".github/workflows/e2e.yml": job("      - run: pnpm install", ...SHARED_STEP, "      - run: pnpm --filter @lag/site exec playwright test"),
      ".github/site.json": `{\n  "build": "pnpm build",\n  "out": "dist",\n  "playwright-browsers": "chromium"\n}\n`,
    });
    expect(check(root).status).toBe("pass");
    expect(check(repository({})).status).toBe("pass");
  });

  it("warns before its day failsFrom, so the update pull requests merge while the owners fix the breaks", () => {
    const root = repository({ ".github/workflows/e2e.yml": job("      - run: npx playwright install --with-deps") });
    expect(check(root, "2026-11-30").status).toBe("warn");
    expect(check(root, "2026-12-01").status).toBe("break");
  });
});
