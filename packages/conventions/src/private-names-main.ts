/**
 * The entry of the bundle `private-names.mjs` of the shared actions (`tsdown.actions.config.ts`). The step "Private names
 * of the change" of `reusable-ci.yml` starts it before the install. Thus the step that has the private name list runs
 * no code of the repository or of its dependencies. The bundle takes `--base <ref>` and, as an option, `--head <ref>`, as
 * `conventions pre-push` does in CI.
 */
import { parsePrePushArgs, runPrePushArgs } from "./pre-push.ts";

const args = parsePrePushArgs(process.argv.slice(2));
const stderr = (text: string): void => {
  process.stderr.write(text);
};
if (args?.base === undefined) {
  stderr("private-names.mjs: The bundle takes --base <ref> and, as an option, --head <ref>.\n");
  process.exitCode = 2;
} else {
  process.exitCode = runPrePushArgs(args, { cwd: process.cwd(), env: process.env, stderr });
}
