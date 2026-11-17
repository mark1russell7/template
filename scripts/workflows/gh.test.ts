// Tests of the retry of the reads of the GitHub API (scripts/lib/gh.ts). A fake start of `gh` gives the errors, and a
// fake clock records each wait and ends it at once.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "@mark1russell7/service";
import { type Exec, RETRY, errorText, gh, lines, pool, publicRepos, transient } from "../lib/gh.ts";

/** An error as `execFile` gives it: the message, and the standard error of `gh`. */
const ghError = (stderr: string): Error => Object.assign(new Error("Command failed: gh api x"), { stderr });

/** A fake start of `gh` that gives each answer in turn: an error or a text. */
function script(answers: readonly (Error | string)[]): Exec & { calls: number } {
  let next = 0;
  const start = async (): Promise<string> => {
    start.calls++;
    const answer = answers[Math.min(next++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer as string;
  };
  start.calls = 0;
  return start;
}

/** A clock that records each wait and ends it at once. */
function clock(): Clock & { waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    now: () => 0,
    after: (ms, run) => {
      waits.push(ms);
      queueMicrotask(run);
      return () => {};
    },
  };
}

test("transient is true for a server error and a broken connection, and false for an error of the request", () => {
  assert.equal(transient(ghError("gh: HTTP 502: Bad Gateway (https://api.github.com/repos/o/r/actions/runs)")), true);
  assert.equal(transient(ghError("gh: HTTP 503: Service Unavailable")), true);
  assert.equal(transient(ghError("Get \"https://api.github.com/x\": read tcp: connection reset by peer")), true);
  assert.equal(transient(ghError("net/http: TLS handshake timeout")), true);
  assert.equal(transient(new Error("read ECONNRESET")), true);
  assert.equal(transient(ghError("gh: Not Found (HTTP 404)")), false);
  assert.equal(transient(ghError("gh: HTTP 422: Validation Failed")), false);
  assert.equal(transient(ghError("gh: HTTP 403: API rate limit exceeded")), false);
  assert.match(errorText(ghError("gh: HTTP 502")), /Command failed[\s\S]*HTTP 502/);
});

test("gh tries again after a server error, and gives the text of the first try that succeeds", async () => {
  const start = script([ghError("gh: HTTP 502: Bad Gateway"), ghError("gh: HTTP 504: Gateway Timeout"), '{"a":1}\n{"a":2}\n']);
  const fake = clock();
  assert.deepEqual(await lines<{ a: number }>("repos/o/r/actions/runs", ".[] | tojson", { exec: start, clock: fake }), [{ a: 1 }, { a: 2 }]);
  assert.equal(start.calls, 3);
  // Each wait is the backoff of its try (2 s, then 4 s), less a random part of up to one half.
  assert.equal(fake.waits.length, 2);
  assert.ok((fake.waits[0] as number) >= RETRY.base / 2 && (fake.waits[0] as number) <= RETRY.base, `wait ${fake.waits[0]}`);
  assert.ok((fake.waits[1] as number) >= RETRY.base && (fake.waits[1] as number) <= 2 * RETRY.base, `wait ${fake.waits[1]}`);
});

test("gh gives the error at once for an error of the request, and after the last try for a server error", async () => {
  const notFound = script([ghError("gh: Not Found (HTTP 404)"), "never"]);
  await assert.rejects(gh(["api", "x"], { exec: notFound, clock: clock() }), /Command failed/);
  assert.equal(notFound.calls, 1);
  const down = script([ghError("gh: HTTP 502: Bad Gateway")]);
  const fake = clock();
  await assert.rejects(gh(["api", "x"], { exec: down, clock: fake }), (error: unknown) => /HTTP 502/.test(errorText(error)));
  assert.equal(down.calls, RETRY.tries);
  assert.equal(fake.waits.length, RETRY.tries - 1);
});

test("publicRepos reads each owner in order, and stops on a name that two owners have", async () => {
  const paths: string[] = [];
  const answers: Record<string, string> = {
    a: `${JSON.stringify({ owner: "a", name: "one", default_branch: "main" })}
`,
    b: `${JSON.stringify({ owner: "b", name: "two", default_branch: "trunk" })}
`,
    c: `${JSON.stringify({ owner: "c", name: "One", default_branch: "main" })}
`,
  };
  const exec: Exec = async (args) => {
    const path = args[2] ?? "";
    paths.push(path);
    return answers[path.split("/")[1] ?? ""] ?? "";
  };
  assert.deepEqual(await publicRepos(["a", "b"], { exec }), [
    { owner: "a", name: "one", default_branch: "main" },
    { owner: "b", name: "two", default_branch: "trunk" },
  ]);
  assert.deepEqual(paths, ["users/a/repos?per_page=100", "users/b/repos?per_page=100"]);
  await assert.rejects(publicRepos(["a", "c"], { exec }), /More than one owner has a repository with the name one./);
});

test("pool gives the results in the order of the items, with at most the width of tasks at one time", async () => {
  let running = 0;
  let most = 0;
  const got = await pool([5, 1, 3, 2], 2, async (value) => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((done) => setTimeout(done, value));
    running -= 1;
    return value * 10;
  });
  assert.deepEqual(got, [50, 10, 30, 20]);
  assert.equal(most, 2);
  assert.deepEqual(await pool([], 4, async () => assert.fail("no item, no task")), []);
});
