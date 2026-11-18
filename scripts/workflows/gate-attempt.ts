// The verdict of one attempt of a gate job of reusable-gate.yml (CI.md, "A gate with a second attempt").
//
// The gate command writes one verdict for each gate into the file GATE_VERDICT_FILE: pass, block or no-read. This
// script reads the file and the exit code of the command. It writes the verdict of the attempt to GITHUB_OUTPUT, a line
// to the summary and, for each verdict that is not a pass, an annotation. Its exit code fails the job on a block, on an
// error and on a no read of the last attempt. A no read of an earlier attempt passes the job with a warning, because
// the next attempt runs on a fresh runner. The script imports only the built-in modules of Node.js and
// @mark1russell7/text, so Node.js runs it with its type stripping.

import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { escapeMarkdown, escapeWorkflowData, escapeWorkflowProperty } from "@mark1russell7/text";

/** The words of a gate in the verdict file. */
export const GATE_WORDS = ["pass", "block", "no-read"] as const;

/** The verdict of one gate. */
export type GateWord = (typeof GATE_WORDS)[number];

/** The verdict of an attempt. The word `error` is an attempt with no valid verdict, for example a crash of the command. */
export type Verdict = GateWord | "error";

/** The read of one attempt: its verdict, the reason and the count of each word of the file. */
export interface AttemptRead {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly counts: Readonly<Record<GateWord, number>>;
}

/** The decision of one attempt for the job. */
export interface AttemptDecision {
  /** The exit code of the step: 0 passes the job, and 1 fails it. */
  readonly exitCode: 0 | 1;
  /** The annotation of the attempt, or undefined for a pass. */
  readonly annotation: string | undefined;
  /** The line of the step summary. */
  readonly summary: string;
}

const isWord = (line: string): line is GateWord => (GATE_WORDS as readonly string[]).includes(line);

/** This function gives the text of a line of the file for a reason, cut to 80 characters. */
const quoted = (line: string): string => JSON.stringify(line.length > 80 ? `${line.slice(0, 80)}...` : line);

/**
 * This function reads the verdict file of an attempt and the exit code of its command.
 * - A line that is not `pass`, `block` or `no-read` gives `error`. The function ignores empty lines.
 * - A file with no verdict gives `error`, so a command that does not write the file does not pass.
 * - A block decides first, then a no read. A command that exits with a code other than 0 can give a no read.
 * - Each gate passes, but the exit code is not 0: the function gives `error`, because the verdicts and the command disagree.
 */
export function readAttempt(text: string, exit: number): AttemptRead {
  const counts: Record<GateWord, number> = { pass: 0, block: 0, "no-read": 0 };
  const lines = text.split("\n").map((line) => line.replace(/\r$/u, "").trim());
  for (const [index, line] of lines.entries()) {
    if (line === "") continue;
    if (!isWord(line)) return { verdict: "error", reason: `the line ${index + 1} of the verdict file is ${quoted(line)}, not pass, block or no-read`, counts };
    counts[line] += 1;
  }
  const total = counts.pass + counts.block + counts["no-read"];
  const code = exit === 0 ? "" : `, and the command exited with ${exit}`;
  if (total === 0) return { verdict: "error", reason: `the command wrote no verdict (exit code ${exit})`, counts };
  if (counts.block > 0) return { verdict: "block", reason: `${counts.block} of ${total} gates block${code}`, counts };
  if (counts["no-read"] > 0) return { verdict: "no-read", reason: `${counts["no-read"]} of ${total} gates have no read${code}`, counts };
  if (exit !== 0) return { verdict: "error", reason: `each of ${total} gates passes, but the command exited with ${exit}`, counts };
  return { verdict: "pass", reason: `each of ${total} gates passes`, counts };
}

/**
 * This function decides the job of an attempt from its read.
 * - A pass passes the job with no annotation.
 * - A no read of an attempt before the last passes the job with a warning, because the next attempt runs.
 * - A no read of the last attempt, a block and an error fail the job with an error.
 */
export function decideAttempt(read: AttemptRead, attempt: number, attempts: number): AttemptDecision {
  const at = `attempt ${attempt} of ${attempts}`;
  const summary = `Gate, ${at}: **${read.verdict}**. ${escapeMarkdown(read.reason)}.`;
  if (read.verdict === "pass") return { exitCode: 0, annotation: undefined, summary };
  const next = read.verdict === "no-read" && attempt < attempts;
  const text =
    read.verdict === "no-read"
      ? `No read: ${read.reason}. ${next ? `Attempt ${attempt + 1} runs on a fresh runner.` : `This was the last of ${attempts} attempts.`} A no read is not a pass.`
      : read.verdict === "block"
        ? `Block: ${read.reason}.`
        : `Error: ${read.reason}.`;
  const title = escapeWorkflowProperty(`Gate ${at}: ${read.verdict}`);
  return { exitCode: next ? 0 : 1, annotation: `::${next ? "warning" : "error"} title=${title}::${escapeWorkflowData(text)}`, summary };
}

/** This function gives a whole number of an environment variable, or undefined when the text is not one. */
function whole(text: string | undefined): number | undefined {
  return text !== undefined && /^\d{1,9}$/u.test(text) ? Number(text) : undefined;
}

/** This function reads the verdict file. A missing file is an empty file, because the command did not write it. */
function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** The counts of an attempt with no read of its file. */
const NO_COUNTS: Readonly<Record<GateWord, number>> = { pass: 0, block: 0, "no-read": 0 };

/**
 * This function operates the step. It reads `GATE_VERDICT_FILE`, `GATE_EXIT`, `GATE_ATTEMPT` and `GATE_ATTEMPTS`, writes
 * the verdict to `GITHUB_OUTPUT` and the line to `GITHUB_STEP_SUMMARY`, and gives the exit code of the step. A bad
 * input gives the verdict `error`.
 */
export function main(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = console.log): number {
  const attempt = whole(env["GATE_ATTEMPT"]);
  const attempts = whole(env["GATE_ATTEMPTS"]);
  const exit = whole(env["GATE_EXIT"]);
  const file = env["GATE_VERDICT_FILE"] ?? "";
  const ok = attempts !== undefined && attempt !== undefined && attempt >= 1 && attempt <= attempts;
  const read: AttemptRead = !ok
    ? { verdict: "error", reason: `GATE_ATTEMPT is "${env["GATE_ATTEMPT"] ?? ""}" and GATE_ATTEMPTS is "${env["GATE_ATTEMPTS"] ?? ""}", not an attempt from 1 to the count of attempts`, counts: NO_COUNTS }
    : exit === undefined
      ? { verdict: "error", reason: `GATE_EXIT is "${env["GATE_EXIT"] ?? ""}", not the exit code of the command`, counts: NO_COUNTS }
      : file === ""
        ? { verdict: "error", reason: "GATE_VERDICT_FILE is empty", counts: NO_COUNTS }
        : readAttempt(readFile(file), exit);
  const decision = decideAttempt(read, ok ? attempt : 1, ok ? attempts : 1);
  log(`Gate, attempt ${ok ? attempt : "?"} of ${ok ? attempts : "?"}: ${read.verdict}. ${read.reason}.`);
  if (decision.annotation !== undefined) log(decision.annotation);
  const output = env["GITHUB_OUTPUT"];
  if (output !== undefined && output !== "") appendFileSync(output, `verdict=${read.verdict}\n`);
  const summary = env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") appendFileSync(summary, `${decision.summary}\n`);
  return decision.exitCode;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
