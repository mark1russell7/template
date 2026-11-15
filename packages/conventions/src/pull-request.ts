/**
 * The pull request of a run: its title, its body and its number of commits. On a pull request, the event file of GitHub
 * Actions (GITHUB_EVENT_PATH) has it. A run that `workflow_dispatch` starts has no pull request in its event file. For
 * such a run, the shared CI of the template finds the open pull request of the branch and writes it to a JSON file. The
 * variable CONVENTIONS_PULL_REQUEST names that file, and the variable CONVENTIONS_BASE gives the tip of its base branch.
 */
import { existsSync, readFileSync } from "node:fs";

/** The variable that names a JSON file with the pull request of the run. The file has priority over the event file. */
export const PULL_REQUEST_VARIABLE = "CONVENTIONS_PULL_REQUEST";

/** The facts of a pull request that the rules read. A fact that the source does not give as the correct type is absent. */
export interface PullRequestFacts {
  readonly title?: string;
  readonly body?: string;
  readonly commits?: number;
}

/** This function gives the JSON value of a file, or undefined when the file does not exist or does not parse. */
function readJson(file: string | undefined): unknown {
  if (file === undefined || file === "" || !existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** This function gives the facts of a pull request object, or undefined when the value is not an object. */
function factsOf(value: unknown): PullRequestFacts | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { title, body, commits } = value as { title?: unknown; body?: unknown; commits?: unknown };
  return {
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof body === "string" ? { body } : {}),
    ...(typeof commits === "number" ? { commits } : {}),
  };
}

/** This function tells if the run names a file of its pull request in CONVENTIONS_PULL_REQUEST. */
export function namesPullRequestFile(env: Readonly<Record<string, string | undefined>>): boolean {
  const file = env[PULL_REQUEST_VARIABLE];
  return file !== undefined && file !== "";
}

/**
 * This function gives the pull request of the run. When CONVENTIONS_PULL_REQUEST names a file, the function reads only
 * that file. Else it reads the field `pull_request` of the event file. With no pull request, it gives undefined.
 */
export function pullRequestOfRun(env: Readonly<Record<string, string | undefined>>): PullRequestFacts | undefined {
  if (namesPullRequestFile(env)) return factsOf(readJson(env[PULL_REQUEST_VARIABLE]));
  const event = readJson(env["GITHUB_EVENT_PATH"]);
  return factsOf(typeof event === "object" && event !== null ? (event as { pull_request?: unknown }).pull_request : undefined);
}
