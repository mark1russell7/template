/**
 * The list of the rules, in the order of the output.
 */
import type { Rule } from "../rule.ts";
import { cuePreset } from "./cue-preset.ts";
import { noBuildOutput } from "./no-build-output.ts";
import { noLocalPaths } from "./no-local-paths.ts";
import { pinnedGitDeps } from "./pinned-git-deps.ts";
import { releaseFiles } from "./release-files.ts";
import { requiredScripts } from "./required-scripts.ts";
import { sourceMain } from "./source-main.ts";
import { testsRequired } from "./tests-required.ts";
import { tsconfigTest } from "./tsconfig-test.ts";
import { typedFiles } from "./typed-files.ts";
import { typedScripts } from "./typed-scripts.ts";
import { workspaceProtocol } from "./workspace-protocol.ts";

/** Each rule of the check. */
export const RULES: readonly Rule[] = [
  pinnedGitDeps,
  workspaceProtocol,
  sourceMain,
  tsconfigTest,
  cuePreset,
  requiredScripts,
  noBuildOutput,
  noLocalPaths,
  releaseFiles,
  typedScripts,
  typedFiles,
  testsRequired,
];

export { cuePreset, noBuildOutput, noLocalPaths, pinnedGitDeps, releaseFiles, requiredScripts, sourceMain, testsRequired, tsconfigTest, typedFiles, typedScripts, workspaceProtocol };
