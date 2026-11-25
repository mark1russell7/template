// The steps of the job "version" of release.yml around the Changesets action (RELEASING.md, "Changesets").
//
//   node scripts/release/version-pr.ts head          Writes head=true to GITHUB_OUTPUT when the commit of the run
//                                                    (GITHUB_SHA) is the head of main, else head=false.
//   node scripts/release/version-pr.ts note <number> Adds the steps for a person to the text of the version pull request.
//
// head: the release runs of two commits do not wait for each other. When a run of an older commit opened the version
// pull request after the run of a newer commit, the pull request would lose the newer changesets. Thus only the run of
// the head of main changes the pull request. A newer commit of main has its own run.
//
// note: the Changesets action opens the pull request with the token of the workflow. GitHub starts no workflow for an
// event that this token makes: no checks of the pull request, and no release after a merge with this token. Thus the
// text of the pull request tells a person what to do. The action writes the text again at each update, so the step
// adds the steps again after each update.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareWithMain, errorText, type Gh } from "./dispatch.ts";

/** The first line of the steps. The step finds the steps in the text by this line. */
export const NOTE_MARK = "<!-- release-version-note -->";

/** The steps for a person, at the top of the text of the version pull request. */
export const NOTE: string = [
  NOTE_MARK,
  "> [!IMPORTANT]",
  "> The workflow token opened or updated this pull request, so GitHub started no checks for it. Before the merge, do these steps:",
  ">",
  "> 1. Close this pull request and open it again. Then GitHub starts its checks. Do this again after each update of the pull request.",
  "> 2. When the checks pass, merge the pull request with your own account. A merge with the token of a workflow starts no release.",
  ">",
  "> The merge starts `release.yml`. That run publishes the new versions to npm, with provenance.",
].join("\n");

/** This function gives the text of the pull request with the steps at the top. A text that has the steps stays the same. */
export function withNote(body: string): string {
  if (body.includes(NOTE_MARK)) return body;
  return body.trim() === "" ? `${NOTE}\n` : `${NOTE}\n\n${body}`;
}

/** The result of the head check: the status of the compare API and the decision. */
export interface HeadCheck {
  readonly head: boolean;
  readonly line: string;
}

/**
 * This function tells if the commit is the head of main. "identical" is the head, and "behind" is an older commit of
 * main: a newer run changes the pull request. Each other status is an error, because the build job let only a commit of
 * main through.
 */
export function headCheck(repository: string, sha: string, run?: Gh): HeadCheck {
  const status = compareWithMain(repository, sha, run);
  if (status === "identical") return { head: true, line: `The commit ${sha} is the head of main. The run opens or updates the version pull request.` };
  if (status === "behind") {
    return {
      head: false,
      line:
        `::notice title=Version pull request::main has commits after ${sha}. The run of the newest commit opens or updates the version pull request. ` +
        "When no run of a newer commit starts, start release.yml by hand on main.",
    };
  }
  throw new Error(`The commit ${sha} is not on main (status: ${status}). The run does not change the version pull request.`);
}

/** This function starts gh and gives its output text. Its error has the error text of gh. */
function gh(args: readonly string[]): string {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    throw new Error(String(stderr ?? "").trim() || errorText(error));
  }
}

/** This function adds the steps to the text of a pull request on GitHub. It gives true when it changed the text. */
export function addNote(repository: string, number: string, run: Gh = gh): boolean {
  const body = run(["pr", "view", number, "--repo", repository, "--json", "body", "--jq", ".body"]).replace(/\n$/u, "");
  const next = withNote(body);
  if (next === body) return false;
  const folder = mkdtempSync(join(tmpdir(), "version-pr-"));
  try {
    const file = join(folder, "body.md");
    writeFileSync(file, next);
    run(["pr", "edit", number, "--repo", repository, "--body-file", file]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return true;
}

/** This function starts one command of the script. It gives the exit code. */
export function main(args: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env, run: Gh = gh): number {
  const [command, number] = args;
  const repository = env["GITHUB_REPOSITORY"] ?? "";
  try {
    if (command === "head") {
      const result = headCheck(repository, env["GITHUB_SHA"] ?? "", run);
      process.stdout.write(`${result.line}\n`);
      const output = env["GITHUB_OUTPUT"];
      if (output) appendFileSync(output, `head=${String(result.head)}\n`);
      return 0;
    }
    if (command === "note" && number !== undefined && /^[1-9][0-9]*$/u.test(number)) {
      const changed = addNote(repository, number, run);
      process.stdout.write(changed ? `The text of pull request #${number} has the steps for a person now.\n` : `The text of pull request #${number} has the steps.\n`);
      return 0;
    }
  } catch (error) {
    process.stdout.write(`::error title=Version pull request::${errorText(error)}\n`);
    return 1;
  }
  process.stderr.write("usage: node scripts/release/version-pr.ts head | note <number>\n");
  return 2;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
