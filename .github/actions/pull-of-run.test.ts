// Tests pull.ts of the action pull-of-run: the lookup of the pull request of a run that workflow_dispatch starts, with a
// fake fetch. Also tests the job pull of reusable-ci.yml, and how the jobs changesets, release-check and checks use it.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    return { status: answer.status, text: async () => (typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)) };
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
      `The pull request #7 has the head ${OLD_HEAD}, but the run is on ${HEAD}. The head stayed different for 30 s, so the job cannot tell the change of the run. A newer push to topic/one starts a new run.`,
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

  it("fails on a refused read (403, 404) with the permission that a private repository gives", async () => {
    for (const status of [403, 404]) {
      const { fetcher } = fake({ [LIST]: { status, body: { message: "Resource not accessible by integration" } } });
      const error = errorOf(await pullOfRun(fetcher, input, timing()));
      assert.ok(error.startsWith(`GET ${LIST}?state=open&head=acme%3Atopic%2Fone&per_page=100 gave HTTP ${String(status)}: Resource not accessible by integration.`), error);
      assert.match(error, /A private repository gives "pull-requests: read" to the job that calls reusable-ci\.yml, in its ci\.yml/u);
    }
  });

  it("fails on a server error with its status, and on a read of the base branch that fails", async () => {
    const { fetcher } = fake({ [LIST]: { status: 500, body: "" } });
    assert.equal(errorOf(await pullOfRun(fetcher, input, timing())), `GET ${LIST}?state=open&head=acme%3Atopic%2Fone&per_page=100 gave HTTP 500.`);
    const base = fake({ [LIST]: ok([pull(7)]), [`${LIST}/7`]: ok(pull(7)), [`repos/${REPO}/git/ref/heads/main`]: { status: 502, body: { message: "Bad gateway" } } });
    assert.equal(errorOf(await pullOfRun(base.fetcher, input, timing())), `GET repos/${REPO}/git/ref/heads/main gave HTTP 502: Bad gateway.`);
    const thrown: Fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    assert.equal(errorOf(await pullOfRun(thrown, input, timing())), "The API did not answer: connect ECONNREFUSED");
  });

  it("fails on an answer that it does not know, and on a repository or a commit that is not valid", async () => {
    assert.match(errorOf(await pullOfRun(fake({ [LIST]: ok({ items: [] }) }).fetcher, input, timing())), /not a JSON array/u);
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

  it("gives each output of the step, and the job gives each output that the other jobs read", () => {
    const outputs = ["found", "number", "base-ref", "base-sha", "head-ref", "head-sha", "labels", "pull-request"];
    for (const name of outputs) assert.match(action, new RegExp(`\\n  ${name}:\\n(?: {4}.*\\n)+? {4}value: \\$\\{\\{ steps\\.pull\\.outputs\\.${name} \\}\\}\\n`, "u"), name);
    const job = jobText("pull");
    for (const name of ["found", "base-ref", "base-sha", "head-ref", "head-sha", "labels", "pull-request"]) assert.match(job, new RegExp(`\\n {6}${name}: \\$\\{\\{ steps\\.pull\\.outputs\\.${name} \\}\\}\\n`, "u"), name);
  });

  it("starts the job pull only on a dispatched run on a branch that is not the default branch, with no permissions of its own", () => {
    const job = jobText("pull");
    assert.equal(
      condition(job, 4),
      "github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/') && github.ref != format('refs/heads/{0}', github.event.repository.default_branch)",
    );
    // A permissions key above the caller would stop each caller that gives only contents: read
    assert.doesNotMatch(job, /\n {4}permissions:/u);
    // The job runs only code of the template: the action from the commit of the workflow, and no checkout of the repository
    assert.equal([...job.matchAll(/uses: actions\/checkout@/gu)].length, 1);
    assert.match(job, /\n {10}repository: \$\{\{ job\.workflow_repository \}\}\n {10}ref: \$\{\{ job\.workflow_sha \}\}\n {10}path: \.shared-actions\n {10}sparse-checkout: \.github\/actions\n/u);
    assert.match(job, /node-version: "26"/u);
    assert.match(job, /\n {6}- id: pull\n {8}uses: \.\/\.shared-actions\/\.github\/actions\/pull-of-run\n/u);
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
    // The text of the pull request goes through a variable, never through an expression in the script
    assert.match(file, /\n {10}PULL_REQUEST: \$\{\{ needs\.pull\.outputs\.pull-request \}\}\n {8}run: printf '%s\\n' "\$PULL_REQUEST" > "\$RUNNER_TEMP\/pull-request\.json"\n/u);
    const scripts = job.slice(job.indexOf("- name: Scripts"));
    assert.match(scripts, /\n {10}CONVENTIONS_BASE: \$\{\{ needs\.pull\.outputs\.base-sha \}\}\n/u);
    assert.match(scripts, /\n {10}CONVENTIONS_PULL_REQUEST: \$\{\{ needs\.pull\.outputs\.found == 'true' && format\('\{0\}\/pull-request\.json', runner\.temp\) \|\| '' \}\}\n/u);
  });
});
