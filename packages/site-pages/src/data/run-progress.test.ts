import { describe, expect, it } from "vitest";
import { githubRunProgress, runProgressOf } from "./github.ts";

describe("the progress of a run", () => {
  it("takes the newest end of a job, and leaves out the jobs that have not ended", () => {
    const jobs = [{ completed_at: "2026-11-05T10:00:00Z" }, { completed_at: null }, { completed_at: "2026-11-05T12:00:00Z" }, { completed_at: "2026-11-05T11:00:00Z" }];
    expect(runProgressOf({ status: "in_progress", conclusion: null }, jobs)).toEqual({ status: "in_progress", conclusion: null, lastJobEnd: "2026-11-05T12:00:00Z" });
  });

  it("gives null when no job ended", () => {
    expect(runProgressOf({ status: "queued", conclusion: null }, [{ completed_at: null }]).lastJobEnd).toBeNull();
  });
});

describe("the read of a run from GitHub", () => {
  const options = { owner: "o", repo: "r", token: "t", runId: "41" };
  const answer = (pages: Record<string, { body: unknown; link?: string; status?: number }>) =>
    (async (input: string | URL | Request) => {
      const page = pages[String(input)];
      if (page === undefined) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(page.body), { status: page.status ?? 200, headers: page.link === undefined ? {} : { link: page.link } });
    }) as typeof fetch;
  const RUN = "https://api.github.com/repos/o/r/actions/runs/41";
  const JOBS = `${RUN}/jobs?filter=latest&per_page=100`;

  it("reads each page of jobs", async () => {
    const fetch = answer({
      [RUN]: { body: { status: "in_progress", conclusion: null } },
      [JOBS]: { body: { jobs: [{ completed_at: "2026-11-05T10:00:00Z" }] }, link: `<${JOBS}&page=2>; rel="next"` },
      [`${JOBS}&page=2`]: { body: { jobs: [{ completed_at: "2026-11-05T13:00:00Z" }, { completed_at: null }] } },
    });
    expect(await githubRunProgress({ ...options, fetch })).toEqual({ available: true, status: "in_progress", conclusion: null, lastJobEnd: "2026-11-05T13:00:00Z" });
  });

  it("gives no partial read when the jobs have more pages than the limit", async () => {
    const fetch = answer({ [RUN]: { body: { status: "in_progress", conclusion: null } }, [JOBS]: { body: { jobs: [] }, link: `<${JOBS}&page=2>; rel="next"` } });
    expect(await githubRunProgress({ ...options, fetch, maxPages: 1 })).toEqual({ available: false, reason: "the run 41 has more than 1 pages of jobs" });
  });

  it("gives a reason with no token, for a missing run and for an error of GitHub", async () => {
    expect(await githubRunProgress({ ...options, token: undefined })).toEqual({ available: false, reason: "the build had no GitHub token" });
    expect(await githubRunProgress({ ...options, fetch: answer({}) })).toEqual({ available: false, reason: "GitHub has no run 41 in o/r" });
    const broken = answer({ [RUN]: { body: { status: "in_progress", conclusion: null } }, [JOBS]: { body: {}, status: 502 } });
    expect(await githubRunProgress({ ...options, fetch: broken })).toEqual({ available: false, reason: "GitHub answered with HTTP 502 for the jobs of the run 41" });
  });
});
