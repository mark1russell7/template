// The permissions of each call of a reusable workflow of this repository. Start the tests with "pnpm test:workflows".
// A called workflow gets at most the permissions that its caller grants. When a job of the called file asks for more,
// GitHub stops the whole run of the caller at its start, also when an if skips that job. On 11-17, the job rules of
// ci.yml asked for "pull-requests: read", and each run of release.yml stopped with a startup failure.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const folder = resolve(root, ".github", "workflows");

/** The level of a permission. */
type Level = "none" | "read" | "write";
const RANK: Record<Level, number> = { none: 0, read: 1, write: 2 };

/** The permissions of a block: each scope and its level, or "read-all" or "write-all". */
type Permissions = Map<string, Level> | "read-all" | "write-all";

/**
 * This function gives the permissions block of a text at an indent, or undefined when the text has none at that indent.
 * The text is a whole workflow (indent "") or the text of one job (indent "    ").
 */
export function permissionsAt(text: string, indent: string): Permissions | undefined {
  const lines = text.split("\n");
  const head = new RegExp(`^${indent}permissions:\\s*(.*?)\\s*(#.*)?$`, "u");
  const index = lines.findIndex((line) => head.test(line));
  if (index < 0) return undefined;
  const value = head.exec(lines[index] ?? "")?.[1] ?? "";
  if (value === "read-all" || value === "write-all") return value;
  const scopes = new Map<string, Level>();
  if (value === "{}") return scopes;
  assert.equal(value, "", `The permissions "${value}" at the indent "${indent}" have a form that this test does not read.`);
  const scope = new RegExp(`^${indent}  ([a-z-]+):\\s*(none|read|write)\\s*(#.*)?$`, "u");
  for (const line of lines.slice(index + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const match = scope.exec(line);
    if (!match) break;
    scopes.set(match[1] ?? "", (match[2] ?? "none") as Level);
  }
  return scopes;
}

/** The jobs of a workflow: the key of each job and its text, from its key to the key of the next job. */
export function jobsOf(workflow: string): Map<string, string> {
  const start = workflow.indexOf("\njobs:\n");
  const jobs = new Map<string, string>();
  if (start < 0) return jobs;
  const body = workflow.slice(start + "\njobs:\n".length);
  const key = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/gmu;
  const keys = [...body.matchAll(key)];
  keys.forEach((match, i) => {
    const end = keys[i + 1]?.index ?? body.length;
    jobs.set(match[1] ?? "", body.slice(match.index, end).split("\n").slice(1).join("\n"));
  });
  return jobs;
}

/** The level of a scope in a block. A scope that the block does not name has the level none. */
function levelOf(permissions: Permissions, scope: string): Level {
  if (permissions === "read-all") return "read";
  if (permissions === "write-all") return "write";
  return permissions.get(scope) ?? "none";
}

/** The scopes of the token of a job (the GitHub docs, "Permissions for the GITHUB_TOKEN"). */
const SCOPES = ["actions", "attestations", "checks", "contents", "deployments", "discussions", "id-token", "issues", "models", "packages", "pages", "pull-requests", "security-events", "statuses"];

/** The scopes of a block. "read-all" and "write-all" name each scope of the token. */
function scopesOf(permissions: Permissions): string[] {
  return typeof permissions === "string" ? SCOPES : [...permissions.keys()];
}

/** A scope that a job of a called workflow asks for, above the grant of its caller. */
export interface Excess {
  readonly caller: string;
  readonly callee: string;
  readonly job: string;
  readonly scope: string;
  readonly asks: Level;
  readonly granted: Level;
}

/**
 * This function gives each scope that a job of the called workflow asks for, above the grant of the calling job.
 * A job with no permissions block asks for the permissions of the top of its file. A job of a file with neither
 * inherits the grant, so it asks for nothing more.
 */
export function excessOf(caller: string, grant: Permissions, callee: string, workflow: string): Excess[] {
  const top = permissionsAt(workflow, "");
  const out: Excess[] = [];
  for (const [job, text] of jobsOf(workflow)) {
    const asks = permissionsAt(text, "    ") ?? top;
    if (asks === undefined) continue;
    for (const scope of scopesOf(asks)) {
      const level = levelOf(asks, scope);
      const granted = levelOf(grant, scope);
      if (RANK[level] > RANK[granted]) out.push({ caller, callee, job, scope, asks: level, granted });
    }
  }
  return out;
}

/** A call of a reusable workflow of this repository: the calling file and job, the called file, and the grant. */
export interface Call {
  readonly caller: string;
  readonly job: string;
  readonly callee: string;
  readonly grant: Permissions | undefined;
}

/**
 * This function gives each job of a workflow that calls a workflow of this repository, by the local form
 * "./.github/workflows/<file>" or by the form "mark1russell7/template/.github/workflows/<file>@<ref>". The grant is
 * the permissions block of the job, else the top of the file, else undefined (the default of the repository).
 */
export function callsOf(file: string, workflow: string): Call[] {
  const top = permissionsAt(workflow, "");
  const uses = /^ {4}uses:\s*["']?(?:\.\/|mark1russell7\/template\/)\.github\/workflows\/([A-Za-z0-9_.-]+\.ya?ml)/mu;
  const out: Call[] = [];
  for (const [job, text] of jobsOf(workflow)) {
    const callee = uses.exec(text)?.[1];
    if (callee) out.push({ caller: file, job, callee, grant: permissionsAt(text, "    ") ?? top });
  }
  return out;
}

const files = readdirSync(folder).filter((name) => /\.ya?ml$/u.test(name));
const read = (name: string): string => readFileSync(resolve(folder, name), "utf-8").replace(/\r\n/gu, "\n");

describe("the permissions of each call of a reusable workflow", () => {
  const calls = files.flatMap((name) => callsOf(name, read(name)));

  it("reads the calls of release.yml, so the check is not empty", () => {
    const release = calls.filter((call) => call.caller === "release.yml").map((call) => `${call.job} ${call.callee}`);
    assert.ok(release.includes("verify ci.yml"), `release.yml calls ci.yml in its job verify. Calls read: ${release.join(", ")}`);
    assert.ok(calls.length >= 5, `The test reads ${calls.length} calls.`);
  });

  it("grants each permission that a job of the called workflow asks for", () => {
    const excess = calls.flatMap((call) =>
      call.grant === undefined || !files.includes(call.callee) ? [] : excessOf(call.caller, call.grant, call.callee, read(call.callee)),
    );
    const lines = excess.map((e) => `${e.caller} calls ${e.callee}: the job ${e.job} asks for "${e.scope}: ${e.asks}", and the caller grants "${e.granted}".`);
    assert.deepEqual(lines, []);
  });

  it("names a called workflow that exists", () => {
    const missing = calls.filter((call) => !files.includes(call.callee)).map((call) => `${call.caller} (${call.job}) calls ${call.callee}`);
    assert.deepEqual(missing, []);
  });
});

describe("the read of the permissions", () => {
  const caller = ["on: push", "permissions: {}", "jobs:", "  verify:", "    uses: ./.github/workflows/ci.yml", "    permissions:", "      contents: read", ""].join("\n");
  const callee = (job: string): string =>
    ["on: workflow_call", "permissions:", "  contents: read", "jobs:", "  a:", "    runs-on: ubuntu-latest", "  b:", job, "    runs-on: ubuntu-latest", ""].join("\n");

  it("finds the case of 11-17: a skipped job that asks for pull-requests", () => {
    const [call] = callsOf("release.yml", caller);
    assert.ok(call?.grant);
    const job = ["    if: github.event_name == 'pull_request'", "    permissions:", "      contents: read", "      pull-requests: read"].join("\n");
    const excess = excessOf("release.yml", call.grant, "ci.yml", callee(job));
    assert.deepEqual(excess.map((e) => `${e.job} ${e.scope} ${e.asks} ${e.granted}`), ["b pull-requests read none"]);
  });

  it("passes a job that asks for the grant or less, and a job that inherits the top of its file", () => {
    const [call] = callsOf("release.yml", caller);
    assert.ok(call?.grant);
    assert.deepEqual(excessOf("release.yml", call.grant, "ci.yml", callee("    permissions:\n      contents: read")), []);
    assert.deepEqual(excessOf("release.yml", call.grant, "ci.yml", callee("    permissions: {}")), []);
  });

  it("finds a write above a read, and a top of the file above the grant", () => {
    const grant = new Map<string, Level>([["contents", "read"]]);
    const write = excessOf("x.yml", grant, "y.yml", callee("    permissions:\n      contents: write"));
    assert.deepEqual(write.map((e) => `${e.job} ${e.scope} ${e.asks}`), ["b contents write"]);
    const top = ["on: workflow_call", "permissions:", "  issues: write", "jobs:", "  a:", "    runs-on: ubuntu-latest", ""].join("\n");
    assert.deepEqual(excessOf("x.yml", grant, "y.yml", top).map((e) => `${e.job} ${e.scope}`), ["a issues"]);
  });

  it("reads read-all and write-all, and refuses a form that it does not know", () => {
    assert.equal(permissionsAt("permissions: read-all\njobs:\n", ""), "read-all");
    const grant = new Map<string, Level>([["contents", "read"]]);
    const all = excessOf("x.yml", grant, "y.yml", callee("    permissions: write-all"));
    assert.equal(all.length, SCOPES.length);
    assert.ok(all.some((e) => e.scope === "contents" && e.asks === "write" && e.granted === "read"));
    assert.throws(() => permissionsAt("permissions: ${{ fromJSON(x) }}\n", ""));
  });
});
