// Tests dist-tag.ts of the action npm-publish: the dist-tag of each publish. "latest" goes only to a version that is
// higher than the "latest" of npm by the precedence of SemVer, so a lower version that a later run publishes does not
// move "latest" back. The end-to-end tests start the script on packument files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { runBlock } from "../../scripts/workflows/run-block.ts";
import { compareVersions, distTag, latestOf, parseVersion, type Version } from "./npm-publish/dist-tag.ts";

const script = join(import.meta.dirname, "npm-publish", "dist-tag.ts");
const action = readFileSync(join(import.meta.dirname, "npm-publish", "action.yml"), "utf8");

/** This function reads a version that the test knows is correct. */
const version = (text: string): Version => {
  const parsed = parseVersion(text);
  assert.ok(parsed, text);
  return parsed;
};

describe("compareVersions", () => {
  it("compares the numbers by value, not as text: 0.1.10 is higher than 0.1.9", () => {
    assert.equal(compareVersions(version("0.1.10"), version("0.1.9")), 1);
    assert.equal(compareVersions(version("0.1.9"), version("0.1.10")), -1);
    assert.equal(compareVersions(version("0.10.0"), version("0.9.12")), 1);
    assert.equal(compareVersions(version("10.0.0"), version("9.99.99")), 1);
  });

  it("gives 0 for the same version, and the build metadata has no effect", () => {
    assert.equal(compareVersions(version("1.2.3"), version("1.2.3")), 0);
    assert.equal(compareVersions(version("1.2.3+build.5"), version("1.2.3+build.6")), 0);
  });

  it("orders the pre-releases of semver.org item 11", () => {
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let index = 1; index < order.length; index += 1) {
      const [lower, higher] = [order[index - 1] ?? "", order[index] ?? ""];
      assert.equal(compareVersions(version(higher), version(lower)), 1, `${higher} > ${lower}`);
      assert.equal(compareVersions(version(lower), version(higher)), -1, `${lower} < ${higher}`);
    }
  });
});

describe("parseVersion", () => {
  it("refuses a text that is not a SemVer version", () => {
    for (const text of ["", "1", "1.2", "v1.2.3", "01.2.3", "1.02.3", "1.2.3-", "1.2.3-01", "1.2.3-a..b", " 1.2.3", "1.2.3 ", "latest"]) {
      assert.equal(parseVersion(text), undefined, JSON.stringify(text));
    }
  });

  it("reads the parts and the pre-release identifiers", () => {
    assert.deepEqual(parseVersion("1.2.3-rc.1+sha.abc"), { major: 1, minor: 2, patch: 3, prerelease: ["rc", "1"] });
    assert.deepEqual(parseVersion("0.0.0-bootstrap.0"), { major: 0, minor: 0, patch: 0, prerelease: ["bootstrap", "0"] });
  });
});

describe("distTag", () => {
  it("gives latest to 0.1.10 when the latest of npm is 0.1.9", () => {
    assert.deepEqual(distTag("0.1.10", "0.1.9"), { tag: "latest" });
  });

  it("gives latest-0.1 to 0.1.9 when the latest of npm is 0.1.10, and names the version that supersedes it", () => {
    assert.deepEqual(distTag("0.1.9", "0.1.10"), { tag: "latest-0.1", supersededBy: "0.1.10" });
  });

  it("gives latest-<major>.<minor> of the published version, not of the latest", () => {
    assert.deepEqual(distTag("0.1.2", "0.1.3"), { tag: "latest-0.1", supersededBy: "0.1.3" });
    assert.deepEqual(distTag("1.4.7", "2.0.0"), { tag: "latest-1.4", supersededBy: "2.0.0" });
  });

  it("gives latest when npm has no latest: a first publish", () => {
    assert.deepEqual(distTag("0.1.0", undefined), { tag: "latest" });
  });

  it("gives latest to a release above a pre-release that is the latest of npm", () => {
    assert.deepEqual(distTag("1.0.0", "1.0.0-rc.1"), { tag: "latest" });
    assert.deepEqual(distTag("0.0.1", "0.0.0-bootstrap.0"), { tag: "latest" });
  });

  it("gives next to each pre-release, also with no latest and above the latest", () => {
    assert.deepEqual(distTag("1.2.0-rc.1", "1.1.0"), { tag: "next" });
    assert.deepEqual(distTag("1.2.0-rc.1", undefined), { tag: "next" });
    assert.deepEqual(distTag("1.0.0-rc.1", "2.0.0"), { tag: "next" });
  });

  it("gives an error for a version or a latest that is not SemVer, so the step publishes nothing", () => {
    assert.ok("error" in distTag("1.2", "1.1.0"));
    assert.ok("error" in distTag("1.2.0", "beta"));
  });

  it("never gives a tag that is a SemVer range, which npm refuses", () => {
    for (const [own, latest] of [["0.1.9", "0.1.10"], ["3.12.1", "4.0.0"]] as const) {
      const result = distTag(own, latest);
      assert.ok("tag" in result);
      assert.match(result.tag, /^latest-\d+\.\d+$/u);
      assert.equal(parseVersion(result.tag), undefined);
    }
  });
});

describe("latestOf", () => {
  it("reads the latest dist-tag of a packument, or gives undefined", () => {
    assert.equal(latestOf({ "dist-tags": { latest: "0.1.3", next: "0.2.0-rc.1" } }), "0.1.3");
    assert.equal(latestOf({ "dist-tags": { next: "0.2.0-rc.1" } }), undefined);
    assert.equal(latestOf({ versions: {} }), undefined);
    assert.equal(latestOf(null), undefined);
    assert.equal(latestOf("text"), undefined);
  });
});

describe("dist-tag.ts", () => {
  const start = (packument: string, own: string): { status: number | null; stdout: string; stderr: string } => {
    const folder = mkdtempSync(join(tmpdir(), "npm-publish-"));
    try {
      const file = join(folder, "packument.json");
      writeFileSync(file, packument);
      const run = spawnSync(process.execPath, [script, own, file], { encoding: "utf8" });
      return { status: run.status, stdout: run.stdout, stderr: run.stderr };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  };

  it("writes the tag, and the latest of npm after it for a superseded version", () => {
    assert.deepEqual(start(JSON.stringify({ "dist-tags": { latest: "0.1.9" } }), "0.1.10"), { status: 0, stdout: "latest\n", stderr: "" });
    assert.deepEqual(start(JSON.stringify({ "dist-tags": { latest: "0.1.10" } }), "0.1.9"), { status: 0, stdout: "latest-0.1 0.1.10\n", stderr: "" });
    assert.deepEqual(start(JSON.stringify({ name: "a" }), "0.1.0"), { status: 0, stdout: "latest\n", stderr: "" });
  });

  it("gives 1 for a packument that is not JSON, and for a version that is not SemVer", () => {
    const bad = start("{", "0.1.0");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /cannot be read/u);
    const version = start(JSON.stringify({}), "0.1");
    assert.equal(version.status, 1);
    assert.match(version.stderr, /not a SemVer version/u);
  });
});

// The step "Publish" of action.yml, started by bash as GitHub starts it, with a fake curl that serves packument files
// and a fake npm that writes its arguments to a log. It needs bash, so it does not start on Windows.
describe("the step Publish", { skip: process.platform === "win32" ? "the step needs bash" : false }, () => {
  /** This function starts the step on a registry of packuments and a list of tarballs, and gives what it did. */
  const publish = (registry: Record<string, unknown>, packages: readonly string[]): { status: number | null; log: string; npm: string[]; output: string; summary: string } => {
    const folder = mkdtempSync(join(tmpdir(), "npm-publish-step-"));
    try {
      const bin = join(folder, "bin");
      const store = join(folder, "registry");
      const work = join(folder, "work");
      for (const path of [bin, store, join(work, "release")]) mkdirSync(path, { recursive: true });
      for (const [name, packument] of Object.entries(registry)) writeFileSync(join(store, `${name.replace("/", "__")}.json`), JSON.stringify(packument));
      writeFileSync(join(work, "release", "packages.txt"), `${packages.join("\n")}\n`);
      writeFileSync(
        join(bin, "curl"),
        [
          "#!/usr/bin/env bash",
          'out=""; url=""',
          'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -w) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done',
          'name="${url#https://registry.npmjs.org/}"; name="${name%%[?]*}"; name="${name//%2f/__}"',
          'if [ -f "$FAKE_REGISTRY/$name.json" ]; then cp "$FAKE_REGISTRY/$name.json" "$out"; printf 200; else printf 500; fi',
          "",
        ].join("\n"),
      );
      writeFileSync(join(bin, "npm"), ["#!/usr/bin/env bash", 'echo "$*" >> "$NPM_LOG"', ""].join("\n"));
      for (const tool of ["curl", "npm"]) chmodSync(join(bin, tool), 0o755);
      const step = join(folder, "step.sh");
      writeFileSync(step, runBlock(action, "    - name: Publish\n"));
      const files = { npm: join(folder, "npm.log"), output: join(folder, "output"), summary: join(folder, "summary") };
      for (const file of Object.values(files)) writeFileSync(file, "");
      const run = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", step], {
        cwd: work,
        encoding: "utf8",
        env: {
          PATH: [bin, dirname(process.execPath), process.env["PATH"] ?? ""].join(delimiter),
          DRY_RUN: "false",
          NEW_PACKAGES: "error",
          ACTION_PATH: join(import.meta.dirname, "npm-publish"),
          FAKE_REGISTRY: store,
          NPM_LOG: files.npm,
          GITHUB_OUTPUT: files.output,
          GITHUB_STEP_SUMMARY: files.summary,
        },
      });
      return {
        status: run.status,
        log: `${run.stdout}${run.stderr}`,
        npm: readFileSync(files.npm, "utf8").split("\n").filter((line) => line !== ""),
        output: readFileSync(files.output, "utf8"),
        summary: readFileSync(files.summary, "utf8"),
      };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  };

  /** The arguments of `npm publish` for a tarball and a tag. */
  const args = (file: string, tag: string): string => `publish ./release/${file} --access public --provenance --tag ${tag} --fetch-retries 0 --logs-dir`;

  it("gives latest only above the latest of npm, latest-<major>.<minor> below it and next to a pre-release", () => {
    const result = publish(
      {
        "@scope/a": { "dist-tags": { latest: "0.1.3" }, versions: { "0.1.3": {} } },
        b: { "dist-tags": { latest: "0.1.9" }, versions: { "0.1.9": {} } },
        c: { "dist-tags": { latest: "0.1.0" }, versions: { "0.1.0": {} } },
        d: { "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": {} } },
      },
      ["@scope/a 0.1.2 scope-a-0.1.2.tgz", "b 0.1.10 b-0.1.10.tgz", "c 0.2.0-rc.1 c-0.2.0-rc.1.tgz", "d 1.0.0 d-1.0.0.tgz"],
    );
    assert.equal(result.status, 0, result.log);
    assert.equal(result.npm.length, 3, result.npm.join("\n"));
    assert.ok(result.npm[0]?.startsWith(args("scope-a-0.1.2.tgz", "latest-0.1")), result.npm.join("\n"));
    assert.ok(result.npm[1]?.startsWith(args("b-0.1.10.tgz", "latest")), result.npm.join("\n"));
    assert.ok(result.npm[2]?.startsWith(args("c-0.2.0-rc.1.tgz", "next")), result.npm.join("\n"));
    assert.equal(result.output, "published=@scope/a@0.1.2 b@0.1.10 c@0.2.0-rc.1\n");
    assert.match(result.summary, /^### Versions that did not get the dist-tag latest$/mu);
    assert.match(result.summary, /^- `@scope\/a@0\.1\.2`: dist-tag `latest-0\.1`, superseded by 0\.1\.3$/mu);
    assert.doesNotMatch(result.summary, /b@0\.1\.10|c@0\.2\.0/u);
  });

  it("writes no summary when each version gets latest", () => {
    const result = publish({ a: { "dist-tags": { latest: "0.1.9" }, versions: { "0.1.9": {} } } }, ["a 0.1.10 a-0.1.10.tgz"]);
    assert.equal(result.status, 0, result.log);
    assert.deepEqual(result.npm.map((line) => line.split(" --logs-dir")[0]), [args("a-0.1.10.tgz", "latest").split(" --logs-dir")[0]]);
    assert.equal(result.summary, "");
  });

  it("publishes nothing more after a latest that is not SemVer, and keeps the output of the versions before it", () => {
    const result = publish(
      { a: { "dist-tags": { latest: "0.1.0" }, versions: { "0.1.0": {} } }, b: { "dist-tags": { latest: "beta" }, versions: {} }, c: { versions: {} } },
      ["a 0.1.1 a-0.1.1.tgz", "b 0.2.0 b-0.2.0.tgz", "c 0.1.0 c-0.1.0.tgz"],
    );
    assert.equal(result.status, 1, result.log);
    assert.equal(result.npm.length, 1, result.log);
    assert.equal(result.output, "published=a@0.1.1\n");
    assert.match(result.log, /::error::The step cannot choose the dist-tag of b 0\.2\.0/u);
  });
});
