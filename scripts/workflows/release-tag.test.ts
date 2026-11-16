// The tests of the step "Tag and release" of reusable-release-tag.yml. Start them with "pnpm test:workflows". Each test
// starts the step with bash, as GitHub starts it. A fake gh keeps the tags of the repository in a file, and a fake curl
// serves the provenance statements of npm. The step needs bash and jq, so the tests do not start on Windows.
//
// Two releases do not wait for each other before the publish (release.yml). GitHub keeps only the newest publish that
// waits, so the publish of run 2 can be cancelled. Run 3 then publishes the versions of run 2 too, and its tag job tags
// them. A tag job also tags a version that npm has from an earlier run of this repository and that has no tag.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { runBlock } from "./run-block.ts";

const root = resolve(import.meta.dirname, "..", "..");
const STEP = runBlock(readFileSync(join(root, ".github", "workflows", "reusable-release-tag.yml"), "utf8"), "      - name: Tag and release\n");

const REPOSITORY = "owner/repo";
const REPOSITORY_ID = "123";
/** The commits of the runs 1, 2 and 3, as full SHAs. */
const S1 = "1".repeat(40);
const S2 = "2".repeat(40);
const S3 = "3".repeat(40);

/** A version of the plan of the tags: the tag is "<name>@<version>", for a repository with more published packages. */
interface Version {
  readonly name: string;
  readonly version: string;
}

/** The result of one start of the step: the exit status, stdout and stderr, and the tags of the repository after it. */
interface Run {
  readonly status: number | null;
  readonly log: string;
  readonly tags: ReadonlyMap<string, string>;
}

// The fake gh: "api repos/<repository>/git/ref/tags/<tag>" gives the tag or HTTP 404, and "release create <tag> ...
// --target <commit>" adds the tag. A tag in race.txt gets made by a different run first: then gh fails with HTTP 422.
// A tag in fail.txt gives HTTP 500 and no tag.
const FAKE_GH = [
  "#!/usr/bin/env bash",
  'echo "$*" >> "$FAKE/gh.log"',
  'if [ "$1" = api ]; then',
  '  tag="${2#"repos/$GITHUB_REPOSITORY/git/ref/tags/"}"',
  '  if awk -v tag="$tag" \'$1 == tag { found = 1 } END { exit !found }\' "$FAKE/tags.txt"; then echo "{}"; exit 0; fi',
  '  echo "gh: Not Found (HTTP 404)" >&2',
  "  exit 1",
  "fi",
  'if [ "$1 $2" = "release create" ]; then',
  '  tag="$3"; target=""',
  "  shift 3",
  '  while [ $# -gt 0 ]; do if [ "$1" = --target ]; then target="$2"; fi; shift; done',
  '  if grep -qxF -- "$tag" "$FAKE/race.txt"; then',
  '    echo "$tag other-run" >> "$FAKE/tags.txt"',
  '    echo "HTTP 422: Validation Failed: Release.tag_name already exists" >&2',
  "    exit 1",
  "  fi",
  '  if grep -qxF -- "$tag" "$FAKE/fail.txt"; then echo "HTTP 500: Server Error" >&2; exit 1; fi',
  '  echo "$tag $target" >> "$FAKE/tags.txt"',
  '  echo "https://github.com/$GITHUB_REPOSITORY/releases/tag/$tag"',
  "  exit 0",
  "fi",
  'echo "The fake gh has no command $1 $2." >&2',
  "exit 2",
  "",
].join("\n");

// The fake curl: the attestations of "<name>@<version>" come from attestations/<name with __ for />@<version>.json, else 404.
const FAKE_CURL = [
  "#!/usr/bin/env bash",
  'out=""; url=""',
  'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -w) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done',
  'key="${url#https://registry.npmjs.org/-/npm/v1/attestations/}"; key="${key//%2f/__}"',
  'if [ -f "$FAKE/attestations/$key.json" ]; then cp "$FAKE/attestations/$key.json" "$out"; printf 200; else printf 404; fi',
  "",
].join("\n");

/** The attestations of npm for a version: a publish statement and a SLSA provenance statement of a repository and a commit. */
function attestations(repositoryId: string, commit: string): string {
  const statement = { predicate: { buildDefinition: { internalParameters: { github: { repository_id: repositoryId } }, resolvedDependencies: [{ digest: { gitCommit: commit } }] } } };
  return JSON.stringify({
    attestations: [
      { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", bundle: { dsseEnvelope: { payload: Buffer.from("{}").toString("base64") } } },
      { predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } },
    ],
  });
}

/** A repository with tags and a registry with provenance statements, in a temporary folder. Each start of the step is one run. */
class Fixture {
  readonly folder = mkdtempSync(join(tmpdir(), "release-tag-"));
  private runs = 0;

  constructor(tags: Readonly<Record<string, string>>, provenance: Readonly<Record<string, { readonly repositoryId: string; readonly commit: string }>> = {}) {
    const bin = join(this.folder, "bin");
    mkdirSync(bin);
    mkdirSync(join(this.folder, "attestations"));
    writeFileSync(join(bin, "gh"), FAKE_GH);
    writeFileSync(join(bin, "curl"), FAKE_CURL);
    for (const tool of ["gh", "curl"]) chmodSync(join(bin, tool), 0o755);
    writeFileSync(join(this.folder, "tags.txt"), Object.entries(tags).map(([tag, commit]) => `${tag} ${commit}\n`).join(""));
    for (const file of ["race.txt", "fail.txt", "gh.log"]) writeFileSync(join(this.folder, file), "");
    for (const [version, { repositoryId, commit }] of Object.entries(provenance)) {
      writeFileSync(join(this.folder, "attestations", `${version.replace("/", "__")}.json`), attestations(repositoryId, commit));
    }
  }

  /** This function makes gh fail for a tag: "race" when a different run makes the tag first, "fail" with no tag. */
  failCreate(tag: string, how: "race" | "fail"): void {
    writeFileSync(join(this.folder, `${how}.txt`), `${tag}\n`, { flag: "a" });
  }

  /** This function gives the tags of the repository, each with its commit. */
  tags(): Map<string, string> {
    const lines = readFileSync(join(this.folder, "tags.txt"), "utf8").split("\n").filter((line) => line !== "");
    return new Map(lines.map((line): [string, string] => [line.split(" ")[0] ?? "", line.split(" ")[1] ?? ""]));
  }

  /** This function starts the step of a run on its commit, with its plan and the versions that its publish published. */
  run(sha: string, plan: readonly Version[], published: readonly Version[]): Run {
    this.runs += 1;
    const work = join(this.folder, `run-${String(this.runs)}`);
    mkdirSync(join(work, "tags"), { recursive: true });
    const entries = plan.map(({ name, version }) => ({ name, version, tag: `${name}@${version}`, prerelease: false, notes: `The release of ${name} ${version}.` }));
    writeFileSync(join(work, "tags", "tags.json"), JSON.stringify(entries));
    const summary = join(work, "summary.md");
    writeFileSync(summary, "");
    const run = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", STEP], {
      cwd: work,
      encoding: "utf8",
      env: {
        PATH: [join(this.folder, "bin"), dirname(process.execPath), process.env["PATH"] ?? ""].join(delimiter),
        FAKE: this.folder,
        GH_TOKEN: "token",
        PUBLISHED: published.map(({ name, version }) => `${name}@${version}`).join(" "),
        DRY_RUN: "false",
        REPOSITORY_ID,
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_SHA: sha,
        GITHUB_RUN_ID: String(this.runs),
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    return { status: run.status, log: `${run.stdout}${run.stderr}`, tags: this.tags() };
  }

  dispose(): void {
    rmSync(this.folder, { recursive: true, force: true });
  }
}

const A3: Version = { name: "@scope/a", version: "0.42.3" };
const A4: Version = { name: "@scope/a", version: "0.42.4" };
const B0: Version = { name: "b", version: "1.0.0" };
const B1: Version = { name: "b", version: "1.0.1" };

describe("the step Tag and release", { skip: process.platform === "win32" ? "the step needs bash and jq" : false }, () => {
  it("tags the versions of run 2 and run 3 after run 3, when the publish of run 2 was cancelled", () => {
    const fixture = new Fixture({ "@scope/a@0.42.3": S1, "b@1.0.0": S1 });
    try {
      // Run 2 raised @scope/a to 0.42.4. A newer publish replaced its publish, so it published nothing.
      const run2 = fixture.run(S2, [A4, B0], []);
      assert.equal(run2.status, 0, run2.log);
      assert.match(run2.log, /@scope\/a 0\.42\.4: this run did not publish it, and npm has no provenance statement of this repository for it\. It gets no tag\./u);
      assert.match(run2.log, /The tag b@1\.0\.0 exists\./u);
      assert.deepEqual([...run2.tags.keys()], ["@scope/a@0.42.3", "b@1.0.0"]);
      // Run 3 raised b to 1.0.1. Its tree also has @scope/a 0.42.4, so its publish published both versions.
      const run3 = fixture.run(S3, [A4, B1], [A4, B1]);
      assert.equal(run3.status, 0, run3.log);
      assert.equal(run3.tags.get("@scope/a@0.42.4"), S3, run3.log);
      assert.equal(run3.tags.get("b@1.0.1"), S3, run3.log);
      assert.equal(run3.tags.get("@scope/a@0.42.3"), S1);
      assert.equal(run3.tags.size, 4, run3.log);
    } finally {
      fixture.dispose();
    }
  });

  it("tags a version that npm has from an earlier run of this repository on the commit of its provenance statement", () => {
    // Run 2 published @scope/a 0.42.4, but its tag job did not finish. Run 3 published only b 1.0.1.
    const fixture = new Fixture({ "@scope/a@0.42.3": S1, "b@1.0.0": S1 }, { "@scope/a@0.42.4": { repositoryId: REPOSITORY_ID, commit: S2 } });
    try {
      const run3 = fixture.run(S3, [A4, B1], [B1]);
      assert.equal(run3.status, 0, run3.log);
      assert.match(run3.log, new RegExp(`@scope/a 0\\.42\\.4: npm has it from the commit ${S2} of this repository, and it has no tag\\.`, "u"));
      assert.equal(run3.tags.get("@scope/a@0.42.4"), S2, run3.log);
      assert.equal(run3.tags.get("b@1.0.1"), S3, run3.log);
      // A second start of the same run makes no tag again.
      const again = fixture.run(S3, [A4, B1], [B1]);
      assert.equal(again.status, 0, again.log);
      assert.match(again.log, /The tag @scope\/a@0\.42\.4 exists\./u);
      assert.equal(again.tags.size, 4, again.log);
    } finally {
      fixture.dispose();
    }
  });

  it("gives no tag to a version with a provenance statement of a different repository, or with none", () => {
    const fixture = new Fixture({}, { "c@2.0.0": { repositoryId: "999", commit: S2 } });
    try {
      const run = fixture.run(S3, [{ name: "c", version: "2.0.0" }, { name: "d", version: "1.0.0" }], []);
      assert.equal(run.status, 0, run.log);
      assert.match(run.log, /c 2\.0\.0: this run did not publish it, and npm has no provenance statement of this repository for it\. It gets no tag\./u);
      assert.match(run.log, /d 1\.0\.0: this run did not publish it/u);
      assert.equal(run.tags.size, 0, run.log);
    } finally {
      fixture.dispose();
    }
  });

  it("skips a tag that a different run makes at the same time, and fails when gh makes no tag", () => {
    const fixture = new Fixture({ "@scope/a@0.42.3": S1 });
    fixture.failCreate("b@1.0.1", "race");
    try {
      const run = fixture.run(S3, [A3, B1], [B1]);
      assert.equal(run.status, 0, run.log);
      assert.match(run.log, /gh did not make the release b@1\.0\.1, but the tag exists: a different run made it at the same time\./u);
      assert.equal(run.tags.get("b@1.0.1"), "other-run", run.log);
      fixture.failCreate("@scope/a@0.42.4", "fail");
      const failed = fixture.run(S3, [A4], [A4]);
      assert.equal(failed.status, 1, failed.log);
      assert.match(failed.log, /::error::gh did not make the release @scope\/a@0\.42\.4: HTTP 500: Server Error/u);
      assert.equal(failed.tags.has("@scope/a@0.42.4"), false, failed.log);
    } finally {
      fixture.dispose();
    }
  });
});
