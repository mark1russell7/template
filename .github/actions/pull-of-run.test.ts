// Tests pull.ts of the action pull-of-run: the lookup of the pull request of a run that workflow_dispatch starts, with a
// fake fetch. Also tests the job pull of reusable-ci.yml, and how the jobs changesets, release-check and checks use it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it, mock } from "node:test";
import { main, outputsOf, pullOfRun, PULL_TIMING, type Fetch, type PullInput, type PullResult, type PullTiming } from "./pull-of-run/pull.ts";

const root = resolve(import.meta.dirname, "..", "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

const REPO = "acme/widgets";
const HEAD = "1111111111111111111111111111111111111111";
const OLD_HEAD = "2222222222222222222222222222222222222222";
const BASE_AT_OPEN = "3333333333333333333333333333333333333333";
const TIP = "4444444444444444444444444444444444444444";
const API = "https://api.example.test";

const input: PullInput = { api: API, token: "t0ken", repository: REPO, ref: "refs/heads/topic/one", sha: HEAD };

/** A pull request of the list or of a read, with the fields that the step reads. */
function pull(number: number, over: { head?: string; repo?: string; ref?: string; body?: unknown } = {}): Record<string, unknown> {
  return {
    number,
    title: `A change ${String(number)}`,
    body: over.body ?? "The body",
    commits: 3,
    labels: [{ name: "no changeset" }, { name: "docs" }],
    head: { ref: over.ref ?? "topic/one", sha: over.head ?? HEAD, repo: { full_name: over.repo ?? REPO } },
    base: { ref: "main", sha: BASE_AT_OPEN, repo: { full_name: REPO } },
  };
}

interface Route {
  readonly status: number;
  readonly body: unknown;
  /** The headers of the answer, with lowercase names. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The fetch throws an error with this message, as when the API does not answer. */
  readonly throws?: string;
}

/**
 * This function gives a fake fetch. Each path of the API has a list of answers, in their order. The last answer stays
 * for each later call. The fake records each URL.
 */
function fake(routes: Record<string, Route | Route[]>): { fetcher: Fetch; urls: string[] } {
  const urls: string[] = [];
  const calls = new Map<string, number>();
  const fetcher: Fetch = async (url, init) => {
    urls.push(url);
    assert.equal(init.method, "GET");
    assert.equal(init.headers["authorization"], "Bearer t0ken");
    const path = url.slice(API.length + 1).replace(/\?.*$/u, "");
    const route = routes[path];
    if (route === undefined) return { status: 404, text: async () => JSON.stringify({ message: "Not Found" }) };
    const list = Array.isArray(route) ? route : [route];
    const count = calls.get(path) ?? 0;
    calls.set(path, count + 1);
    const answer = list[Math.min(count, list.length - 1)] as Route;
    if (answer.throws !== undefined) throw new Error(answer.throws);
    const headers = answer.headers ?? {};
    return {
      status: answer.status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => (typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)),
    };
  };
  return { fetcher, urls };
}

const LIST = `repos/${REPO}/pulls`;
const ok = (body: unknown): Route => ({ status: 200, body });
const tip = (sha = TIP): Record<string, Route> => ({ [`repos/${REPO}/git/ref/heads/main`]: ok({ ref: "refs/heads/main", object: { sha, type: "commit" } }) });

/** The time of the tests: no wait, and a record of each sleep. */
function timing(): PullTiming & { slept: number[] } {
  const slept: number[] = [];
  return { ...PULL_TIMING, slept, sleep: async (ms) => void slept.push(ms) };
}

const errorOf = (result: PullResult): string => {
  assert.ok("error" in result, `The result is an error: ${JSON.stringify(result)}`);
  return result.error;
};

describe("pullOfRun", () => {
  it("gives found=false for a run that is not on a branch, and reads nothing", async () => {
    const { fetcher, urls } = fake({});
    const result = await pullOfRun(fetcher, { ...input, ref: "refs/tags/v1.2.3" }, timing());
    assert.deepEqual(result, { found: false, reason: "The run is on refs/tags/v1.2.3, not on a branch, so it has no pull request." });
    assert.deepEqual(urls, []);
  });

  it("gives found=false when the branch has no open pull request", async () => {
    const { fetcher, urls } = fake({ [LIST]: ok([]) });
    const result = await pullOfRun(fetcher, input, timing());
    assert.deepEqual(result, { found: false, reason: "No open pull request has the branch topic/one as its head, so the run examines no change." });
    assert.deepEqual(urls, [`${API}/${LIST}?state=open&head=acme%3Atopic%2Fone&per_page=100`]);
  });

  it("gives the one pull request, with the tip of its base branch, not the base at the open", async () => {
    const { fetcher, urls } = fake({ [LIST]: ok([pull(7)]), [`${LIST}/7`]: ok(pull(7)), ...tip() });
    const time = timing();
    const result = await pullOfRun(fetcher, input, time);
    assert.deepEqual(result, {
      found: true,
      pullRequest: {
        number: 7,
        title: "A change 7",
        body: "The body",
        labels: ["no changeset", "docs"],
        commits: 3,
        base: { ref: "main", sha: TIP },
        head: { ref: "topic/one", sha: HEAD },
      },
    });
    assert.deepEqual(time.slept, []);
    assert.deepEqual(urls.slice(1), [`${API}/${LIST}/7`, `${API}/repos/${REPO}/git/ref/heads/main`]);
  });

  it("reads the pull request again while GitHub has not updated its head, and then gives it", async () => {
    const { fetcher } = fake({ [LIST]: ok([pull(7, { head: OLD_HEAD })]), [`${LIST}/7`]: [ok(pull(7, { head: OLD_HEAD })), ok(pull(7, { head: OLD_HEAD })), ok(pull(7))], ...tip() });
    const time = timing();
    const result = await pullOfRun(fetcher, input, time);
    assert.ok("found" in result && result.found);
    assert.equal(result.pullRequest.head.sha, HEAD);
    assert.deepEqual(time.slept, [10_000, 10_000]);
  });

  it("fails, and names the pull request and both commits, when the head stays different", async () => {
    const { fetcher, urls } = fake({ [LIST]: ok([pull(7, { head: OLD_HEAD })]), [`${LIST}/7`]: ok(pull(7, { head: OLD_HEAD })), ...tip() });
    const time = timing();
    const error = errorOf(await pullOfRun(fetcher, input, time));
    assert.equal(
      error,
      `The pull request #7 has the head ${OLD_HEAD}, but the run is on ${HEAD}. The head stayed different for 30 s, so the job cannot tell the change of the run. When topic/one has a newer commit, the pull_request run of that commit examines it. Else start this run again.`,
    );
    assert.deepEqual(time.slept, [10_000, 10_000, 10_000]);
    // 1 list, 4 reads of the pull request, and no read of the base
    assert.equal(urls.length, 5);
  });

  it("fails when two open pull requests have the branch as their head", async () => {
    const { fetcher } = fake({ [LIST]: ok([pull(7), pull(9)]) });
    assert.equal(
      errorOf(await pullOfRun(fetcher, input, timing())),
      "The open pull requests #7, #9 all have the branch topic/one as their head, so the job cannot tell the base of the change.",
    );
  });

  it("does not take a pull request of a fork, or of another branch that the filter matched", async () => {
    const { fetcher } = fake({ [LIST]: ok([pull(5, { repo: "other/widgets" }), pull(6, { ref: "topic/one-more" })]) });
    const result = await pullOfRun(fetcher, input, timing());
    assert.ok("found" in result && !result.found);
    const both = fake({ [LIST]: ok([pull(5, { repo: "other/widgets" }), pull(7)]), [`${LIST}/7`]: ok(pull(7)), ...tip() });
    const found = await pullOfRun(both.fetcher, input, timing());
    assert.ok("found" in found && found.found);
    assert.equal(found.pullRequest.number, 7);
  });

  it("fails on a refused read (403, 404) of the list or of the pull request, with the permission that a private repository gives", async () => {
    const refused = (status: number): Route => ({ status, body: { message: "Resource not accessible by integration" } });
    for (const status of [403, 404]) {
      const time = timing();
      const error = errorOf(await pullOfRun(fake({ [LIST]: refused(status) }).fetcher, input, time));
      assert.ok(error.startsWith(`GET ${LIST}?state=open&head=acme%3Atopic%2Fone&per_page=100 gave HTTP ${String(status)}: Resource not accessible by integration.`), error);
      assert.match(error, /A private repository gives "pull-requests: read" to the job that calls reusable-ci\.yml, in its ci\.yml, with the input pull-request-private/u);
      // A refusal does not pass when the step reads again, so the step does not wait
      assert.deepEqual(time.slept, []);
      const single = errorOf(await pullOfRun(fake({ [LIST]: ok([pull(7)]), [`${LIST}/7`]: refused(status) }).fetcher, input, timing()));
      assert.ok(single.startsWith(`GET ${LIST}/7 gave HTTP ${String(status)}: Resource not accessible by integration. The token of the job cannot read the pull requests.`), single);
    }
  });

  it("names the rate limit, not the permission, when the rate limit refuses a read", async () => {
    const limited: Route[] = [
      { status: 403, body: { message: "Forbidden" }, headers: { "x-ratelimit-remaining": "0" } },
      { status: 403, body: { message: "You have exceeded a secondary rate limit." } },
      { status: 403, body: { message: "API rate limit exceeded for installation ID 1." } },
    ];
    for (const route of limited) {
      const time = timing();
      const error = errorOf(await pullOfRun(fake({ [LIST]: route }).fetcher, input, time));
      assert.match(error, /gave HTTP 403: .*\. The rate limit of the API stopped the read\. Start the run again when the limit resets\.$/u);
      assert.doesNotMatch(error, /pull-requests: read/u);
      assert.deepEqual(time.slept, []);
    }
    // HTTP 429 fails for a time, so the step reads again, and then names the rate limit and the reads again
    const time = timing();
    const error = errorOf(await pullOfRun(fake({ [LIST]: { status: 429, body: { message: "Too many requests" } } }).fetcher, input, time));
    assert.equal(
      error,
      `GET ${LIST}?state=open&head=acme%3Atopic%2Fone&per_page=100 gave HTTP 429: Too many requests. The rate limit of the API stopped the read. Start the run again when the limit resets. The step read the API again 3 times, 10 s apart, which is the limit of the run.`,
    );
    assert.deepEqual(time.slept, [10_000, 10_000, 10_000]);
  });

  it("reads again after a server error or no answer, and gives the pull request when a read passes", async () => {
    const time = timing();
    const { fetcher, urls } = fake({ [LIST]: [{ status: 500, body: "" }, { status: 0, body: "", throws: "socket hang up" }, ok([pull(7)])], [`${LIST}/7`]: ok(pull(7)), ...tip() });
    const result = await pullOfRun(fetcher, input, time);
    assert.ok("found" in result && result.found, JSON.stringify(result));
    assert.equal(result.pullRequest.base.sha, TIP);
    assert.deepEqual(time.slept, [10_000, 10_000]);
    assert.equal(urls.length, 5);
  });

  it("fails after the limit of reads again, with the status and the count, for all reads of the run together", async () => {
    const list = `GET ${LIST}?state=open&head=acme%3Atopic%2Fone&per_page=100`;
    const server = timing();
    assert.equal(errorOf(await pullOfRun(fake({ [LIST]: { status: 500, body: "" } }).fetcher, input, server)), `${list} gave HTTP 500. The step read the API again 3 times, 10 s apart, which is the limit of the run.`);
    assert.deepEqual(server.slept, [10_000, 10_000, 10_000]);
    // Two reads again of the list, and one of the base branch: the limit is for the run, not for each read
    const shared = timing();
    const base = fake({
      [LIST]: [{ status: 503, body: "" }, { status: 503, body: "" }, ok([pull(7)])],
      [`${LIST}/7`]: ok(pull(7)),
      [`repos/${REPO}/git/ref/heads/main`]: { status: 502, body: { message: "Bad gateway" } },
    });
    assert.equal(
      errorOf(await pullOfRun(base.fetcher, input, shared)),
      `GET repos/${REPO}/git/ref/heads/main gave HTTP 502: Bad gateway. The step read the API again 3 times, 10 s apart, which is the limit of the run.`,
    );
    assert.deepEqual(shared.slept, [10_000, 10_000, 10_000]);
    const thrown: Fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    assert.equal(
      errorOf(await pullOfRun(thrown, input, timing())),
      `The API did not answer GET ${LIST}?state=open&head=acme%3Atopic%2Fone&per_page=100: connect ECONNREFUSED. The step read the API again 3 times, 10 s apart, which is the limit of the run.`,
    );
    // With no reads again, the error has no count
    assert.equal(errorOf(await pullOfRun(fake({ [LIST]: { status: 500, body: "" } }).fetcher, input, { ...timing(), retries: 0 })), `${list} gave HTTP 500.`);
  });

  it("names a base branch that is gone (404), and the contents permission on a refused read of the branch (403)", async () => {
    const routes = (status: number): Record<string, Route> => ({ [LIST]: ok([pull(7)]), [`${LIST}/7`]: ok(pull(7)), [`repos/${REPO}/git/ref/heads/main`]: { status, body: { message: "Not Found" } } });
    assert.equal(
      errorOf(await pullOfRun(fake(routes(404)).fetcher, input, timing())),
      `GET repos/${REPO}/git/ref/heads/main gave HTTP 404: Not Found. The base branch main of #7 is not in the repository: it was deleted or renamed. Change the base of the pull request.`,
    );
    const refused = errorOf(await pullOfRun(fake(routes(403)).fetcher, input, timing()));
    assert.match(refused, /gave HTTP 403: Not Found\. The token of the job cannot read the branches of the repository\. The job that calls reusable-ci\.yml gives "contents: read"\.$/u);
    assert.doesNotMatch(refused, /pull-requests/u);
  });

  it("fails on an answer that it does not know, and on a repository or a commit that is not valid", async () => {
    assert.match(errorOf(await pullOfRun(fake({ [LIST]: ok({ items: [] }) }).fetcher, input, timing())), /not a JSON array/u);
    assert.match(errorOf(await pullOfRun(fake({ [LIST]: ok("<html>") }).fetcher, input, timing())), /not a JSON array/u);
    for (const body of [[pull(7)], "<html>", null]) {
      const single = fake({ [LIST]: ok([pull(7)]), [`${LIST}/7`]: ok(body) });
      assert.equal(errorOf(await pullOfRun(single.fetcher, input, timing())), "The read of the pull request #7 is not a JSON object.");
    }
    const noTip = fake({ [LIST]: ok([pull(7)]), [`${LIST}/7`]: ok(pull(7)), ...tip("") });
    assert.match(errorOf(await pullOfRun(noTip.fetcher, input, timing())), /no commit at the tip of main/u);
    assert.match(errorOf(await pullOfRun(fake({}).fetcher, { ...input, repository: "widgets" }, timing())), /not <owner>\/<name>/u);
    assert.match(errorOf(await pullOfRun(fake({}).fetcher, { ...input, sha: "HEAD" }, timing())), /not the hash of a commit/u);
  });

  it("encodes each segment of a base branch with a slash", async () => {
    const base = { ...pull(7), base: { ref: "release/1.x", sha: BASE_AT_OPEN } };
    const { fetcher, urls } = fake({ [LIST]: ok([base]), [`${LIST}/7`]: ok(base), [`repos/${REPO}/git/ref/heads/release/1.x`]: ok({ object: { sha: TIP } }) });
    const result = await pullOfRun(fetcher, input, timing());
    assert.ok("found" in result && result.found);
    assert.deepEqual(result.pullRequest.base, { ref: "release/1.x", sha: TIP });
    assert.equal(urls.at(-1), `${API}/repos/${REPO}/git/ref/heads/release/1.x`);
  });
});

describe("main", () => {
  const temp = mkdtempSync(join(tmpdir(), "pull-of-run-"));
  after(() => rmSync(temp, { recursive: true, force: true }));
  let files = 0;

  /** This function starts main with a fake fetch, and gives the exit code, the log and the outputs. */
  async function run(routes: Record<string, Route | Route[]>, env: Record<string, string> = {}): Promise<{ code: number; log: string; outputs: Map<string, string>; summary: string }> {
    const output = join(temp, `output-${String(files)}`);
    const summary = join(temp, `summary-${String(files++)}`);
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const lines: string[] = [];
    const log = mock.method(console, "log", (line: string) => void lines.push(line));
    let code: number;
    try {
      code = await main(
        { GITHUB_API_URL: API, GH_TOKEN: "t0ken", GITHUB_REPOSITORY: REPO, GITHUB_REF: input.ref, GITHUB_SHA: HEAD, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env },
        fake(routes).fetcher,
        async () => undefined,
      );
    } finally {
      log.mock.restore();
    }
    const text = readFileSync(output, "utf8");
    const outputs = new Map<string, string>();
    for (const line of text.split("\n").filter((entry) => entry !== "")) {
      const at = line.indexOf("=");
      assert.ok(at > 0, `The line "${line}" is name=value.`);
      outputs.set(line.slice(0, at), line.slice(at + 1));
    }
    return { code, log: lines.join("\n"), outputs, summary: readFileSync(summary, "utf8") };
  }

  it("writes a body with line breaks, quotes, workflow commands and expressions as JSON on one line", async () => {
    const body = 'Line one\r\nLine two with "quotes", 100 % and a tab\t\n::error::not a command\n${{ github.token }}\nEOF\n`code` and é\u{1F600}';
    const routes = { [LIST]: ok([pull(7, { body })]), [`${LIST}/7`]: ok(pull(7, { body })), ...tip() };
    const { code, outputs, log, summary } = await run(routes);
    assert.equal(code, 0);
    assert.deepEqual([...outputs.keys()], ["found", "number", "base-ref", "base-sha", "head-ref", "head-sha", "labels", "pull-request"]);
    assert.equal(outputs.get("found"), "true");
    assert.equal(outputs.get("base-sha"), TIP);
    assert.equal(outputs.get("head-sha"), HEAD);
    assert.equal(outputs.get("labels"), '["no changeset","docs"]');
    const written = JSON.parse(outputs.get("pull-request") ?? "") as { body: string; number: number; commits: number; base: { sha: string } };
    assert.equal(written.body, body);
    assert.equal(written.number, 7);
    assert.equal(written.commits, 3);
    assert.equal(written.base.sha, TIP);
    assert.doesNotMatch(log, /::error/u);
    // escapeMarkdown escapes each ASCII punctuation mark of the branch
    assert.match(summary, /The run is on the head of #7 \(topic\\\/one\)\. The change is from main at 4{40} to 1{40}\./u);
  });

  it("writes found=false and a notice when the branch has no pull request", async () => {
    const { code, outputs, log } = await run({ [LIST]: ok([]) });
    assert.equal(code, 0);
    assert.deepEqual([...outputs.entries()], [["found", "false"]]);
    assert.match(log, /^::notice title=Pull request of the run::No open pull request has the branch topic\/one/mu);
  });

  it("fails with an escaped error, and writes no output", async () => {
    const { code, outputs, log, summary } = await run({ [LIST]: { status: 403, body: { message: "100 % refused\n::warning::injected" } } });
    assert.equal(code, 1);
    assert.equal(outputs.size, 0);
    const lines = log.split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /^::error title=Pull request of the run::GET .* gave HTTP 403: 100 %25 refused%0A::warning::injected\. /u);
    assert.match(summary, /^### Pull request of the run\n\nNo read: /u);
  });

  it("writes the pull request to PULL_REQUEST_FILE, in a folder that it makes, as the output pull-request", async () => {
    const file = join(temp, "folder-one", "folder-two", "pull-request.json");
    const body = `${"A long body. ".repeat(4_000)}\nwith a line break`;
    const routes = { [LIST]: ok([pull(7, { body })]), [`${LIST}/7`]: ok(pull(7, { body })), ...tip() };
    const { code, outputs } = await run(routes, { PULL_REQUEST_FILE: file });
    assert.equal(code, 0);
    const written = readFileSync(file, "utf8");
    assert.ok(written.endsWith("}\n"));
    assert.equal(written, `${outputs.get("pull-request") ?? ""}\n`);
    // Longer than one environment variable on Windows can be, so the job checks reads the file, not the output
    assert.ok(written.length > 32_767);
    assert.equal((JSON.parse(written) as { body: string }).body, body);
  });

  it("writes no file when the branch has no pull request, or when PULL_REQUEST_FILE is empty", async () => {
    const none = join(temp, "none", "pull-request.json");
    assert.equal((await run({ [LIST]: ok([]) }, { PULL_REQUEST_FILE: none })).code, 0);
    assert.equal(existsSync(none), false);
    const { code, outputs } = await run({ [LIST]: ok([pull(7)]), [`${LIST}/7`]: ok(pull(7)), ...tip() }, { PULL_REQUEST_FILE: "" });
    assert.equal(code, 0);
    assert.equal(outputs.get("found"), "true");
  });

  it("fails, and writes no output, when it cannot write PULL_REQUEST_FILE or GITHUB_OUTPUT is not set", async () => {
    const routes = { [LIST]: ok([pull(7)]), [`${LIST}/7`]: ok(pull(7)), ...tip() };
    // The path is a folder, so the write fails
    const folder = join(temp, "a-folder");
    mkdirSync(folder);
    const unwritable = await run(routes, { PULL_REQUEST_FILE: folder });
    assert.equal(unwritable.code, 1);
    assert.equal(unwritable.outputs.size, 0);
    assert.match(unwritable.log, /^::error title=Pull request of the run::The step cannot write the pull request to /mu);
    const noOutput = await run(routes, { GITHUB_OUTPUT: "" });
    assert.equal(noOutput.code, 1);
    assert.match(noOutput.log, /^::error title=Pull request of the run::GITHUB_OUTPUT is not set\.$/mu);
  });
});

describe("outputsOf", () => {
  it("refuses a value with a line break", () => {
    const result: PullResult = {
      found: true,
      pullRequest: { number: 1, title: "", body: "", labels: [], commits: 1, base: { ref: "main\nfound=true", sha: TIP }, head: { ref: "topic", sha: HEAD } },
    };
    assert.throws(() => outputsOf(result), /The output base-ref has a line break/u);
  });
});

describe("the action and its job in reusable-ci.yml", () => {
  const action = read(".github/actions/pull-of-run/action.yml");
  const ci = read(".github/workflows/reusable-ci.yml");

  /** The text of a job, from its key to the key of the next job. */
  function jobText(name: string): string {
    const start = ci.indexOf(`\n  ${name}:\n`);
    assert.ok(start >= 0, `The workflow has the job ${name}.`);
    const next = /\n  [a-z-]+:\n/gu;
    next.lastIndex = start + 1;
    return ci.slice(start, next.exec(ci)?.index ?? ci.length);
  }

  /** The condition of a job or a step, on one line or in a folded block, with each run of spaces as one space. */
  function condition(text: string, indent: number): string {
    const pad = " ".repeat(indent);
    // The first condition at the indent, so a later step with a condition does not count
    const first = new RegExp(`\\n${pad}if: (>-\\n(?:${pad}  .*\\n)+|.+\\n)`, "u").exec(text)?.[1] ?? "";
    return first.replace(/^>-\n/u, "").replace(/\s+/gu, " ").trim();
  }

  it("installs the version of @mark1russell7/text that pnpm-lock.yaml of the template resolves, before the script", () => {
    const lock = read("pnpm-lock.yaml");
    // pnpm 12 writes two documents: the root importer of the second one has the devDependencies
    const locked = [...lock.matchAll(/\nimporters:\n\n {2}\.:\n([\s\S]*?)(?:\n\n|$)/gu)]
      .map((match) => /\n {6}'@mark1russell7\/text':\n {8}specifier: \S+\n {8}version: ([^\s(]+)/u.exec(`\n${match[1] ?? ""}`)?.[1])
      .find((version) => version !== undefined);
    assert.ok(locked !== undefined, "pnpm-lock.yaml resolves no @mark1russell7/text for the root package");
    assert.equal(/\n {8}TEXT_VERSION: "([^"]+)"\n/u.exec(action)?.[1], locked);
    const install = action.indexOf('run: npm install --no-save --no-package-lock --ignore-scripts --prefix "$GITHUB_ACTION_PATH" "@mark1russell7/text@${TEXT_VERSION}"\n');
    assert.ok(install > 0);
    assert.ok(install < action.indexOf('run: node "$PULL"'));
  });

  it("gives each output of the step, and the job gives each output that the other jobs read, but not the text", () => {
    const outputs = ["found", "number", "base-ref", "base-sha", "head-ref", "head-sha", "labels", "pull-request"];
    for (const name of outputs) assert.match(action, new RegExp(`\\n  ${name}:\\n(?: {4}.*\\n)+? {4}value: \\$\\{\\{ steps\\.pull\\.outputs\\.${name} \\}\\}\\n`, "u"), name);
    const job = jobText("pull");
    const block = /\n {4}outputs:\n((?: {6}.*\n)+)/u.exec(job)?.[1] ?? "";
    assert.deepEqual(
      [...block.matchAll(/^ {6}([a-z-]+): \$\{\{ steps\.pull\.outputs\.([a-z-]+) \}\}$/gmu)].map((match) => [match[1], match[2]]),
      ["found", "base-ref", "base-sha", "head-ref", "head-sha", "labels"].map((name) => [name, name]),
    );
    // The text of the pull request goes to the job checks in a file: an output of a job reaches a step as an environment
    // variable, and a body can be longer than Windows allows
    assert.doesNotMatch(job, /outputs\.pull-request/u);
    assert.match(action, /\n  file:\n(?: {4}.*\n)+? {4}default: ""\n/u);
    assert.match(action, /\n {8}PULL_REQUEST_FILE: \$\{\{ inputs\.file \}\}\n/u);
  });

  it("starts the job pull only on a dispatched run on a branch that is not the default branch, with no permissions of its own", () => {
    const job = jobText("pull");
    assert.equal(
      condition(job, 4),
      "github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/') && github.ref != format('refs/heads/{0}', github.event.repository.default_branch) && (!github.event.repository.private || inputs.pull-request-private)",
    );
    // A private repository opts in, because its caller also gives pull-requests: read
    assert.match(ci, /\n {6}pull-request-private:\n(?: {8}.*\n)+? {8}type: boolean\n {8}default: false\n/u);
    // A permissions key above the caller would stop each caller that gives only contents: read
    assert.doesNotMatch(job, /\n {4}permissions:/u);
    // The job runs only code of the template: the action from the commit of the workflow, and no checkout of the repository
    assert.equal([...job.matchAll(/uses: actions\/checkout@/gu)].length, 1);
    assert.match(job, /\n {10}repository: \$\{\{ job\.workflow_repository \}\}\n {10}ref: \$\{\{ job\.workflow_sha \}\}\n {10}path: \.shared-actions\n {10}sparse-checkout: \.github\/actions\n/u);
    assert.match(job, /node-version: "26"/u);
    assert.match(job, /\n {6}- id: pull\n {8}uses: \.\/\.shared-actions\/\.github\/actions\/pull-of-run\n {8}with:\n {10}file: \$\{\{ runner\.temp \}\}\/pull-request-of-run\/pull-request\.json\n/u);
    // The job saves the file for the job checks. A run again of the workflow replaces it.
    const save = job.slice(job.indexOf("- name: Save the pull request of the run"));
    assert.equal(condition(save, 8), "steps.pull.outputs.found == 'true'");
    assert.match(
      save,
      /\n {8}uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+\n {8}with:\n {10}name: pull-request-of-run\n {10}path: \$\{\{ runner\.temp \}\}\/pull-request-of-run\/pull-request\.json\n {10}if-no-files-found: error\n {10}retention-days: 1\n {10}overwrite: true\n/u,
    );
  });

  it("starts the job changesets on a pull request, or on the pull request of the job pull, with its values", () => {
    const job = jobText("changesets");
    assert.match(job, /\n {4}needs: pull\n/u);
    assert.equal(condition(job, 4), "${{ !cancelled() && inputs.changesets && (github.event_name == 'pull_request' || needs.pull.outputs.found == 'true') }}");
    assert.match(job, /\n {10}base-sha: \$\{\{ needs\.pull\.outputs\.base-sha \|\| github\.event\.pull_request\.base\.sha \}\}\n/u);
    assert.match(job, /\n {10}head-sha: \$\{\{ needs\.pull\.outputs\.head-sha \|\| github\.event\.pull_request\.head\.sha \}\}\n/u);
    assert.match(job, /\n {10}head-ref: \$\{\{ needs\.pull\.outputs\.head-ref \|\| github\.event\.pull_request\.head\.ref \}\}\n/u);
    assert.match(job, /\n {10}labels: \$\{\{ needs\.pull\.outputs\.labels \|\| toJSON\(github\.event\.pull_request\.labels\.\*\.name\) \}\}\n/u);
    // The action takes the values of the event by default, so a caller of the action with no inputs keeps working
    const check = read(".github/actions/changeset-check/action.yml");
    assert.match(check, /\n  base-sha:\n(?: {4}.*\n)+? {4}default: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\n/u);
    assert.match(check, /\n  labels:\n(?: {4}.*\n)+? {4}default: \$\{\{ toJSON\(github\.event\.pull_request\.labels\.\*\.name\) \}\}\n/u);
    const variables: readonly (readonly [string, string])[] = [["BASE_SHA", "base-sha"], ["HEAD_SHA", "head-sha"], ["HEAD_REF", "head-ref"], ["LABELS", "labels"]];
    for (const [name, input] of variables) {
      assert.match(check, new RegExp(`\\n {8}${name}: \\$\\{\\{ inputs\\.${input} \\}\\}\\n`, "u"), name);
    }
  });

  it("runs the job checks also when the job pull is skipped or fails, and gives the base and the pull request to the scripts", () => {
    const job = jobText("checks");
    assert.match(job, /\n {4}needs: pull\n {4}if: \$\{\{ !cancelled\(\) \}\}\n/u);
    const deepen = job.slice(job.indexOf("- name: Deepen to the merge base"));
    assert.equal(condition(deepen, 8), "inputs.fetch-depth != 0 && (github.event.pull_request.commits > 0 || needs.pull.outputs.found == 'true')");
    assert.match(deepen, /\n {10}PULL_BASE: \$\{\{ needs\.pull\.outputs\.base-sha \}\}\n/u);
    const file = job.slice(job.indexOf("- name: Pull request of the run"));
    assert.equal(condition(file, 8), "needs.pull.outputs.found == 'true'");
    // The text of the pull request comes as the file of the job pull: no expression and no variable has it
    assert.match(file, /\n {8}uses: actions\/download-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+\n {8}with:\n {10}name: pull-request-of-run\n {10}path: \$\{\{ runner\.temp \}\}\/pull-request-of-run\n/u);
    assert.doesNotMatch(job, /\n {10}PULL_REQUEST:|outputs\.pull-request/u);
    const scripts = job.slice(job.indexOf("- name: Scripts"));
    assert.match(scripts, /\n {10}CONVENTIONS_BASE: \$\{\{ needs\.pull\.outputs\.base-sha \}\}\n/u);
    assert.match(
      scripts,
      /\n {10}CONVENTIONS_PULL_REQUEST: \$\{\{ needs\.pull\.outputs\.found == 'true' && format\('\{0\}\/pull-request-of-run\/pull-request\.json', runner\.temp\) \|\| '' \}\}\n/u,
    );
    // Each pin of upload-artifact and download-artifact is the pin that the other workflows of the template use
    const pins = (name: string): Set<string> =>
      new Set(
        ["reusable-ci.yml", "reusable-mutation.yml", "actions-test.yml"].flatMap((workflow) => [...read(`.github/workflows/${workflow}`).matchAll(new RegExp(`actions/${name}@([0-9a-f]{40})`, "gu"))].map((match) => match[1] ?? "")),
      );
    assert.equal(pins("upload-artifact").size, 1);
    assert.equal(pins("download-artifact").size, 1);
  });
});
