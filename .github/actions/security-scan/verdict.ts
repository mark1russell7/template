// The verdict of the action security-scan (action.yml): its last step. Each scan runs also when an earlier scan
// failed, so this step tells which scans failed. evaluate() has the rules and no I/O, so the tests call it
// directly (scripts/workflows/security-scan.test.ts). main() reads the environment of the step.
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The scans of the action, in the order of the job. The id of each step of a scan starts with its name and "_". */
export const SCANS = ["dependency-review", "osv-scanner", "codeql"] as const;

/** A scan of the action. */
export type Scan = (typeof SCANS)[number];

/** A step in the `steps` context of the action. A skipped step has the conclusion "skipped". */
export interface StepResult {
  readonly outcome?: string | undefined;
  readonly conclusion?: string | undefined;
}

/** The input of evaluate(). */
export interface VerdictInput {
  /** The `steps` context of the action, as `toJSON(steps)`. */
  readonly steps: Readonly<Record<string, StepResult>>;
  /** The scans that the inputs and the event start. Such a scan must run and pass. */
  readonly expected: Readonly<Record<Scan, boolean>>;
}

/** The result of the checkout or of a scan. "off" is a scan that the inputs or the event do not start. */
export interface Row {
  readonly name: Scan | "checkout";
  readonly state: "pass" | "fail" | "off";
  readonly reason: string;
}

/** The output of evaluate(). */
export interface Verdict {
  readonly rows: readonly Row[];
  /** The names of the failed rows, in the order of the job. */
  readonly failed: readonly string[];
}

/** The result of a step: its conclusion (after continue-on-error), or its outcome. A missing step did not run. */
const resultOf = (step: StepResult | undefined): string => step?.conclusion ?? step?.outcome ?? "skipped";

/** A result that fails the scan of the step. */
const BAD: ReadonlySet<string> = new Set(["failure", "cancelled"]);

/** This function gives the verdict of the checkout and of each scan. */
export function evaluate({ steps, expected }: VerdictInput): Verdict {
  const rows: Row[] = [];
  const checkout = resultOf(steps["checkout"]);
  rows.push(checkout === "success" ? { name: "checkout", state: "pass", reason: "success" } : { name: "checkout", state: "fail", reason: `the checkout ended with ${checkout}` });
  for (const scan of SCANS) {
    const own = Object.entries(steps).filter(([id]) => id.startsWith(`${scan}_`));
    const bad = own.filter(([, step]) => BAD.has(resultOf(step)));
    const ran = own.some(([, step]) => resultOf(step) === "success");
    if (bad.length > 0) {
      const list = bad.map(([id, step]) => `${id} (${resultOf(step)})`).join(", ");
      rows.push({ name: scan, state: "fail", reason: `the steps ${list} did not pass` });
    } else if (ran) {
      rows.push({ name: scan, state: "pass", reason: `passed (steps that ran: ${String(own.filter(([, step]) => resultOf(step) === "success").length)})` });
    } else if (expected[scan]) {
      rows.push({ name: scan, state: "fail", reason: "the inputs start the scan, but no step of it ran" });
    } else {
      rows.push({ name: scan, state: "off", reason: "the inputs or the event do not start it" });
    }
  }
  return { rows, failed: rows.filter((row) => row.state === "fail").map((row) => row.name) };
}

/** This function reads the environment of the step, prints the verdict, and gives the exit code. */
export function main(env: NodeJS.ProcessEnv = process.env): number {
  let steps: Record<string, StepResult>;
  try {
    steps = JSON.parse(env["STEPS"] ?? "") as Record<string, StepResult>;
  } catch {
    console.log("::error::STEPS is not the JSON of the steps context.");
    return 1;
  }
  const on = (name: string): boolean => env[name] === "true";
  const verdict = evaluate({ steps, expected: { "dependency-review": on("DEPENDENCY_REVIEW"), "osv-scanner": on("OSV_SCANNER"), codeql: on("CODEQL") } });
  const summary = ["### Security scans", "", "| Scan | Result | Reason |", "|---|---|---|"];
  for (const row of verdict.rows) {
    console.log(`${row.state.toUpperCase().padEnd(4)} ${row.name}: ${row.reason}`);
    summary.push(`| ${row.name} | ${row.state} | ${row.reason} |`);
  }
  for (const row of verdict.rows) if (row.state === "fail") console.log(`::error::Security scan ${row.name} failed: ${row.reason}. The log of that step tells why.`);
  const stepSummary = env["GITHUB_STEP_SUMMARY"];
  if (stepSummary) appendFileSync(stepSummary, `${summary.join("\n")}\n`);
  return verdict.failed.length > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main();
