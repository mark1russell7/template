// The rule service-run-main on fixture repositories: a server package that starts run() only in src/main.ts, one that
// starts it in another module, a test file, a package with no src/main.ts, and the calls that are not a start. The run()
// of a value of a tool entry, as the pool of /channel, is not a start.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, type RuleResult } from "./index.ts";
import { runCalls } from "./rules/service-run-main.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-service-run-main-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let fixtures = 0;

const ID = "service-run-main";
const SERVER = '{ "name": "api", "dependencies": { "@mark1russell7/service": "^1.0.0" } }\n';
const IMPORT = 'import { service } from "@mark1russell7/service";';
const MAIN = [IMPORT, 'import { api } from "./api.ts";', "await api().run();", ""].join("\n");
const MODULE = [IMPORT, 'export const api = () => service("api");', ""].join("\n");

/** This function makes a git repository of one package with the files, and gives its root. */
function repository(files: Readonly<Record<string, string>>, manifest = SERVER): string {
  const root = join(temp, String(fixtures++));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), manifest);
  for (const [file, text] of Object.entries(files)) {
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

describe("the rule service-run-main", () => {
  it("finds a call of run() only in a text that imports the service package, and not on this or in a comment", () => {
    expect(runCalls(MAIN)).toEqual([3]);
    expect(runCalls("await api().run();\n")).toEqual([]);
    expect(runCalls([IMPORT, "class A { go() { return this.run(); } }"].join("\n"))).toEqual([]);
    expect(runCalls([IMPORT, "// svc.run() starts it", " * svc.run() in a doc comment", "const x = 1;"].join("\n"))).toEqual([]);
    expect(runCalls(['import { daemon } from "@mark1russell7/service/mongodb";', "await svc.run({ process });"].join("\n"))).toEqual([2]);
  });

  it("does not read a text that imports only the tool entries, as the pool of /channel with its own run()", () => {
    const pool = ['import { preemptivePool } from "@mark1russell7/service/channel";', "const pool = preemptivePool(2);", "export const go = () => pool.run(async () => 1);"];
    expect(runCalls(pool.join("\n"))).toEqual([]);
    expect(runCalls(['import { realClock } from "@mark1russell7/service/clock";', 'const { backoffDelay } = await import("@mark1russell7/service/backoff");', "worker.run();"].join("\n"))).toEqual([]);
    // A text that also imports the root, or an entry that is not a tool entry, is read
    expect(runCalls([IMPORT, ...pool].join("\n"))).toEqual([4]);
    expect(runCalls(['import { fakeClock } from "@mark1russell7/service/testing";', "await svc.run();"].join("\n"))).toEqual([2]);
  });

  it("passes a module of a server package that uses the pool of /channel, and still breaks a module that starts a service", () => {
    const pool = ['import { preemptivePool } from "@mark1russell7/service/channel";', "const pool = preemptivePool(2);", "export const go = () => pool.run(async () => 1);", ""].join("\n");
    expect(check(repository({ "src/main.ts": MAIN, "src/api.ts": MODULE, "src/pool.ts": pool })).status).toBe("pass");
    const host = [IMPORT, 'import { preemptivePool } from "@mark1russell7/service/channel";', "export const serve = () => service('api').run();", ""].join("\n");
    const result = check(repository({ "src/main.ts": MAIN, "src/api.ts": MODULE, "src/pool.ts": pool, "src/host.ts": host }));
    expect(result.breaks.map((each) => [each.file, each.line])).toEqual([["src/host.ts", 3]]);
  });

  it("passes a server package that starts run() only in src/main.ts", () => {
    expect(check(repository({ "src/main.ts": MAIN, "src/api.ts": MODULE })).status).toBe("pass");
  });

  it("breaks a module of a server package that starts run(), but not its test", () => {
    const result = check(repository({ "src/main.ts": MAIN, "src/api.ts": MODULE, "src/host.ts": [IMPORT, "export async function serve() {", "  await service('api').run();", "}", ""].join("\n"), "src/host.test.ts": MAIN }));
    expect(result.breaks.map((each) => [each.file, each.line])).toEqual([["src/host.ts", 3]]);
  });

  it("does not examine a package with no src/main.ts, or with no dependency on the service package", () => {
    const host = [IMPORT, "export const serve = () => service('api').run();", ""].join("\n");
    expect(check(repository({ "src/host.ts": host })).status).toBe("pass");
    expect(check(repository({ "src/main.ts": MAIN, "src/host.ts": host }, '{ "name": "api" }\n')).status).toBe("pass");
  });
});
