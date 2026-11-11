// Tests install.sh of the action setup-playwright with a fake Playwright CLI and a fake sudo: the order of the
// installs, the input packages, the probe of the package mirror, the start check and the output packages.
// No browser starts and no package installs. The workflow actions-test.yml tests the action on a real runner.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";

// On Windows, a bare "bash" can start the bash of WSL. The bash of Git for Windows runs the script as the runners do.
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const skip = spawnSync(bash, ["--version"]).status === 0 ? false : "bash is not installed";
const script = join(import.meta.dirname, "setup-playwright", "install.sh");
const root = mkdtempSync(join(tmpdir(), "setup-playwright-")).replaceAll("\\", "/");
after(() => rmSync(root, { recursive: true, force: true }));

// The fake CLI writes each call to the log. FAKE_INSTALL, FAKE_DEPS and FAKE_START are the exit codes of install,
// install-deps and screenshot. A screenshot that passes writes its file (the last argument).
writeFileSync(
  `${root}/playwright`,
  `#!/usr/bin/env bash
echo "playwright $*" >> "$FAKE_LOG"
case "$1" in
  install) exit "\${FAKE_INSTALL:-0}" ;;
  install-deps) exit "\${FAKE_DEPS:-0}" ;;
  screenshot) [ "\${FAKE_START:-0}" = 0 ] || exit 1; echo png > "\${!#}"; exit 0 ;;
esac
exit 2
`,
);
// The fake sudo writes each call to the log. FAKE_PROBE is the exit code of apt-get update. pkill finds no process.
writeFileSync(
  `${root}/sudo`,
  `#!/usr/bin/env bash
echo "sudo $*" >> "$FAKE_LOG"
case "$*" in
  *"apt-get update"*) exit "\${FAKE_PROBE:-0}" ;;
  pkill*) exit 1 ;;
esac
exit 0
`,
);

interface Run {
  code: number | null;
  stdout: string;
  calls: string[];
  output: string;
}

let count = 0;

/** This function starts install.sh with the environment `env` and gives its exit code, its output and the calls. */
function run(env: Record<string, string>): Run {
  count += 1;
  const log = `${root}/log-${count}`;
  const output = `${root}/output-${count}`;
  writeFileSync(log, "");
  writeFileSync(output, "");
  const result = spawnSync(bash, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${root}${delimiter}${process.env["PATH"] ?? ""}`,
      COMMAND: `bash ${root}/playwright`,
      BROWSERS: "chromium",
      HIT: "",
      MINUTES: "1",
      ATTEMPTS: "2",
      PACKAGES: "required",
      RUNNER_OS: "Linux",
      RUNNER_TEMP: root,
      GITHUB_OUTPUT: output,
      FAKE_LOG: log,
      ...env,
    },
  });
  const calls = readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
  return { code: result.status, stdout: result.stdout, calls, output: readFileSync(output, "utf8").trim() };
}

const named = (calls: string[], start: string): string[] => calls.filter((call) => call.startsWith(start));

describe("setup-playwright: install.sh", { skip }, () => {
  it("refuses a value of packages that it does not know, before any install", () => {
    const r = run({ PACKAGES: "maybe" });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /::error::The input packages is "maybe"\. Give "required" or "best-effort"\./);
    assert.deepEqual(r.calls, []);
  });

  it("installs the browsers first and the system packages second, and gives installed", () => {
    const r = run({});
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(named(r.calls, "playwright"), ["playwright install chromium", "playwright install-deps chromium"]);
    assert.equal(r.output, "packages=installed");
  });

  it("skips the install of the browsers on a cache hit", () => {
    const r = run({ HIT: "true", BROWSERS: "chromium firefox" });
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(named(r.calls, "playwright"), ["playwright install-deps chromium firefox"]);
  });

  it("required: fails after the tries of the system packages, with no probe and no start check", () => {
    const r = run({ FAKE_DEPS: "1" });
    assert.equal(r.code, 1);
    assert.equal(named(r.calls, "playwright install-deps").length, 2);
    assert.deepEqual(named(r.calls, "playwright screenshot"), []);
    assert.deepEqual(named(r.calls, "sudo timeout"), []);
    assert.match(r.stdout, /::error::"playwright install-deps chromium" failed 2 times\./);
    assert.equal(r.output, "");
  });

  it("fails when the browsers do not install, also with best-effort", () => {
    const r = run({ PACKAGES: "best-effort", FAKE_INSTALL: "1" });
    assert.equal(r.code, 1);
    assert.equal(named(r.calls, "playwright install chromium").length, 2);
    assert.deepEqual(named(r.calls, "playwright install-deps"), []);
  });

  it("best-effort: a failed probe skips the system packages, and a browser that starts gives missing", () => {
    const r = run({ PACKAGES: "best-effort", FAKE_PROBE: "100", FAKE_DEPS: "1" });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(named(r.calls, "sudo timeout").length, 1);
    assert.match(named(r.calls, "sudo timeout")[0] ?? "", /apt-get update -q -o APT::Update::Error-Mode=any -o Acquire::Retries=0/);
    assert.deepEqual(named(r.calls, "playwright install-deps"), []);
    assert.equal(named(r.calls, "playwright screenshot --browser chromium --timeout 60000 about:blank").length, 1);
    assert.match(r.stdout, /::warning::The system packages of the browsers are not installed: the package mirror did not answer/);
    assert.equal(r.output, "packages=missing");
  });

  it("best-effort: a failed probe and a browser that does not start fail the step", () => {
    const r = run({ PACKAGES: "best-effort", FAKE_PROBE: "100", FAKE_START: "1" });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /::error::chromium does not start/);
    assert.match(r.stdout, /::error::The system packages are not installed \(the package mirror did not answer/);
    assert.equal(r.output, "");
  });

  it("best-effort: failed tries after a probe that passed give missing when the browser starts", () => {
    const r = run({ PACKAGES: "best-effort", FAKE_DEPS: "1" });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(named(r.calls, "playwright install-deps").length, 2);
    assert.match(r.stdout, /::warning::The system packages of the browsers are not installed: "playwright install-deps chromium" failed 2 times/);
    assert.equal(r.output, "packages=missing");
  });

  it("best-effort: a probe and tries that pass give installed, with no start check", () => {
    const r = run({ PACKAGES: "best-effort" });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(named(r.calls, "sudo timeout").length, 1);
    assert.deepEqual(named(r.calls, "playwright screenshot"), []);
    assert.equal(r.output, "packages=installed");
  });

  it("best-effort on macOS: no probe, and failed tries give missing when the browser starts", () => {
    const r = run({ PACKAGES: "best-effort", RUNNER_OS: "macOS", FAKE_DEPS: "1" });
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(named(r.calls, "sudo"), []);
    assert.equal(named(r.calls, "playwright install-deps").length, 2);
    assert.equal(r.output, "packages=missing");
  });

  it("starts each browser with its name, and skips ffmpeg", () => {
    const r = run({ PACKAGES: "best-effort", FAKE_PROBE: "100", BROWSERS: "chromium firefox webkit ffmpeg chrome" });
    assert.equal(r.code, 0, r.stdout);
    const starts = named(r.calls, "playwright screenshot").map((call) => call.replace(/ --timeout.*/, ""));
    assert.deepEqual(starts, [
      "playwright screenshot --browser chromium",
      "playwright screenshot --browser firefox",
      "playwright screenshot --browser webkit",
      "playwright screenshot --browser chromium --channel chrome",
    ]);
    assert.ok(!existsSync(`${root}/setup-playwright-start-chromium.png`), "the start check removes its screenshot");
  });
});
