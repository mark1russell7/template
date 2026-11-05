import { describe, expect, it } from "vitest";
import { githubGreenRun, greenRunOf } from "./github.ts";

const run = (conclusion: string | null, updated_at = "2026-11-05T03:00:00Z", status = "completed") => ({ status, conclusion, updated_at });

describe("the scheduled runs that passed in a row", () => {
  it("counts from the newest run to the first run that did not pass", () => {
    expect(greenRunOf([run("success"), run("success"), run("failure"), run("success")])?.value).toBe(2);
  });

  it("gives 0 when the newest run failed, and a cancelled run breaks the row", () => {
    expect(greenRunOf([run("failure"), run("success")])?.value).toBe(0);
    expect(greenRunOf([run("success"), run("cancelled"), run("success")])?.value).toBe(1);
  });

  it("does not count a run that has not ended, and takes the time of the newest run that ended", () => {
    const green = greenRunOf([run(null, "2026-11-06T03:00:00Z", "in_progress"), run("success", "2026-11-05T03:00:00Z")]);
    expect(green).toEqual({ value: 1, at: "2026-11-05T03:00:00Z" });
  });

  it("gives null when no run ended, because 0 says that a run failed", () => {
    expect(greenRunOf([])).toBeNull();
    expect(greenRunOf([run(null, "2026-11-06T03:00:00Z", "queued")])).toBeNull();
  });
});

describe("the read from GitHub", () => {
  const options = { owner: "o", repo: "r", token: "t", workflow: "nightly.yml" };

  it("asks for the scheduled runs of the workflow, and counts them", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ workflow_runs: [run("success"), run("failure")] }));
    }) as unknown as typeof fetch;
    expect(await githubGreenRun({ ...options, fetch: fetcher })).toEqual({ available: true, value: 1, at: "2026-11-05T03:00:00Z" });
    expect(urls).toEqual(["https://api.github.com/repos/o/r/actions/workflows/nightly.yml/runs?event=schedule&per_page=30"]);
  });

  it("is not available with no token, after an error, or with no run that ended", async () => {
    expect((await githubGreenRun({ ...options, token: undefined })).available).toBe(false);
    const answer = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    expect(await githubGreenRun({ ...options, fetch: answer("{}", 404) })).toEqual({ available: false, reason: "GitHub has no workflow nightly.yml in o/r" });
    expect((await githubGreenRun({ ...options, fetch: answer("{}", 500) })).available).toBe(false);
    expect(await githubGreenRun({ ...options, fetch: answer('{"workflow_runs":[]}') })).toEqual({
      available: false,
      reason: "the workflow nightly.yml has no scheduled run that ended",
    });
  });
});
