// The rule setup-cue on fixture repositories: the forms of a hand-written install of the cue CLI, comments, and the
// shared action itself.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, type RuleResult } from "./index.ts";
import { cueDownloads } from "./rules/setup-cue.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-setup-cue-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

const ID = "setup-cue";
const URL = "https://github.com/cue-lang/cue/releases/download/v0.15.1/cue_v0.15.1_linux_amd64.tar.gz";

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

function check(root: string): RuleResult {
  const result = runChecks({ root, only: [ID] }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

/** The input setup of a caller of reusable-ci.yml, as in the CI of cue before the rule. */
const CALLER = [
  "on: push",
  "jobs:",
  "  ci:",
  "    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@0000000000000000000000000000000000000000 # main",
  "    with:",
  "      # The tests need the cue CLI",
  "      setup: |",
  '        mkdir -p "$HOME/.local/bin"',
  `        curl -fsSL ${URL} | tar -xz -C "$HOME/.local/bin" cue`,
  "",
].join("\n");

describe("the rule setup-cue", () => {
  it("finds a download of a release asset and a go install, with the version, and not a comment", () => {
    expect(cueDownloads(`a\n  run: curl -fsSL -o "$RUNNER_TEMP/cue.tar.gz" ${URL}\n`)).toEqual([{ line: 2, version: "0.15.1" }]);
    expect(cueDownloads("run: curl -fsSLO https://github.com/cue-lang/cue/releases/download/v0.16.0-rc.1/cue_v0.16.0-rc.1_windows_amd64.zip")).toEqual([{ line: 1, version: "0.16.0-rc.1" }]);
    expect(cueDownloads("run: go install cuelang.org/go/cmd/cue@v0.15.1")).toEqual([{ line: 1, version: "0.15.1" }]);
    expect(cueDownloads("run: go install cuelang.org/go/cmd/cue@latest")).toEqual([{ line: 1, version: undefined }]);
    expect(cueDownloads(`  # before: curl ${URL}\n# go install cuelang.org/go/cmd/cue@v0.15.1\n`)).toEqual([]);
    expect(cueDownloads("uses: mark1russell7/template/.github/actions/setup-cue@0000000 # main\nrun: cue version\n")).toEqual([]);
  });

  it("fails on a download in the input setup of a caller and in a run step, with the line", () => {
    const root = repository({
      ".github/workflows/ci.yml": CALLER,
      ".github/workflows/nightly.yml": ["on: push", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", `      - run: curl -fsSL -o cue.tar.gz ${URL}`, ""].join("\n"),
    });
    const result = check(root);
    expect(result.status).toBe("break");
    expect(result.breaks.map((each) => [each.file, each.line])).toEqual([
      [".github/workflows/ci.yml", 9],
      [".github/workflows/nightly.yml", 6],
    ]);
    expect(result.breaks[0]?.message).toContain("the cue CLI 0.15.1");
    expect(result.breaks[0]?.message).toContain("cue-version");
  });

  it("reads a composite action, and not the shared action of the template or another file", () => {
    const step = `    - run: curl -fsSL ${URL}\n      shell: bash\n`;
    const action = (name: string): string => `name: ${name}\nruns:\n  using: composite\n  steps:\n${step}`;
    const root = repository({
      ".github/actions/tools/action.yml": action("tools"),
      ".github/actions/setup-cue/action.yml": action("setup-cue"),
      "scripts/install.sh": `curl -fsSL ${URL}\n`,
      "docs/ci.md": `curl -fsSL ${URL}\n`,
    });
    expect(check(root).breaks.map((each) => [each.file, each.line])).toEqual([[".github/actions/tools/action.yml", 5]]);
  });

  it("passes with the action, the input cue-version, or no cue at all", () => {
    const root = repository({
      ".github/workflows/ci.yml": CALLER.replace(/ {6}# The tests[\s\S]*$/,'      cue-version: "0.15.1"\n'),
      ".github/workflows/nightly.yml": [
        "on: push",
        "jobs:",
        "  a:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: mark1russell7/template/.github/actions/setup-cue@0000000000000000000000000000000000000000 # main",
        "        with:",
        "          version: 0.15.1",
        "      - run: cue version",
        "",
      ].join("\n"),
    });
    expect(check(root).status).toBe("pass");
    expect(check(repository({})).status).toBe("pass");
  });
});
