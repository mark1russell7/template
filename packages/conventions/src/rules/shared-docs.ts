/**
 * The rule `shared-docs`: each shared block of a document agrees with its lock, and each linked block points to its
 * home at a pinned commit.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import { cleanPath, type Break, type Rule } from "../rule.ts";

/** The answer for one URL: the text of the file, or the reason why there is no text. */
export type HomeAnswer = { readonly text: string } | { readonly error: string };

/** A function that downloads each URL, and gives the answer for each URL. */
export type HomeFetch = (urls: readonly string[]) => ReadonlyMap<string, HomeAnswer>;

/** The time in milliseconds that the rule waits for one home. A home that does not answer in this time is a break. */
export const HOME_TIMEOUT_MS = 30_000;

/** The script that `githubFetch` starts in a child process of Node, so that the rule stays synchronous. */
const FETCH_SCRIPT = `
const [timeout, ...urls] = process.argv.slice(1);
Promise.all(urls.map(async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(Number(timeout)) });
    if (!response.ok) return [url, { error: "HTTP " + response.status }];
    return [url, { text: await response.text() }];
  } catch (error) {
    return [url, { error: String(error && error.message ? error.message : error) }];
  }
})).then((entries) => process.stdout.write(JSON.stringify(Object.fromEntries(entries))));
`;

/** This function downloads each URL in one child process of Node. Each download stops after `HOME_TIMEOUT_MS`. */
export const githubFetch: HomeFetch = (urls) => {
  const fail = (error: string): ReadonlyMap<string, HomeAnswer> => new Map(urls.map((url) => [url, { error }]));
  if (urls.length === 0) return new Map();
  const result = spawnSync(process.execPath, ["-e", FETCH_SCRIPT, String(HOME_TIMEOUT_MS), ...urls], { encoding: "utf8", timeout: HOME_TIMEOUT_MS + 10_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error !== undefined || result.status !== 0) return fail(result.error?.message ?? `the download ended with exit code ${String(result.status)}`);
  try {
    const answers = JSON.parse(result.stdout) as Record<string, HomeAnswer>;
    return new Map(urls.map((url) => [url, answers[url] ?? { error: "no answer" }]));
  } catch {
    return fail("the download gave no JSON");
  }
};

/** This function gives the SHA-256 of the lines of a block: the lines with LF line ends, and a last LF. */
export const blockHash = (body: readonly string[]): string => createHash("sha256").update(`${body.join("\n")}\n`).digest("hex");

/** A block of a document: its lines without the two marker lines, and the line of its start marker (from 1). */
interface Block {
  readonly body: readonly string[];
  readonly line: number;
}

/** A problem in the markers of a document, with its line when the rule knows it. */
interface MarkerProblem {
  readonly line?: number;
  readonly message: string;
}

/**
 * This function reads the blocks of one kind (`shared` or `linked`) of a text. A block is the text between
 * `<!-- <kind>:<id> -->` and `<!-- /<kind>:<id> -->`, each alone on its line.
 */
export function blocksOf(text: string, kind: "shared" | "linked", problems: MarkerProblem[]): Map<string, Block> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = new Map<string, Block>();
  const start = new RegExp(`^<!-- ${kind}:([a-z0-9-]+) -->$`);
  const end = new RegExp(`^<!-- /${kind}:([a-z0-9-]+) -->$`);
  const loose = new RegExp(`^\\s*<!-- /?${kind}:`);
  let open: { id: string; line: number } | undefined;
  let body: string[] = [];
  lines.forEach((line, index) => {
    const s = start.exec(line);
    const e = end.exec(line);
    if (s) {
      if (open !== undefined) problems.push({ line: index + 1, message: `the ${kind} block "${s[1] ?? ""}" starts inside the block "${open.id}".` });
      open = { id: s[1] ?? "", line: index + 1 };
      body = [];
    } else if (e) {
      if (open === undefined || open.id !== e[1]) problems.push({ line: index + 1, message: `the end of "${e[1] ?? ""}" does not close the open block "${open?.id ?? "(none)"}".` });
      else if (blocks.has(open.id)) problems.push({ line: index + 1, message: `the ${kind} block "${open.id}" occurs two times.` });
      else blocks.set(open.id, { body, line: open.line });
      open = undefined;
    } else if (open !== undefined) {
      body.push(line);
    } else if (loose.test(line)) {
      problems.push({ line: index + 1, message: `a ${kind} marker must be alone on its line.` });
    }
  });
  if (open !== undefined) problems.push({ line: open.line, message: `the ${kind} block "${open.id}" has no end marker.` });
  return blocks;
}

/** A linked block in a lock: the home repository, the path of the file in it, the pinned commit and the SHA-256 of the block. */
interface LinkedEntry {
  readonly repo: string;
  readonly path: string;
  readonly commit: string;
  readonly sha256: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const linkOf = (l: LinkedEntry): string => `https://github.com/${l.repo}/blob/${l.commit}/${l.path}`;
const rawOf = (l: LinkedEntry): string => `https://raw.githubusercontent.com/${l.repo}/${l.commit}/${l.path}`;

/** This function tells if the rule downloads the homes, from the option `remote` and the environment. */
function downloads(remote: string, env: Readonly<Record<string, string | undefined>>): boolean {
  if (remote === "always") return true;
  if (remote === "never") return false;
  return env["CI"] === "true";
}

/** This function makes the rule with the download function `fetchHomes`. The tests give a fake function. */
export function sharedDocsRule(fetchHomes: HomeFetch = githubFetch): Rule {
  return {
    id: "shared-docs",
    title: "Each shared block of a document agrees with its lock file, and each linked block has the link to its home at the pinned commit, with the hash of the home block.",
    reason:
      "Three repositories kept copies of the same blocks of docs/PROMOTION.md, each with its own copy of a check script. A change in one copy did not get to the others: on 2026-11-03 the block win-test of three repositories had a hash that the home in rigor did not have. A linked block keeps one copy, in its home, and pins the commit, so a change of the home is a deliberate update of the lock.",
    fix: 'Make the block agree with the lock, or update the lock in each repository that keeps a copy. For a block with a home in another repository, remove the copy, write `<!-- linked:<id> -->` with the link https://github.com/<repo>/blob/<commit>/<path>, and give `{repo, path, commit, sha256}` in the field "linked" of the lock.',
    sources: [
      { repo: "layout-contract", rule: "check-shared", doc: "scripts/check-shared.mjs (#155, the linked form of a shared block)" },
      { repo: "packing", rule: "check-shared", doc: "scripts/check-shared.mjs (the same script)" },
      { repo: "highways", rule: "check-shared", doc: "scripts/check-shared.mjs (the same script)" },
    ],
    options: {
      locks: { type: "strings", default: [], description: "The lock files to check. With no value, the rule checks each tracked file with the name `shared.lock.json`." },
      remote: { type: "string", default: "ci", description: 'When the rule downloads the home of each linked block and compares its hash: "ci" (only when the variable CI is "true"), "always" or "never".' },
    },
    check(context, options) {
      const named = options["locks"] as readonly string[];
      let locks: readonly string[];
      if (named.length > 0) {
        locks = named.map(cleanPath);
      } else {
        const files = context.gitFiles();
        if (files === undefined) return { skipped: "the root is not in a git repository" };
        locks = files.filter((file) => file === "shared.lock.json" || file.endsWith("/shared.lock.json")).sort(byCode);
      }
      if (locks.length === 0) return { skipped: "the repository has no file shared.lock.json" };
      const breaks: Break[] = [];
      const remote: { lock: string; id: string; entry: LinkedEntry }[] = [];
      for (const lockPath of locks) {
        if (!existsSync(join(context.root, lockPath))) {
          breaks.push({ file: lockPath, message: `the option locks names ${lockPath}, and the file does not exist.` });
          continue;
        }
        let lockFile: unknown;
        try {
          lockFile = JSON.parse(readFileSync(join(context.root, lockPath), "utf8"));
        } catch (error) {
          breaks.push({ file: lockPath, message: `${lockPath} is not JSON: ${error instanceof Error ? error.message : String(error)}` });
          continue;
        }
        if (!isRecord(lockFile)) {
          breaks.push({ file: lockPath, message: `${lockPath} is not a JSON object.` });
          continue;
        }
        if (typeof lockFile["file"] !== "string") {
          breaks.push({ file: lockPath, message: `${lockPath} has no field "file": the document of its blocks.` });
          continue;
        }
        if (!isRecord(lockFile["blocks"]) && !isRecord(lockFile["linked"])) {
          breaks.push({ file: lockPath, message: `${lockPath} has no field "blocks" and no field "linked", so it locks nothing.` });
          continue;
        }
        const lock = isRecord(lockFile["blocks"]) ? lockFile["blocks"] : {};
        const links = isRecord(lockFile["linked"]) ? lockFile["linked"] : {};
        const doc = cleanPath(lockFile["file"]);
        if (!existsSync(join(context.root, doc))) {
          breaks.push({ file: lockPath, message: `${lockPath} locks the blocks of ${doc}, and the file does not exist.` });
          continue;
        }
        const problems: MarkerProblem[] = [];
        const text = readFileSync(join(context.root, doc), "utf8");
        const shared = blocksOf(text, "shared", problems);
        const linked = blocksOf(text, "linked", problems);
        for (const p of problems) breaks.push({ file: doc, ...(p.line !== undefined ? { line: p.line } : {}), message: p.message });

        for (const [id, hash] of Object.entries(lock).sort(([a], [b]) => byCode(a, b))) {
          const block = shared.get(id);
          if (block === undefined) breaks.push({ file: doc, message: `the shared block "${id}" of ${lockPath} is missing in ${doc}.` });
          else if (blockHash(block.body) !== hash) breaks.push({ file: doc, line: block.line, message: `the shared block "${id}" differs from ${lockPath}: its hash is ${blockHash(block.body)}.` });
        }
        for (const [id, block] of shared) if (!(id in lock)) breaks.push({ file: doc, line: block.line, message: `the shared block "${id}" is not in ${lockPath}.` });

        for (const [id, value] of Object.entries(links).sort(([a], [b]) => byCode(a, b))) {
          if (!isRecord(value)) {
            breaks.push({ file: lockPath, message: `the linked block "${id}" of ${lockPath} is not an object {repo, path, commit, sha256}.` });
            continue;
          }
          const entry: LinkedEntry = { repo: String(value["repo"] ?? ""), path: String(value["path"] ?? ""), commit: String(value["commit"] ?? ""), sha256: String(value["sha256"] ?? "") };
          const before = breaks.length;
          if (!/^[\w.-]+\/[\w.-]+$/.test(entry.repo)) breaks.push({ file: lockPath, message: `the linked block "${id}" needs a repository "<owner>/<name>", not "${entry.repo}".` });
          if (entry.path === "") breaks.push({ file: lockPath, message: `the linked block "${id}" needs the path of its file in the home.` });
          if (!/^[0-9a-f]{40}$/.test(entry.commit)) breaks.push({ file: lockPath, message: `the linked block "${id}" needs a full commit of 40 hex digits, not "${entry.commit}".` });
          if (!/^[0-9a-f]{64}$/.test(entry.sha256)) breaks.push({ file: lockPath, message: `the linked block "${id}" needs a SHA-256 of 64 hex digits.` });
          const copy = shared.get(id);
          if (copy !== undefined) breaks.push({ file: doc, line: copy.line, message: `the linked block "${id}" also has a copy in ${doc}. Remove the copy.` });
          const block = linked.get(id);
          if (block === undefined) breaks.push({ file: doc, message: `the linked block "${id}" of ${lockPath} has no "<!-- linked:${id} -->" block in ${doc}.` });
          else if (!block.body.join("\n").includes(linkOf(entry))) breaks.push({ file: doc, line: block.line, message: `the linked block "${id}" does not contain the link ${linkOf(entry)}.` });
          if (breaks.length === before) remote.push({ lock: lockPath, id, entry });
        }
        for (const [id, block] of linked) if (!(id in links)) breaks.push({ file: doc, line: block.line, message: `the linked block "${id}" is not in the field "linked" of ${lockPath}.` });
      }

      if (remote.length > 0 && downloads(String(options["remote"]), context.env)) {
        const answers = fetchHomes([...new Set(remote.map(({ entry }) => rawOf(entry)))]);
        for (const { lock, id, entry } of remote) {
          const url = rawOf(entry);
          const answer = answers.get(url) ?? { error: "no answer" };
          // A gate fails closed: a home that does not answer is a break, not a skip.
          if ("error" in answer) {
            breaks.push({ file: lock, message: `the home of the linked block "${id}" did not answer at ${url}: ${answer.error}.` });
            continue;
          }
          const problems: MarkerProblem[] = [];
          const home = blocksOf(answer.text, "shared", problems).get(id);
          if (home === undefined) breaks.push({ file: lock, message: `the home ${url} has no shared block "${id}".` });
          else if (blockHash(home.body) !== entry.sha256) breaks.push({ file: lock, message: `the linked block "${id}" at ${url} has the hash ${blockHash(home.body)}, not the hash of ${lock}.` });
        }
      }
      return breaks;
    },
  };
}

export const sharedDocs: Rule = sharedDocsRule();
