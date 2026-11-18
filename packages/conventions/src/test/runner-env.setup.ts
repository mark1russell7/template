// A setup file of vitest: the tests read no variable of the CI runner. A rule reads `GITHUB_EVENT_PATH`,
// `GITHUB_EVENT_NAME` and `GITHUB_REPOSITORY` when a test gives no environment. Then a CI run reads the event of the
// real pull request, and its results and its git starts differ from a local run. A test that needs a variable gives it
// in the options of the check, or sets it with `vi.stubEnv`.
for (const name of Object.keys(process.env)) {
  if (name === "CI" || name.startsWith("GITHUB_") || name.startsWith("RUNNER_")) delete process.env[name];
}
