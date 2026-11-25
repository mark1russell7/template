// Tests release-runs.ts of the action release-check: the wait while a release run of the repository is open, with a fake
// fetch and a fake clock.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { main, openRuns, reportOf, TRANSIENT_RETRIES, waitForReleases, WAIT_MS, type Fetch, type RunsInput, type RunsTiming } from "./release-check/release-runs.ts";

const input: RunsInput = { api: "https://api.example.test/", token: "t0ken", repository: "acme/widgets", workflow: "release.yml" };
const URL = "https://api.example.test/repos/acme/widgets/actions/workflows/release.yml/runs?per_page=30&exclude_pull_requests=true";

type Answer = { readonly status: number; readonly body: unknown } | Error;

/** A fetch that gives the answers in order, and the last answer after them. It keeps the URL and headers of each read. */
function scripted(answers: readonly Answer[]): { fetcher: Fetch; reads: { url: string; headers: Record<string, string> }[] } {
  const reads: { url: string; headers: Record<string, string> }[] = [];
  const fetcher: Fetch = async (url, init) => {
    const answer = answers[Math.min(reads.length, answers.length - 1)];
    reads.push({ url, headers: init.headers });
    if (answer === undefined) throw new Error("no answer");
    if (answer instanceof Error) throw answer;
    return { status: answer.status, text: async () => (typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)) };
  };
  return { fetcher, reads };
}

/** A clock that moves only when the step sleeps. */
function clock(limitMs: number): RunsTiming & { slept: number[] } {
  let time = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => time,
    sleep: async (ms) => {
      slept.push(ms);
      time += ms;
    },
    limitMs,
    waitMs: WAIT_MS,
  };
}

const runs = (...items: readonly { id: number; status: string }[]) => ({ status: 200, body: { total_count: items.length, workflow_runs: items.map((item) => ({ ...item, html_url: `https://github.com/acme/widgets/actions/runs/${String(item.id)}` })) } });

describe("the wait for an open release", () => {
  it("keeps the runs that are not completed, and refuses a body of another shape", () => {
    assert.deepEqual(openRuns(runs({ id: 1, status: "completed" }, { id: 2, status: "queued" }, { id: 3, status: "in_progress" }).body), [
      { id: 2, status: "queued", url: "https://github.com/acme/widgets/actions/runs/2" },
      { id: 3, status: "in_progress", url: "https://github.com/acme/widgets/actions/runs/3" },
    ]);
    assert.equal(openRuns({ message: "x" }), undefined);
    assert.equal(openRuns({ workflow_runs: [{ id: "1", status: "queued" }] }), undefined);
  });

  it("passes at once when no run is open, with the token and the API version", async () => {
    const { fetcher, reads } = scripted([runs({ id: 1, status: "completed" })]);
    const timing = clock(600_000);
    assert.deepEqual(await waitForReleases(fetcher, input, timing), { kind: "clear", waitedMs: 0, ended: [] });
    assert.equal(reads[0]?.url, URL);
    assert.equal(reads[0]?.headers["Authorization"], "Bearer t0ken");
    assert.equal(reads[0]?.headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.deepEqual(timing.slept, []);
  });

  it("waits while a run is open, and passes when it ends", async () => {
    const { fetcher, reads } = scripted([runs({ id: 7, status: "queued" }), runs({ id: 7, status: "in_progress" }), runs({ id: 7, status: "completed" })]);
    const result = await waitForReleases(fetcher, input, clock(600_000));
    assert.deepEqual(result, { kind: "clear", waitedMs: 2 * WAIT_MS, ended: [7] });
    assert.equal(reads.length, 3);
    assert.equal(reportOf(result, "release.yml", 10).line, "The open runs of release.yml ended (7) after 40 s. The check compares with npm now.");
  });

  it("fails when a run is still open at the limit", async () => {
    const { fetcher, reads } = scripted([runs({ id: 9, status: "waiting" })]);
    const result = await waitForReleases(fetcher, input, clock(60_000));
    assert.equal(result.kind, "open");
    // Reads at 0, 20, 40 and 60 s. A sleep after the read at 60 s passes the limit.
    assert.equal(reads.length, 4);
    const report = reportOf(result, "release.yml", 1);
    assert.equal(report.code, 1);
    assert.match(report.line, /^::error title=Release runs::A run of release\.yml is still open after 1 minutes: 9 \(waiting\) https:\/\/github\.com\/acme\/widgets\/actions\/runs\/9\./u);
  });

  it("reads again after a failed read, and gives a warning after the reads again", async () => {
    const retried = scripted([{ status: 502, body: "" }, new Error("reset"), runs()]);
    assert.deepEqual(await waitForReleases(retried.fetcher, input, clock(600_000)), { kind: "clear", waitedMs: 2 * WAIT_MS, ended: [] });
    const failed = scripted([{ status: 503, body: "" }]);
    const result = await waitForReleases(failed.fetcher, input, clock(600_000));
    assert.equal(failed.reads.length, TRANSIENT_RETRIES + 1);
    assert.equal(result.kind, "unread");
    assert.equal(reportOf(result, "release.yml", 10).code, 0);
    assert.match(reportOf(result, "release.yml", 10).line, /^::warning title=Release runs::GET .* gave HTTP 503\. The step read it 4 times\. The check compares with npm as it is now\.$/u);
  });

  it("gives a notice and passes when the token cannot read the runs, or the workflow is not there", async () => {
    for (const status of [403, 404]) {
      const result = await waitForReleases(scripted([{ status, body: { message: "Resource not accessible by integration" } }]).fetcher, input, clock(600_000));
      assert.equal(result.kind === "unread" ? result.level : result.kind, "notice");
      assert.equal(reportOf(result, "release.yml", 10).code, 0);
    }
    const shape = await waitForReleases(scripted([{ status: 200, body: "[1, 2]" }]).fetcher, input, clock(600_000));
    assert.equal(shape.kind === "unread" ? shape.level : shape.kind, "warning");
  });

  it("main reads no runs with wait-minutes 0, and refuses a wait that is not a number", async () => {
    const { fetcher, reads } = scripted([runs({ id: 1, status: "queued" })]);
    const timing = { sleep: async () => {}, now: () => 0 };
    assert.equal(await main({ WAIT_MINUTES: "0", GITHUB_REPOSITORY: "acme/widgets" }, fetcher, timing), 0);
    assert.equal(reads.length, 0);
    assert.equal(await main({ WAIT_MINUTES: "soon" }, fetcher, timing), 1);
    assert.equal(await main({ WAIT_MINUTES: "-1" }, fetcher, timing), 1);
  });
});
