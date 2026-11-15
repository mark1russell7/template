// The CodeQL configuration of the action security-scan (action.yml): the query of the suppression comments of each
// language. The step "Languages" starts this script after it keeps the languages that have files.
//
// CodeQL reads a comment "codeql[<rule id>]" on the line above an alert only when the query AlertSuppression.ql of its
// language runs. Then the SARIF result of the alert has "suppressions", and the step "Fail on new alerts" skips it.
// Without this query, a comment changes nothing (seen on mark1russell7/netdiag#7). codeqlConfig() has no I/O, so the
// tests call it directly (scripts/workflows/security-scan.test.ts). main() reads the environment of the step.
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The CodeQL language of the query pack of each name of the input codeql-languages, for the languages that have the
 * query AlertSuppression.ql. The names "actions" and "rust" have no such query.
 */
export const SUPPRESSION_LANGUAGES: Readonly<Record<string, string>> = {
  "javascript-typescript": "javascript",
  javascript: "javascript",
  typescript: "javascript",
  python: "python",
  go: "go",
  ruby: "ruby",
  "java-kotlin": "java",
  java: "java",
  kotlin: "java",
  csharp: "csharp",
  "c-cpp": "cpp",
  c: "cpp",
  cpp: "cpp",
  swift: "swift",
};

/**
 * This function gives the CodeQL configuration of the languages (names with commas, as the input codeql-languages):
 * the query AlertSuppression.ql of each language that has one, as JSON on one line. JSON is also YAML. The function
 * gives an empty text when no language has the query. Then the init of CodeQL uses its default configuration.
 */
export function codeqlConfig(languages: string): string {
  const packs: Record<string, string[]> = {};
  for (const name of languages.split(",")) {
    const language = SUPPRESSION_LANGUAGES[name.trim()];
    if (language !== undefined) packs[language] = [`codeql/${language}-queries:AlertSuppression.ql`];
  }
  return Object.keys(packs).length === 0 ? "" : JSON.stringify({ packs });
}

/** This function writes the output "config" of the step from the environment variable KEPT, and gives the exit code. */
export function main(env: NodeJS.ProcessEnv = process.env): number {
  const config = codeqlConfig(env["KEPT"] ?? "");
  const output = env["GITHUB_OUTPUT"];
  if (output) appendFileSync(output, `config=${config}\n`);
  const summary = env["GITHUB_STEP_SUMMARY"];
  const languages = Object.keys((JSON.parse(config || "{}") as { packs?: Record<string, unknown> }).packs ?? {});
  if (summary) appendFileSync(summary, `CodeQL suppression comments: ${languages.join(",") || "none"}\n`);
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
