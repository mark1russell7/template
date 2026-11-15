// The choice of the scans of the action security-scan (action.yml): its first step. The inputs dependency-review,
// codeql and osv-upload are "true", "false" or "auto". "auto" runs in a public repository and skips in a private one,
// because these parts need GitHub Advanced Security there. choose() has the rules and no I/O, so the tests call it
// directly (scripts/workflows/security-scan.test.ts). main() reads the environment of the step.
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Fetch } from "./new-alerts.ts";

/** The inputs of the action that have the value "auto". */
export const CHOICES = ["dependency-review", "codeql", "osv-upload"] as const;

/** An input of the action that has the value "auto". */
export type ChoiceName = (typeof CHOICES)[number];

/** The input of choose(). */
export interface ChoiceInput {
  /** The value of each input, as the caller gives it. */
  readonly inputs: Readonly<Record<ChoiceName, string>>;
  /** True for a private repository. Undefined when no input is "auto", because then the visibility has no effect. */
  readonly isPrivate: boolean | undefined;
  /** The event of the run. The dependency review starts only on a pull request. */
  readonly event: string;
}

/** The output of choose(). */
export interface Choice {
  /** For each input: "true" when its part runs. */
  readonly outputs: Readonly<Record<ChoiceName, "true" | "false">>;
  /** The scans that "auto" skips in this private repository, and that the event starts. The verdict names them. */
  readonly skipped: readonly ("dependency-review" | "codeql")[];
  /** An error for each input with a value that is not "true", "false" or "auto". */
  readonly errors: readonly string[];
}

/** This function tells if an input has the value "auto", so the step must know the visibility of the repository. */
export const needsVisibility = (inputs: Readonly<Record<ChoiceName, string>>): boolean => CHOICES.some((name) => inputs[name].trim() === "auto");

/** This function gives the parts that run, and the scans that "auto" skips. */
export function choose({ inputs, isPrivate, event }: ChoiceInput): Choice {
  const outputs: Record<ChoiceName, "true" | "false"> = { "dependency-review": "false", codeql: "false", "osv-upload": "false" };
  const errors: string[] = [];
  const off: ChoiceName[] = [];
  for (const name of CHOICES) {
    const value = inputs[name].trim();
    if (value === "true" || value === "false") {
      outputs[name] = value;
    } else if (value === "auto") {
      if (isPrivate === undefined) throw new Error(`The input ${name} is "auto", but the visibility of the repository is not known.`);
      outputs[name] = isPrivate ? "false" : "true";
      if (isPrivate) off.push(name);
    } else {
      errors.push(`The input ${name} is "${value}". Use "true", "false" or "auto".`);
    }
  }
  const skipped = off.filter((name): name is "dependency-review" | "codeql" => name === "codeql" || (name === "dependency-review" && event === "pull_request"));
  return { outputs, skipped, errors };
}

/**
 * This function gives the visibility of the repository. The payload of the event has it, but the payload of a schedule
 * has no repository. Then the function reads the API of the repository.
 */
export async function readPrivate(env: NodeJS.ProcessEnv, fetcher: Fetch): Promise<boolean> {
  const payload = env["PRIVATE"] ?? "";
  if (payload === "true" || payload === "false") return payload === "true";
  const url = `${env["GITHUB_API_URL"] ?? "https://api.github.com"}/repos/${env["GITHUB_REPOSITORY"] ?? ""}`;
  const response = await fetcher(url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${env["GH_TOKEN"] ?? ""}`, "x-github-api-version": "2022-11-28" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`the repository API gave HTTP ${String(response.status)}: ${text.slice(0, 300)}`);
  const value = (JSON.parse(text) as { private?: unknown }).private;
  if (typeof value !== "boolean") throw new Error("the repository API gave no field private");
  return value;
}

/** This function operates the step: it reads the environment, writes the outputs, and gives the exit code. */
export async function main(env: NodeJS.ProcessEnv = process.env, fetcher: Fetch = fetch): Promise<number> {
  const inputs: Record<ChoiceName, string> = { "dependency-review": env["DEPENDENCY_REVIEW"] ?? "", codeql: env["CODEQL"] ?? "", "osv-upload": env["OSV_UPLOAD"] ?? "" };
  let isPrivate: boolean | undefined;
  if (needsVisibility(inputs)) {
    try {
      isPrivate = await readPrivate(env, fetcher);
    } catch (error) {
      console.log(`::error::The step cannot read the visibility of the repository, so it cannot choose the scans of "auto": ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    console.log(`The repository is ${isPrivate ? "private" : "public"}.`);
  }
  const choice = choose({ inputs, isPrivate, event: env["EVENT"] ?? "" });
  for (const error of choice.errors) console.log(`::error::${error}`);
  if (choice.errors.length > 0) return 1;
  const lines = [...CHOICES.map((name) => `${name}=${choice.outputs[name]}`), `skipped=${choice.skipped.join(",")}`];
  for (const line of lines) console.log(line);
  const output = env["GITHUB_OUTPUT"];
  if (output) appendFileSync(output, `${lines.join("\n")}\n`);
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
